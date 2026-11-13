//! Sort kernels (`sort_u32`, `sort_f64`): introsort written for this project.
//! core's `slice::sort*` is deliberately not used, so the workload does not
//! change with the Rust version.
//!
//! # Data (prepare, untimed)
//!
//! `rng = checksum::Rng::new(seed)`, then for i in 0..size, in order:
//! - `sort_u32`: `src[i] = rng.next_u32()`
//! - `sort_f64`: `src[i] = (rng.next_f64() - 0.5) * 2000.0`   (in [-1000, 1000),
//!   never NaN, never -0.0)
//!
//! # Work (run, timed)
//!
//! 1. Copy `src` into the work buffer `a` (part of the measured work).
//! 2. Introsort `a` ascending with `<`:
//!    - while the range has more than 16 elements: if the depth budget
//!      (initially `2 * floor(log2(size))`) is spent, heapsort the range and
//!      stop; otherwise order `a[0]`, `a[mid]`, `a[last]` in place
//!      (`mid = (len - 1) / 2`), take `p = a[mid]`, Hoare-partition around
//!      `p`, recurse into the smaller part and loop on the larger one;
//!    - ranges of 16 or fewer elements get insertion sort.
//!
//! The checksum depends only on the sorted output, which is unique for these
//! inputs, so a JS mirror may simply use `TypedArray.prototype.sort()`.
//!
//! # Checksum
//!
//! ```text
//! acc = START
//! if any i in 1..n has a[i] < a[i-1]: acc = fold(acc, 0xDEADBEEF)
//! stride = max(1, floor(n / 1024))
//! for i = 0, stride, 2*stride, ... while i < n:
//!     u32: acc = fold(acc, a[i])      f64: acc = f64_bits(acc, a[i])
//! acc = fold(acc, n)
//! ```

use crate::arena;
use crate::checksum::{self, Rng};
use crate::global::Global;

/// Ranges at or below this length are insertion-sorted.
const SMALL: usize = 16;

struct Bufs<T: 'static> {
    src: Option<&'static mut [T]>,
    work: Option<&'static mut [T]>,
}

static U32: Global<Bufs<u32>> = Global::new(Bufs {
    src: None,
    work: None,
});
static F64: Global<Bufs<f64>> = Global::new(Bufs {
    src: None,
    work: None,
});

fn insertion_sort<T: Copy + PartialOrd>(a: &mut [T]) {
    for i in 1..a.len() {
        let v = a[i];
        let mut j = i;
        while j > 0 && v < a[j - 1] {
            a[j] = a[j - 1];
            j -= 1;
        }
        a[j] = v;
    }
}

fn sift_down<T: Copy + PartialOrd>(a: &mut [T], mut root: usize, end: usize) {
    loop {
        let mut child = 2 * root + 1;
        if child >= end {
            return;
        }
        if child + 1 < end && a[child] < a[child + 1] {
            child += 1;
        }
        if a[child] <= a[root] {
            return;
        }
        a.swap(root, child);
        root = child;
    }
}

fn heapsort<T: Copy + PartialOrd>(a: &mut [T]) {
    let n = a.len();
    for i in (0..n / 2).rev() {
        sift_down(a, i, n);
    }
    for end in (1..n).rev() {
        a.swap(0, end);
        sift_down(a, 0, end);
    }
}

/// Orders a[0], a[mid], a[last], then Hoare-partitions around the median.
/// Returns `j` with every element of `a[..=j]` <= p <= every element of
/// `a[j+1..]`, and `j < len - 1`, so both parts are non-empty.
fn partition<T: Copy + PartialOrd>(a: &mut [T]) -> usize {
    let last = a.len() - 1;
    let mid = last / 2;
    if a[mid] < a[0] {
        a.swap(mid, 0);
    }
    if a[last] < a[mid] {
        a.swap(last, mid);
        if a[mid] < a[0] {
            a.swap(mid, 0);
        }
    }
    let p = a[mid];
    let mut i = 0;
    let mut j = last;
    loop {
        while a[i] < p {
            i += 1;
        }
        while p < a[j] {
            j -= 1;
        }
        if i >= j {
            return j;
        }
        a.swap(i, j);
        i += 1;
        j -= 1;
    }
}

fn introsort<T: Copy + PartialOrd>(mut a: &mut [T], mut depth: u32) {
    while a.len() > SMALL {
        if depth == 0 {
            heapsort(a);
            return;
        }
        depth -= 1;
        let j = partition(a);
        let (lo, hi) = a.split_at_mut(j + 1);
        if lo.len() < hi.len() {
            introsort(lo, depth);
            a = hi;
        } else {
            introsort(hi, depth);
            a = lo;
        }
    }
    insertion_sort(a);
}

fn sort<T: Copy + PartialOrd>(a: &mut [T]) {
    let n = a.len();
    let depth = if n > 1 { 2 * n.ilog2() } else { 0 };
    introsort(a, depth);
}

fn checksum<T: Copy + PartialOrd>(a: &[T], fold: impl Fn(u32, T) -> u32) -> u32 {
    let mut acc = checksum::START;
    if a.windows(2).any(|w| w[1] < w[0]) {
        acc = checksum::fold(acc, 0xDEAD_BEEF);
    }
    let stride = (a.len() / 1024).max(1);
    for &v in a.iter().step_by(stride) {
        acc = fold(acc, v);
    }
    checksum::fold(acc, a.len() as u32)
}

fn prepare<T: Copy>(b: &mut Bufs<T>, size: u32, mut fill: impl FnMut() -> T) -> u32 {
    arena::reset();
    b.src = None;
    b.work = None;
    let n = size as usize;
    let (Some(src), Some(work)) = (arena::alloc_slice::<T>(n), arena::alloc_slice::<T>(n)) else {
        return 1;
    };
    for v in src.iter_mut() {
        *v = fill();
    }
    b.src = Some(src);
    b.work = Some(work);
    0
}

fn run<T: Copy + PartialOrd>(b: &mut Bufs<T>, fold: impl Fn(u32, T) -> u32) -> u32 {
    let (Some(src), Some(work)) = (b.src.as_deref(), b.work.as_deref_mut()) else {
        return 0;
    };
    work.copy_from_slice(src);
    sort(work);
    checksum(work, fold)
}

#[unsafe(no_mangle)]
pub extern "C" fn sort_u32_prepare(seed: u32, size: u32) -> u32 {
    let mut rng = Rng::new(seed);
    // SAFETY: single-threaded instance; no other reference is alive.
    prepare(unsafe { U32.get() }, size, || rng.next_u32())
}

#[unsafe(no_mangle)]
pub extern "C" fn sort_u32_run() -> u32 {
    // SAFETY: as above.
    run(unsafe { U32.get() }, checksum::fold)
}

#[unsafe(no_mangle)]
pub extern "C" fn sort_f64_prepare(seed: u32, size: u32) -> u32 {
    let mut rng = Rng::new(seed);
    // SAFETY: single-threaded instance; no other reference is alive.
    prepare(unsafe { F64.get() }, size, || {
        (rng.next_f64() - 0.5) * 2000.0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn sort_f64_run() -> u32 {
    // SAFETY: as above.
    run(unsafe { F64.get() }, checksum::f64_bits)
}
