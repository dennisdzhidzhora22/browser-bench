//! Iterative radix-2 complex f64 FFT (`fft`), fixed length N = 4096.
//!
//! Reference (mirrored in tests). All arithmetic is plain IEEE f64, one
//! operation at a time, left to right as written, no FMA.
//!
//! Constants:
//!   N = 4096, LOG = 12, STEP = 6.283185307179586 / 4096.0   (= 2*PI/N = TAU/N)
//!
//! Own sin/cos (no libm), for 0 <= x <= PI/4 (Taylor series, Horner form):
//!   x2 = x * x
//!   sin_poly(x): p = -1/15!; then for c in [1/13!, -1/11!, 1/9!, -1/7!,
//!                1/5!, -1/3!, 1]: p = p * x2 + c;   result = x * p
//!   cos_poly(x): p = 1/16!; then for c in [-1/14!, 1/12!, -1/10!, 1/8!,
//!                -1/6!, 1/4!, -1/2!, 1]: p = p * x2 + c;  result = p
//!   Each coefficient 1/m! is the f64 division 1.0 / (m! as f64) (m! is exact),
//!   negated where shown.
//!
//! Twiddles for k in 0..N/2, (cos(2*PI*k/N), sin(2*PI*k/N)):
//!   base(m), 0 <= m <= N/4:
//!     if m <= N/8: x = (m as f64) * STEP; (cos_poly(x), sin_poly(x))
//!     else:        x = ((N/4 - m) as f64) * STEP; (sin_poly(x), cos_poly(x))
//!   twiddle(k) = base(k)                     if k <= N/4
//!              = (-s, c) where (c, s) = base(k - N/4)   otherwise
//!   COS[k], SIN[k] hold the two parts.
//!
//! prepare(seed, size):
//!   rng = checksum::Rng::new(seed)
//!   for i in 0..N: IN_RE[i] = rng.next_f64() - 0.5; IN_IM[i] = rng.next_f64() - 0.5
//!   (re then im for each i). Fill COS/SIN. size = transforms per run (>= 1,
//!   else return 2). OOM -> 1.
//!
//! transform(re, im, inverse):
//!   1. bit reversal: for i in 0..N: r = reverse of the low LOG bits of i;
//!      if i < r: swap re[i] <-> re[r] and im[i] <-> im[r].
//!   2. len = 2, 4, ..., N: half = len/2, tstep = N/len;
//!      for start in (0..N).step_by(len): for j in 0..half:
//!      - wr = COS[j*tstep]; wi = -SIN[j*tstep] (forward) or SIN[j*tstep] (inverse)
//!      - a = start + j; b = a + half
//!      - tr = wr*re[b] - wi*im[b];  ti = wr*im[b] + wi*re[b]
//!      - ur = re[a]; ui = im[a]
//!      - re[a] = ur + tr; im[a] = ui + ti; re[b] = ur - tr; im[b] = ui - ti
//!   3. inverse only: every re[i] and im[i] = value * (1.0 / 4096.0)  (exact scale).
//!
//! run():
//!   re = copy of IN_RE, im = copy of IN_IM (the copy is part of the work)
//!   for t in 0..size: transform(re, im, inverse = (t is odd))
//!   (so forward, inverse, forward, ...: values stay bounded)
//!   acc = checksum::START
//!   for i in (0..N).step_by(17): acc = f64_bits(acc, re[i]); acc = f64_bits(acc, im[i])
//!   return acc
//!
//! Work: `size` transforms per run.

use crate::arena;
use crate::checksum::{Rng, START, f64_bits};
use crate::global::Global;

const LOG: u32 = 12;
const N: usize = 1 << LOG;
const STEP: f64 = core::f64::consts::TAU / 4096.0;

struct State {
    size: u32,
    cos: Option<&'static mut [f64]>,
    sin: Option<&'static mut [f64]>,
    in_re: Option<&'static mut [f64]>,
    in_im: Option<&'static mut [f64]>,
    re: Option<&'static mut [f64]>,
    im: Option<&'static mut [f64]>,
}

static STATE: Global<State> = Global::new(State {
    size: 0,
    cos: None,
    sin: None,
    in_re: None,
    in_im: None,
    re: None,
    im: None,
});

/// m! as f64; exact for m <= 18.
const fn fact(m: u32) -> f64 {
    let mut r = 1.0;
    let mut i = 2;
    while i <= m {
        r *= i as f64;
        i += 1;
    }
    r
}

fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    let mut p = -(1.0 / fact(15));
    p = p * x2 + 1.0 / fact(13);
    p = p * x2 - 1.0 / fact(11);
    p = p * x2 + 1.0 / fact(9);
    p = p * x2 - 1.0 / fact(7);
    p = p * x2 + 1.0 / fact(5);
    p = p * x2 - 1.0 / fact(3);
    p = p * x2 + 1.0;
    x * p
}

fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    let mut p = 1.0 / fact(16);
    p = p * x2 - 1.0 / fact(14);
    p = p * x2 + 1.0 / fact(12);
    p = p * x2 - 1.0 / fact(10);
    p = p * x2 + 1.0 / fact(8);
    p = p * x2 - 1.0 / fact(6);
    p = p * x2 + 1.0 / fact(4);
    p = p * x2 - 1.0 / fact(2);
    p * x2 + 1.0
}

fn base(m: usize) -> (f64, f64) {
    if m <= N / 8 {
        let x = m as f64 * STEP;
        (cos_poly(x), sin_poly(x))
    } else {
        let x = (N / 4 - m) as f64 * STEP;
        (sin_poly(x), cos_poly(x))
    }
}

fn twiddle(k: usize) -> (f64, f64) {
    if k <= N / 4 {
        base(k)
    } else {
        let (c, s) = base(k - N / 4);
        (-s, c)
    }
}

fn transform(re: &mut [f64], im: &mut [f64], cos: &[f64], sin: &[f64], inverse: bool) {
    let re = &mut re[..N];
    let im = &mut im[..N];
    for i in 0..N {
        let r = ((i as u32).reverse_bits() >> (32 - LOG)) as usize;
        if i < r {
            re.swap(i, r);
            im.swap(i, r);
        }
    }
    let mut len = 2;
    while len <= N {
        let half = len / 2;
        let tstep = N / len;
        let mut start = 0;
        while start < N {
            for j in 0..half {
                let wr = cos[j * tstep];
                let wi = if inverse {
                    sin[j * tstep]
                } else {
                    -sin[j * tstep]
                };
                let a = start + j;
                let b = a + half;
                let br = re[b];
                let bi = im[b];
                let tr = wr * br - wi * bi;
                let ti = wr * bi + wi * br;
                let ur = re[a];
                let ui = im[a];
                re[a] = ur + tr;
                im[a] = ui + ti;
                re[b] = ur - tr;
                im[b] = ui - ti;
            }
            start += len;
        }
        len <<= 1;
    }
    if inverse {
        let scale = 1.0 / N as f64;
        for v in re.iter_mut() {
            *v *= scale;
        }
        for v in im.iter_mut() {
            *v *= scale;
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn fft_prepare(seed: u32, size: u32) -> u32 {
    arena::reset();
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    *s = State {
        size: 0,
        cos: None,
        sin: None,
        in_re: None,
        in_im: None,
        re: None,
        im: None,
    };
    if size == 0 {
        return 2;
    }
    let (Some(cos), Some(sin), Some(in_re), Some(in_im), Some(re), Some(im)) = (
        arena::alloc_slice::<f64>(N / 2),
        arena::alloc_slice::<f64>(N / 2),
        arena::alloc_slice::<f64>(N),
        arena::alloc_slice::<f64>(N),
        arena::alloc_slice::<f64>(N),
        arena::alloc_slice::<f64>(N),
    ) else {
        return 1;
    };
    for k in 0..N / 2 {
        let (c, s) = twiddle(k);
        cos[k] = c;
        sin[k] = s;
    }
    let mut rng = Rng::new(seed);
    for i in 0..N {
        in_re[i] = rng.next_f64() - 0.5;
        in_im[i] = rng.next_f64() - 0.5;
    }
    re.fill(0.0);
    im.fill(0.0);
    *s = State {
        size,
        cos: Some(cos),
        sin: Some(sin),
        in_re: Some(in_re),
        in_im: Some(in_im),
        re: Some(re),
        im: Some(im),
    };
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn fft_run() -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    let (Some(cos), Some(sin), Some(in_re), Some(in_im), Some(re), Some(im)) = (
        s.cos.as_deref(),
        s.sin.as_deref(),
        s.in_re.as_deref(),
        s.in_im.as_deref(),
        s.re.as_deref_mut(),
        s.im.as_deref_mut(),
    ) else {
        return 0;
    };
    re.copy_from_slice(in_re);
    im.copy_from_slice(in_im);
    for t in 0..s.size {
        transform(re, im, cos, sin, t % 2 == 1);
    }
    let mut acc = START;
    let mut i = 0;
    while i < N {
        acc = f64_bits(acc, re[i]);
        acc = f64_bits(acc, im[i]);
        i += 17;
    }
    acc
}
