//! Memory kernels: fill and copy bandwidth, and random-access latency.
//!
//! Fill and copy use `fill` / `copy_from_slice`, which compile to the wasm
//! bulk-memory instructions `memory.fill` / `memory.copy`. The browser runs
//! those with its own native routine, so these tests show the best bandwidth
//! this browser can reach, which is the honest ceiling for any web code.
//!
//! Status codes from every prepare: 0 ok, 1 out of memory, 2 invalid size.
//!
//! Reference (mirrored in tests):
//!
//! `mem_fill` prepare(seed, size): size 0 -> 2. buf = `size` bytes, zeroed.
//!   run(): acc = 0x811C9DC5
//!     for p in 0..FILL_PASSES:
//!       v = (seed + p) & 0xFF; set every byte of buf to v
//!       acc = fold(acc, buf[0]); acc = fold(acc, buf[size/2]); acc = fold(acc, buf[size-1])
//!     return fold(acc, size)
//!   Work: size x FILL_PASSES bytes written.
//!
//! `mem_copy` / `mem_copy_mt` prepare(seed, size): size 0 -> 2. src = `size`
//!   bytes filled like sha256's buffer (4-byte little-endian chunks of
//!   Rng(seed).next_u32(); the last chunk truncated), dst = `size` bytes, zeroed.
//!   run(): passes = COPY_PASSES (`mem_copy`) or COPY_MT_PASSES (`mem_copy_mt`)
//!     acc = 0x811C9DC5
//!     for p in 0..passes:
//!       copy src -> dst (all `size` bytes)
//!       acc = fold(acc, dst[(p * 4099) % size])
//!     return fold(fold(acc, dst[size-1]), size)
//!   Work: size x passes bytes copied (each byte read once and written once;
//!   the figure counts bytes copied, so memory traffic is about twice it).
//!   `mem_copy_mt` is the same work with few passes, so one `run` is short
//!   next to the all-cores timed window.
//!
//! `mem_latency` prepare(seed, size): n = size / 64 cache lines (size must be a
//!   multiple of 64 and >= 128, else status 2).
//!   order = [0, 1, ..., n-1]; shuffle with rng = Rng(seed) (Sattolo's variant):
//!     for i from n-1 down to 1: j = rng.next_u32() % i; swap(order[i], order[j])
//!   Linking order[i] -> order[i+1] (wrapping) makes one cycle through every
//!   line, in a random order the hardware prefetcher cannot predict.
//!   The chain is `size` bytes, zeroed. Word 0 of line k holds the byte
//!   ADDRESS (in wasm memory) of word 0 of the next line:
//!     for i in 0..n: word0(order[i]) = base + 64 * order[(i + 1) % n]
//!   where base = address of line 0.
//!   run(): p = base; repeat hops(size) times: p = load_u32(p)
//!     return (p - base) / 64      (the line reached, as an index)
//!   Each hop is one dependent load with no other arithmetic, so hops cannot
//!   overlap and the time per hop is the latency of a random access at this
//!   working-set size.
//!   hops(size): each tier is sized so one run takes about 50 ms or more at
//!   the FASTEST plausible latency for that size (e.g. a big-L3 desktop), and
//!   is at least one hop per line so large sizes touch every line:
//!     size < 16 KiB (tests only): n * 16 + 7
//!     size <= 32 KiB: 2^26 + 7     size <= 256 KiB: 2^25 + 7
//!     size <= 2 MiB:  2^24 + 7     size <= 8 MiB:   2^23 + 7
//!     size <= 64 MiB: 2^22 + 7     larger: max(n, 2^21) + 7
//!   (+7: n is often a power of two, and a multiple of n would always end on
//!   line 0, making the checksum useless.)
//!   Work: hops(size) dependent loads.

use crate::arena;
use crate::checksum::{Rng, START, fold};
use crate::global::Global;
use core::hint::black_box;

pub const FILL_PASSES: u32 = 20;
pub const COPY_PASSES: u32 = 48;
pub const COPY_MT_PASSES: u32 = 2;

const KIB: u32 = 1024;
const MIB: u32 = 1024 * 1024;

/// Dependent loads per `mem_latency_run` at a working-set size (see header).
pub fn latency_hops(size: u32) -> u32 {
    let n = size / 64;
    let base = if size < 16 * KIB {
        n * 16
    } else if size <= 32 * KIB {
        1 << 26
    } else if size <= 256 * KIB {
        1 << 25
    } else if size <= 2 * MIB {
        1 << 24
    } else if size <= 8 * MIB {
        1 << 23
    } else if size <= 64 * MIB {
        1 << 22
    } else {
        n.max(1 << 21)
    };
    base + 7
}

