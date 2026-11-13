//! Small path tracer (`trace`): fixed scene, fixed camera, image width `size`.
//!
//! Reference (mirrored in tests). All arithmetic is plain IEEE f64, one
//! operation at a time, left to right as written, no FMA. sqrt is the
//! correctly rounded IEEE square root (= JS Math.sqrt).
//!
//! Vectors are (x, y, z). dot(a, b) = a.x*b.x + a.y*b.y + a.z*b.z (left to
//! right). norm(v): l = sqrt(dot(v, v)); (v.x / l, v.y / l, v.z / l).
//! v * s and a * b (component-wise) and a + b, a - b are per component.
//!
//! Scene (y is up):
//!   spheres, in this order: (center, radius, albedo, mirror)
//!     0: (0, 1, 3),       1.0,  (0.8, 0.3, 0.3), diffuse
//!     1: (-2.2, 0.8, 4),  0.8,  (0.3, 0.8, 0.3), diffuse
//!     2: (2.1, 1, 3.5),   1.0,  (0.9, 0.9, 0.9), mirror
//!     3: (0.6, 0.35, 1.6), 0.35, (0.3, 0.4, 0.9), diffuse
//!   ground plane y = 0, albedo (0.6, 0.6, 0.6), diffuse
//!   sky(d): t = 0.5 * (d.y + 1.0); per channel c in (0.5, 0.7, 1.0):
//!           (1.0 - t) + t * c
//! Constants: SPP = 4 samples per pixel, DEPTH = 4 bounces, EPS = 1e-4.
//!
//! prepare(seed, size): W = size, H = size * 3 / 4; size must be a nonzero
//! multiple of 4, else return 2. Allocates nothing (calls arena::reset()).
//!
//! run(): acc = checksum::START; for py in 0..H, for px in 0..W:
//!   idx = py * W + px (u32)
//!   h = seed ^ idx*0x9E3779B1; h ^= h >> 16; h = h*0x85EBCA6B; h ^= h >> 13
//!   (wrapping u32); rng = checksum::Rng::new(h)
//!   col = (0, 0, 0)
//!   SPP times:
//!     u = rng.next_f64(); v = rng.next_f64()
//!     sx = ((px as f64 + u) / W as f64) * 2.0 - 1.0
//!     sy = 1.0 - ((py as f64 + v) / H as f64) * 2.0
//!     col = col + radiance(o = (0, 1, -2), d = norm((sx, sy * 0.75, 1.5)), rng)
//!   for each channel c of col, in order r, g, b:
//!     m = c * 0.25
//!     q = 255 if m >= 1.0, else (sqrt(m) * 255.0) truncated to u32
//!     acc = fold(acc, q)
//!   return acc
//!
//! radiance(o, d, rng): thr = (1, 1, 1); DEPTH times:
//!   best = 1e30; hit = none
//!   for each sphere s in order:
//!     oc = o - s.center; b = dot(oc, d); c = dot(oc, oc) - s.r * s.r
//!     disc = b * b - c
//!     if disc > 0: q = sqrt(disc); t = -b - q; if t < EPS: t = -b + q
//!                  if t > EPS and t < best: best = t, hit = s
//!   if d.y < -1e-9: t = -o.y / d.y; if t > EPS and t < best: best = t, hit = plane
//!   if hit is none: return thr * sky(d)
//!   p = o + d * best
//!   plane: n = (0, 1, 0); sphere: n = ((p.x - cx) / r, (p.y - cy) / r, (p.z - cz) / r)
//!   thr = thr * albedo
//!   mirror: d = d - n * (2.0 * dot(d, n))
//!   diffuse: loop { x = 2.0 * rng.next_f64() - 1.0; y = (same); z = (same);
//!                   l2 = x*x + y*y + z*z; stop when l2 < 1.0 and l2 > 1e-6 }
//!            d = norm(n + (x, y, z))
//!   o = p
//! after DEPTH bounces without escaping: return (0, 0, 0)
//!
//! Work: W * H * SPP samples per run.

use crate::arena;
use crate::checksum::{Rng, START, fold};
use crate::global::Global;
use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};

const SPP: u32 = 4;
const DEPTH: u32 = 4;
const EPS: f64 = 1e-4;

#[derive(Clone, Copy)]
struct V(f64, f64, f64);

impl V {
    fn add(self, o: V) -> V {
        V(self.0 + o.0, self.1 + o.1, self.2 + o.2)
    }
    fn sub(self, o: V) -> V {
        V(self.0 - o.0, self.1 - o.1, self.2 - o.2)
    }
    fn mul(self, o: V) -> V {
        V(self.0 * o.0, self.1 * o.1, self.2 * o.2)
    }
    fn scale(self, s: f64) -> V {
        V(self.0 * s, self.1 * s, self.2 * s)
    }
    fn dot(self, o: V) -> f64 {
        self.0 * o.0 + self.1 * o.1 + self.2 * o.2
    }
    fn norm(self) -> V {
        let l = sqrt(self.dot(self));
        V(self.0 / l, self.1 / l, self.2 / l)
    }
}

#[inline(always)]
fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

