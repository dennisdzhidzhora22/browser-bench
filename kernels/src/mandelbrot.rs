//! Mandelbrot (`mandelbrot`, scalar f64) and its simd128 variant
//! (`mandelbrot_simd`, two pixels per `f64x2`). Both produce identical
//! iteration counts and therefore the same checksum.
//!
//! No input data: `seed` is ignored, `size` is the image width `W`.
//! Height `H = floor(W * 3 / 4)` (u32 arithmetic), `MAX_ITER = 256`.
//! Every float expression is evaluated as written, left to right, one IEEE
//! f64 rounding per operation, no fused multiply-add.
//!
//! # Work (run, timed)
//!
//! ```text
//! scale = 3.0 / W                       // f64 division, W converted exactly
//! for py in 0..H:
//!     cy = py * scale + -1.125          // (py * scale) + (-1.125)
//!     for px in 0..W:
//!         cx = px * scale + -2.0        // (px * scale) + (-2.0)
//!         zr = 0.0; zi = 0.0; n = 0
//!         while n < MAX_ITER:
//!             zr2 = zr * zr;  zi2 = zi * zi
//!             if zr2 + zi2 > 4.0: break
//!             zi = (zr + zr) * zi + cy  // ((zr + zr) * zi) + cy
//!             zr = zr2 - zi2 + cx       // (zr2 - zi2) + cx
//!             n = n + 1
//!         acc = fold(acc, n)            // acc starts at checksum::START
//! acc = fold(acc, W); acc = fold(acc, H); return acc
//! ```
//!
//! The SIMD variant runs pixels `px` and `px + 1` in the two lanes with the
//! same per-lane operations. A lane stays counted while `zr2 + zi2 <= 4.0`;
//! once it fails the lane is retired (its z keeps iterating but is never read
//! again). An odd last column is done with the scalar loop. Counts are folded
//! in pixel order, so the checksum matches the scalar kernel bit for bit.

use crate::arena;
use crate::checksum;
use crate::global::Global;
use core::arch::wasm32::*;

pub const MAX_ITER: u32 = 256;

struct State {
    width: u32,
}

static SCALAR: Global<State> = Global::new(State { width: 0 });
static SIMD: Global<State> = Global::new(State { width: 0 });

fn height(w: u32) -> u32 {
    w.wrapping_mul(3) / 4
}

#[inline(always)]
fn iterate(cx: f64, cy: f64) -> u32 {
    let (mut zr, mut zi) = (0.0f64, 0.0f64);
    let mut n = 0;
    while n < MAX_ITER {
        let zr2 = zr * zr;
        let zi2 = zi * zi;
        if zr2 + zi2 > 4.0 {
            break;
        }
        zi = (zr + zr) * zi + cy;
        zr = zr2 - zi2 + cx;
        n += 1;
    }
    n
}

/// Two pixels at once. Returns the per-lane iteration counts.
#[inline(always)]
fn iterate2(cx0: f64, cx1: f64, cy: f64) -> (u32, u32) {
    let cx = f64x2(cx0, cx1);
    let cy = f64x2_splat(cy);
    let four = f64x2_splat(4.0);
    let mut zr = f64x2_splat(0.0);
    let mut zi = f64x2_splat(0.0);
    // All-ones lanes are still iterating; counts subtract the mask (-1).
    let mut active = i64x2_splat(-1);
    let mut count = i64x2_splat(0);
    for _ in 0..MAX_ITER {
        let zr2 = f64x2_mul(zr, zr);
        let zi2 = f64x2_mul(zi, zi);
        active = v128_and(active, f64x2_le(f64x2_add(zr2, zi2), four));
        if !v128_any_true(active) {
            break;
        }
        count = i64x2_sub(count, active);
        zi = f64x2_add(f64x2_mul(f64x2_add(zr, zr), zi), cy);
        zr = f64x2_add(f64x2_sub(zr2, zi2), cx);
    }
    (
        i64x2_extract_lane::<0>(count) as u32,
        i64x2_extract_lane::<1>(count) as u32,
    )
}

fn render_scalar(w: u32) -> u32 {
    let h = height(w);
    let scale = 3.0 / w as f64;
    let mut acc = checksum::START;
    for py in 0..h {
        let cy = py as f64 * scale + -1.125;
        for px in 0..w {
            let cx = px as f64 * scale + -2.0;
            acc = checksum::fold(acc, iterate(cx, cy));
        }
    }
    checksum::fold(checksum::fold(acc, w), h)
}

fn render_simd(w: u32) -> u32 {
    let h = height(w);
    let scale = 3.0 / w as f64;
    let pairs = w / 2;
    let mut acc = checksum::START;
    for py in 0..h {
        let cy = py as f64 * scale + -1.125;
        for k in 0..pairs {
            let px = 2 * k;
            let cx0 = px as f64 * scale + -2.0;
            let cx1 = (px + 1) as f64 * scale + -2.0;
            let (n0, n1) = iterate2(cx0, cx1, cy);
            acc = checksum::fold(checksum::fold(acc, n0), n1);
        }
        if w % 2 == 1 {
            let cx = (w - 1) as f64 * scale + -2.0;
            acc = checksum::fold(acc, iterate(cx, cy));
        }
    }
    checksum::fold(checksum::fold(acc, w), h)
}

#[unsafe(no_mangle)]
pub extern "C" fn mandelbrot_prepare(_seed: u32, size: u32) -> u32 {
    arena::reset();
    // SAFETY: single-threaded instance; no other reference is alive.
    unsafe { SCALAR.get() }.width = size;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mandelbrot_run() -> u32 {
    // SAFETY: as above.
    render_scalar(unsafe { SCALAR.get() }.width)
}

#[unsafe(no_mangle)]
pub extern "C" fn mandelbrot_simd_prepare(_seed: u32, size: u32) -> u32 {
    arena::reset();
    // SAFETY: single-threaded instance; no other reference is alive.
    unsafe { SIMD.get() }.width = size;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mandelbrot_simd_run() -> u32 {
    // SAFETY: as above.
    render_simd(unsafe { SIMD.get() }.width)
}
