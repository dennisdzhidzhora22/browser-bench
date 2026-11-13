//! N-body gravity (`nbody`): scalar f64, `N = 256` bodies, `size` time steps.
//!
//! Every float expression below is evaluated exactly as written, left to
//! right, one IEEE f64 rounding per operation, no fused multiply-add.
//! `sqrt` is IEEE correctly rounded (wasm `f64x2.sqrt`, lane 0), the same
//! as JS `Math.sqrt`. Constants: `G = 1`, `DT = 0.001`, `EPS2 = 0.01`.
//!
//! # Data (prepare, untimed)
//!
//! `rng = checksum::Rng::new(seed)`, `r() = rng.next_f64()`; for i in 0..N:
//! ```text
//! x[i] = r() * 2.0 - 1.0;  y[i] = r() * 2.0 - 1.0;  z[i] = r() * 2.0 - 1.0
//! vx[i] = (r() * 2.0 - 1.0) * 0.05;  vy[i] = (same);  vz[i] = (same)
//! m[i] = (r() + 0.5) / 256.0
//! ```
//! (the calls happen in exactly this order: x, y, z, vx, vy, vz, m per body).
//!
//! # Work (run, timed)
//!
//! Copy the pristine state, then repeat `size` times (symplectic Euler):
//! ```text
//! ax[*] = ay[*] = az[*] = 0.0
//! for i in 0..N:
//!     sx = sy = sz = 0.0
//!     for j in i+1..N:
//!         dx = x[j] - x[i];  dy = y[j] - y[i];  dz = z[j] - z[i]
//!         d2 = dx*dx + dy*dy + dz*dz + EPS2        // ((dx*dx + dy*dy) + dz*dz) + EPS2
//!         inv = 1.0 / (d2 * sqrt(d2))
//!         si = m[j] * inv;  sj = m[i] * inv
//!         sx = sx + dx*si;  sy = sy + dy*si;  sz = sz + dz*si
//!         ax[j] = ax[j] - dx*sj;  ay[j] = ay[j] - dy*sj;  az[j] = az[j] - dz*sj
//!     ax[i] = ax[i] + sx;  ay[i] = ay[i] + sy;  az[i] = az[i] + sz
//! for i in 0..N:
//!     vx[i] = vx[i] + ax[i]*DT;  (same for y, z)
//!     x[i] = x[i] + vx[i]*DT;    (same for y, z; uses the new velocity)
//! ```
//!
//! # Checksum
//!
//! Energy of the final state:
//! ```text
//! e = 0.0
//! for i in 0..N: e = e + 0.5 * m[i] * (vx*vx + vy*vy + vz*vz)   // ((0.5*m)*((vx*vx+vy*vy)+vz*vz))
//! for i in 0..N: for j in i+1..N:
//!     d2 as in the step;  e = e - (m[i] * m[j]) / sqrt(d2)
//! ```
//! then `acc = START`; for i in 0..N: `acc = f64_bits(acc, x[i])`, `y[i]`,
//! `z[i]`; then `acc = f64_bits(acc, e)`; then `acc = fold(acc, size)`.

use crate::arena;
use crate::checksum::{self, Rng};
use crate::global::Global;
use core::arch::wasm32::{f64x2_extract_lane, f64x2_splat, f64x2_sqrt};

/// Number of bodies.
pub const N: usize = 256;
const DT: f64 = 0.001;
const EPS2: f64 = 0.01;

/// Field blocks inside a state buffer of `FIELDS * N` f64.
const X: usize = 0;
const Y: usize = 1;
const Z: usize = 2;
const VX: usize = 3;
const VY: usize = 4;
const VZ: usize = 5;
const M: usize = 6;
const FIELDS: usize = 7;

struct State {
    steps: u32,
    src: Option<&'static mut [f64]>,
    work: Option<&'static mut [f64]>,
    acc: Option<&'static mut [f64]>,
}

static STATE: Global<State> = Global::new(State {
    steps: 0,
    src: None,
    work: None,
    acc: None,
});

fn field(s: &[f64], f: usize) -> &[f64] {
    &s[f * N..(f + 1) * N]
}

/// IEEE correctly rounded sqrt. `core::arch::wasm32::f64_sqrt` is still unstable
/// (`wasm_numeric_instr`), so use lane 0 of the stable simd128 `f64x2.sqrt`.
#[inline(always)]
fn sqrt(v: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(v)))
}

#[inline(always)]
fn dist2(dx: f64, dy: f64, dz: f64) -> f64 {
    dx * dx + dy * dy + dz * dz + EPS2
}

