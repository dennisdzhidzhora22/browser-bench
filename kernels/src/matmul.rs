//! Dense f64 matrix multiply, scalar (`matmul`) and simd128 (`matmul_simd`).
//!
//! Reference (mirrored in tests):
//!
//! prepare(seed, size):
//!   n = size; n must be a nonzero multiple of 8, else return 2. OOM -> 1.
//!   A, B, C are n*n f64, row-major (element (i, j) at i*n + j).
//!   rng = checksum::Rng::new(seed)
//!   for idx in 0..n*n: A[idx] = rng.next_f64() - 0.5
//!   for idx in 0..n*n: B[idx] = rng.next_f64() - 0.5      (same rng, continued)
//!
//! run():
//!   C = 0.0 everywhere, then C = A * B where every element is summed in plain
//!   increasing-k order, one product at a time, no FMA:
//!     c = 0.0
//!     for k in 0..n: c = c + (A[i*n+k] * B[k*n+j])
//!   Both variants produce bit-identical C, so they share expected checksums.
//!   Checksum:
//!     acc = checksum::START
//!     for idx in (0..n*n).step_by(7): acc = f64_bits(acc, C[idx])
//!     tr = 0.0; for i in 0..n: tr = tr + C[i*n+i]
//!     acc = f64_bits(acc, tr); return acc
//!
//! Loop structure (only affects speed, not results):
//!   Cache blocking over k in blocks of BK = 64 rows of B. For each k-block,
//!   for each row i, for each group of columns j: load the partial sums of
//!   C[i][j..] into registers, add the k-block's products in increasing k,
//!   store them back. Since k-blocks are visited in increasing order, each
//!   element still sees the sequential k order above.
//!   - Scalar: i-j-k inner order, 4 adjacent columns per group, 4 scalar
//!     accumulators; the k loop is a strict-order reduction, so the compiler
//!     cannot reassociate it.
//!   - SIMD: the same, with 4 f64x2 accumulators = 8 adjacent columns per group;
//!     each lane does exactly the scalar per-element operations.
//!
//!   A k-block of B is 64 * n * 8 bytes (256 KiB at n = 512).
//!
//! Work: 2 * n^3 floating-point operations per run.

use crate::arena;
use crate::checksum::{Rng, START, f64_bits};
use crate::global::Global;
use core::arch::wasm32::*;

const BK: usize = 64;

struct State {
    n: usize,
    a: Option<&'static mut [f64]>,
    b: Option<&'static mut [f64]>,
    c: Option<&'static mut [f64]>,
}

static STATE: Global<State> = Global::new(State {
    n: 0,
    a: None,
    b: None,
    c: None,
});

fn prepare(seed: u32, size: u32) -> u32 {
    arena::reset();
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    s.a = None;
    s.b = None;
    s.c = None;
    let n = size as usize;
    if n == 0 || !n.is_multiple_of(8) {
        return 2;
    }
    let len = n * n;
    let (Some(a), Some(b), Some(c)) = (
        arena::alloc_slice::<f64>(len),
        arena::alloc_slice::<f64>(len),
        arena::alloc_slice::<f64>(len),
    ) else {
        return 1;
    };
    let mut rng = Rng::new(seed);
    for x in a.iter_mut() {
        *x = rng.next_f64() - 0.5;
    }
    for x in b.iter_mut() {
        *x = rng.next_f64() - 0.5;
    }
    c.fill(0.0);
    s.n = n;
    s.a = Some(a);
    s.b = Some(b);
    s.c = Some(c);
    0
}

fn checksum(n: usize, c: &[f64]) -> u32 {
    let mut acc = START;
    let mut idx = 0;
    while idx < n * n {
        acc = f64_bits(acc, c[idx]);
        idx += 7;
    }
    let mut tr = 0.0;
    for i in 0..n {
        tr += c[i * n + i];
    }
    f64_bits(acc, tr)
}