struct State {
    seed: u32,
    hops: u32,
    a: &'static mut [u8],
    b: &'static mut [u8],
    chain: &'static mut [u32],
}

static STATE: Global<State> = Global::new(State {
    seed: 0,
    hops: 0,
    a: &mut [],
    b: &mut [],
    chain: &mut [],
});

fn clear() -> &'static mut State {
    // SAFETY: single-threaded instance; callers hold no other reference.
    let s = unsafe { STATE.get() };
    s.a = &mut [];
    s.b = &mut [];
    s.chain = &mut [];
    // No hops without a chain: a stray run after another prepare does nothing.
    s.hops = 0;
    arena::reset();
    s
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_fill_prepare(seed: u32, size: u32) -> u32 {
    let s = clear();
    if size == 0 {
        return 2;
    }
    let Some(a) = arena::alloc_slice::<u8>(size as usize) else {
        return 1;
    };
    a.fill(0);
    s.seed = seed;
    s.a = a;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_fill_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let n = s.a.len();
    let mut acc = START;
    for p in 0..FILL_PASSES {
        let v = (s.seed.wrapping_add(p) & 0xFF) as u8;
        let buf: &mut [u8] = black_box(&mut *s.a);
        buf.fill(v);
        acc = fold(acc, buf[0] as u32);
        acc = fold(acc, buf[n / 2] as u32);
        acc = fold(acc, buf[n - 1] as u32);
    }
    fold(acc, n as u32)
}

fn copy_prepare(seed: u32, size: u32) -> u32 {
    let s = clear();
    if size == 0 {
        return 2;
    }
    let n = size as usize;
    let Some(a) = arena::alloc_slice::<u8>(n) else {
        return 1;
    };
    let Some(b) = arena::alloc_slice::<u8>(n) else {
        return 1;
    };
    let mut rng = Rng::new(seed);
    for chunk in a.chunks_mut(4) {
        let v = rng.next_u32().to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
    b.fill(0);
    s.a = a;
    s.b = b;
    0
}

fn copy_run(passes: u32) -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let n = s.a.len();
    let mut acc = START;
    for p in 0..passes {
        let src: &[u8] = black_box(&*s.a);
        let dst: &mut [u8] = black_box(&mut *s.b);
        dst.copy_from_slice(src);
        acc = fold(acc, dst[(p as usize * 4099) % n] as u32);
    }
    fold(fold(acc, s.b[n - 1] as u32), n as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_prepare(seed: u32, size: u32) -> u32 {
    copy_prepare(seed, size)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_run() -> u32 {
    copy_run(COPY_PASSES)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_mt_prepare(seed: u32, size: u32) -> u32 {
    copy_prepare(seed, size)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_mt_run() -> u32 {
    copy_run(COPY_MT_PASSES)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_latency_prepare(seed: u32, size: u32) -> u32 {
    let s = clear();
    let bytes = size as usize;
    if bytes < 128 || !bytes.is_multiple_of(64) {
        return 2;
    }
    let n = bytes / 64;
    // Allocate one at a time: a failed first allocation must not grow memory further.
    let Some(chain) = arena::alloc_slice::<u32>(bytes / 4) else {
        return 1;
    };
    let Some(order) = arena::alloc_slice::<u32>(n) else {
        return 1;
    };
    for (i, o) in order.iter_mut().enumerate() {
        *o = i as u32;
    }
    let mut rng = Rng::new(seed);
    for i in (1..n).rev() {
        let j = (rng.next_u32() % i as u32) as usize;
        order.swap(i, j);
    }
    chain.fill(0);
    let base = chain.as_ptr() as u32;
    for i in 0..n {
        let next = order[(i + 1) % n];
        chain[order[i] as usize * 16] = base + next * 64;
    }
    s.hops = latency_hops(size);
    s.chain = chain;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_latency_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    if s.chain.is_empty() {
        return 0;
    }
    let base = s.chain.as_ptr() as usize;
    let mut p = base;
    for _ in 0..s.hops {
        // SAFETY: every word 0 of the chain holds the address of word 0 of a
        // line inside the chain (set in prepare), so `p` always points into
        // the chain and is 4-byte aligned. One plain load per hop: no bounds
        // check or index arithmetic in the dependency chain.
        p = unsafe { core::ptr::read(p as *const u32) } as usize;
    }
    ((p - base) / 64) as u32
}