fn step(s: &mut [f64], acc: &mut [f64]) {
    let (pos, rest) = s.split_at_mut(VX * N);
    let (vel, m) = rest.split_at_mut(3 * N);
    let (x, yz) = pos.split_at_mut(N);
    let (y, z) = yz.split_at_mut(N);
    let (vx, vyz) = vel.split_at_mut(N);
    let (vy, vz) = vyz.split_at_mut(N);
    let (ax, ayz) = acc.split_at_mut(N);
    let (ay, az) = ayz.split_at_mut(N);
    let m = &m[..N];
    let (x, y, z) = (&mut x[..N], &mut y[..N], &mut z[..N]);
    let (vx, vy, vz) = (&mut vx[..N], &mut vy[..N], &mut vz[..N]);
    let (ax, ay, az) = (&mut ax[..N], &mut ay[..N], &mut az[..N]);

    ax.fill(0.0);
    ay.fill(0.0);
    az.fill(0.0);
    for i in 0..N {
        let (xi, yi, zi, mi) = (x[i], y[i], z[i], m[i]);
        let (mut sx, mut sy, mut sz) = (0.0, 0.0, 0.0);
        for j in i + 1..N {
            let dx = x[j] - xi;
            let dy = y[j] - yi;
            let dz = z[j] - zi;
            let d2 = dist2(dx, dy, dz);
            let inv = 1.0 / (d2 * sqrt(d2));
            let si = m[j] * inv;
            let sj = mi * inv;
            sx += dx * si;
            sy += dy * si;
            sz += dz * si;
            ax[j] -= dx * sj;
            ay[j] -= dy * sj;
            az[j] -= dz * sj;
        }
        ax[i] += sx;
        ay[i] += sy;
        az[i] += sz;
    }
    for i in 0..N {
        vx[i] += ax[i] * DT;
        vy[i] += ay[i] * DT;
        vz[i] += az[i] * DT;
        x[i] += vx[i] * DT;
        y[i] += vy[i] * DT;
        z[i] += vz[i] * DT;
    }
}

fn energy(s: &[f64]) -> f64 {
    let (x, y, z) = (field(s, X), field(s, Y), field(s, Z));
    let (vx, vy, vz, m) = (field(s, VX), field(s, VY), field(s, VZ), field(s, M));
    let mut e = 0.0;
    for i in 0..N {
        e += 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
    }
    for i in 0..N {
        for j in i + 1..N {
            let d2 = dist2(x[j] - x[i], y[j] - y[i], z[j] - z[i]);
            e -= (m[i] * m[j]) / sqrt(d2);
        }
    }
    e
}

#[unsafe(no_mangle)]
pub extern "C" fn nbody_prepare(seed: u32, size: u32) -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    let st = unsafe { STATE.get() };
    arena::reset();
    st.src = None;
    st.work = None;
    st.acc = None;
    st.steps = size;
    let (Some(src), Some(work), Some(acc)) = (
        arena::alloc_slice::<f64>(FIELDS * N),
        arena::alloc_slice::<f64>(FIELDS * N),
        arena::alloc_slice::<f64>(3 * N),
    ) else {
        return 1;
    };
    let mut rng = Rng::new(seed);
    for i in 0..N {
        for f in [X, Y, Z] {
            src[f * N + i] = rng.next_f64() * 2.0 - 1.0;
        }
        for f in [VX, VY, VZ] {
            src[f * N + i] = (rng.next_f64() * 2.0 - 1.0) * 0.05;
        }
        src[M * N + i] = (rng.next_f64() + 0.5) / 256.0;
    }
    st.src = Some(src);
    st.work = Some(work);
    st.acc = Some(acc);
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn nbody_run() -> u32 {
    // SAFETY: as above.
    let st = unsafe { STATE.get() };
    let (Some(src), Some(s), Some(acc)) = (
        st.src.as_deref(),
        st.work.as_deref_mut(),
        st.acc.as_deref_mut(),
    ) else {
        return 0;
    };
    s.copy_from_slice(src);
    for _ in 0..st.steps {
        step(s, acc);
    }
    let e = energy(s);
    let mut h = checksum::START;
    for i in 0..N {
        h = checksum::f64_bits(h, s[X * N + i]);
        h = checksum::f64_bits(h, s[Y * N + i]);
        h = checksum::f64_bits(h, s[Z * N + i]);
    }
    h = checksum::f64_bits(h, e);
    checksum::fold(h, st.steps)
}