fn mul_scalar(n: usize, a: &[f64], b: &[f64], c: &mut [f64]) {
    c.fill(0.0);
    let mut kb = 0;
    while kb < n {
        let ke = (kb + BK).min(n);
        for i in 0..n {
            let arow = &a[i * n..i * n + n];
            let crow = &mut c[i * n..i * n + n];
            let mut j = 0;
            while j < n {
                let mut c0 = crow[j];
                let mut c1 = crow[j + 1];
                let mut c2 = crow[j + 2];
                let mut c3 = crow[j + 3];
                for (k, &av) in arow.iter().enumerate().take(ke).skip(kb) {
                    let br = &b[k * n + j..k * n + j + 4];
                    c0 += av * br[0];
                    c1 += av * br[1];
                    c2 += av * br[2];
                    c3 += av * br[3];
                }
                crow[j] = c0;
                crow[j + 1] = c1;
                crow[j + 2] = c2;
                crow[j + 3] = c3;
                j += 4;
            }
        }
        kb = ke;
    }
}

fn mul_simd(n: usize, a: &[f64], b: &[f64], c: &mut [f64]) {
    c.fill(0.0);
    let mut kb = 0;
    while kb < n {
        let ke = (kb + BK).min(n);
        for i in 0..n {
            let arow = &a[i * n..i * n + n];
            let crow = &mut c[i * n..i * n + n];
            let mut j = 0;
            while j < n {
                let cp = crow[j..j + 8].as_mut_ptr() as *mut v128;
                // SAFETY: cp points at 8 in-bounds f64 (checked by the slice
                // above); v128_load/store allow unaligned addresses.
                let (mut c0, mut c1, mut c2, mut c3) = unsafe {
                    (
                        v128_load(cp),
                        v128_load(cp.add(1)),
                        v128_load(cp.add(2)),
                        v128_load(cp.add(3)),
                    )
                };
                for (k, &av) in arow.iter().enumerate().take(ke).skip(kb) {
                    let av = f64x2_splat(av);
                    let bp = b[k * n + j..k * n + j + 8].as_ptr() as *const v128;
                    // SAFETY: bp points at 8 in-bounds f64.
                    let (b0, b1, b2, b3) = unsafe {
                        (
                            v128_load(bp),
                            v128_load(bp.add(1)),
                            v128_load(bp.add(2)),
                            v128_load(bp.add(3)),
                        )
                    };
                    c0 = f64x2_add(c0, f64x2_mul(av, b0));
                    c1 = f64x2_add(c1, f64x2_mul(av, b1));
                    c2 = f64x2_add(c2, f64x2_mul(av, b2));
                    c3 = f64x2_add(c3, f64x2_mul(av, b3));
                }
                // SAFETY: as for the loads.
                unsafe {
                    v128_store(cp, c0);
                    v128_store(cp.add(1), c1);
                    v128_store(cp.add(2), c2);
                    v128_store(cp.add(3), c3);
                }
                j += 8;
            }
        }
        kb = ke;
    }
}

fn run(simd: bool) -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    let n = s.n;
    let (Some(a), Some(b), Some(c)) = (s.a.as_deref(), s.b.as_deref(), s.c.as_deref_mut()) else {
        return 0;
    };
    if simd {
        mul_simd(n, a, b, c);
    } else {
        mul_scalar(n, a, b, c);
    }
    checksum(n, c)
}

#[unsafe(no_mangle)]
pub extern "C" fn matmul_prepare(seed: u32, size: u32) -> u32 {
    prepare(seed, size)
}

#[unsafe(no_mangle)]
pub extern "C" fn matmul_run() -> u32 {
    run(false)
}

#[unsafe(no_mangle)]
pub extern "C" fn matmul_simd_prepare(seed: u32, size: u32) -> u32 {
    prepare(seed, size)
}

#[unsafe(no_mangle)]
pub extern "C" fn matmul_simd_run() -> u32 {
    run(true)
}