struct Sphere {
    c: V,
    r: f64,
    albedo: V,
    mirror: bool,
}

const SPHERES: [Sphere; 4] = [
    Sphere {
        c: V(0.0, 1.0, 3.0),
        r: 1.0,
        albedo: V(0.8, 0.3, 0.3),
        mirror: false,
    },
    Sphere {
        c: V(-2.2, 0.8, 4.0),
        r: 0.8,
        albedo: V(0.3, 0.8, 0.3),
        mirror: false,
    },
    Sphere {
        c: V(2.1, 1.0, 3.5),
        r: 1.0,
        albedo: V(0.9, 0.9, 0.9),
        mirror: true,
    },
    Sphere {
        c: V(0.6, 0.35, 1.6),
        r: 0.35,
        albedo: V(0.3, 0.4, 0.9),
        mirror: false,
    },
];
const PLANE_ALBEDO: V = V(0.6, 0.6, 0.6);
const CAMERA: V = V(0.0, 1.0, -2.0);

fn sky(d: V) -> V {
    let t = 0.5 * (d.1 + 1.0);
    V(
        (1.0 - t) + t * 0.5,
        (1.0 - t) + t * 0.7,
        (1.0 - t) + t * 1.0,
    )
}

fn radiance(mut o: V, mut d: V, rng: &mut Rng) -> V {
    let mut thr = V(1.0, 1.0, 1.0);
    for _ in 0..DEPTH {
        let mut best = 1e30;
        // 0..4 = sphere index, 4 = plane, 5 = nothing.
        let mut hit = 5;
        for (i, s) in SPHERES.iter().enumerate() {
            let oc = o.sub(s.c);
            let b = oc.dot(d);
            let c = oc.dot(oc) - s.r * s.r;
            let disc = b * b - c;
            if disc > 0.0 {
                let q = sqrt(disc);
                let mut t = -b - q;
                if t < EPS {
                    t = -b + q;
                }
                if t > EPS && t < best {
                    best = t;
                    hit = i;
                }
            }
        }
        if d.1 < -1e-9 {
            let t = -o.1 / d.1;
            if t > EPS && t < best {
                best = t;
                hit = 4;
            }
        }
        if hit == 5 {
            return thr.mul(sky(d));
        }
        let p = o.add(d.scale(best));
        let (n, albedo, mirror) = if hit == 4 {
            (V(0.0, 1.0, 0.0), PLANE_ALBEDO, false)
        } else {
            let s = &SPHERES[hit];
            let n = V(
                (p.0 - s.c.0) / s.r,
                (p.1 - s.c.1) / s.r,
                (p.2 - s.c.2) / s.r,
            );
            (n, s.albedo, s.mirror)
        };
        thr = thr.mul(albedo);
        if mirror {
            d = d.sub(n.scale(2.0 * d.dot(n)));
        } else {
            let q = loop {
                let x = 2.0 * rng.next_f64() - 1.0;
                let y = 2.0 * rng.next_f64() - 1.0;
                let z = 2.0 * rng.next_f64() - 1.0;
                let l2 = x * x + y * y + z * z;
                if l2 < 1.0 && l2 > 1e-6 {
                    break V(x, y, z);
                }
            };
            d = n.add(q).norm();
        }
        o = p;
    }
    V(0.0, 0.0, 0.0)
}

struct State {
    seed: u32,
    w: u32,
}

static STATE: Global<State> = Global::new(State { seed: 0, w: 0 });

#[unsafe(no_mangle)]
pub extern "C" fn trace_prepare(seed: u32, size: u32) -> u32 {
    arena::reset();
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    s.seed = seed;
    s.w = 0;
    if size == 0 || !size.is_multiple_of(4) {
        return 2;
    }
    s.w = size;
    0
}

fn quantize(acc: u32, c: f64) -> u32 {
    let m = c * 0.25;
    let q = if m >= 1.0 {
        255
    } else {
        (sqrt(m) * 255.0) as u32
    };
    fold(acc, q)
}

#[unsafe(no_mangle)]
pub extern "C" fn trace_run() -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    let w = s.w;
    let h = w * 3 / 4;
    let (wf, hf) = (w as f64, h as f64);
    let mut acc = START;
    for py in 0..h {
        for px in 0..w {
            let idx = py * w + px;
            let mut hs = s.seed ^ idx.wrapping_mul(0x9E37_79B1);
            hs ^= hs >> 16;
            hs = hs.wrapping_mul(0x85EB_CA6B);
            hs ^= hs >> 13;
            let mut rng = Rng::new(hs);
            let mut col = V(0.0, 0.0, 0.0);
            for _ in 0..SPP {
                let u = rng.next_f64();
                let v = rng.next_f64();
                let sx = ((px as f64 + u) / wf) * 2.0 - 1.0;
                let sy = 1.0 - ((py as f64 + v) / hf) * 2.0;
                let d = V(sx, sy * 0.75, 1.5).norm();
                col = col.add(radiance(CAMERA, d, &mut rng));
            }
            acc = quantize(acc, col.0);
            acc = quantize(acc, col.1);
            acc = quantize(acc, col.2);
        }
    }
    acc
}
