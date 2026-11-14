//! Memory kernels: fill and copy bandwidth, and random-access latency.
//!
//! Fill and copy use `write_bytes` / `copy_nonoverlapping`, which compile to
//! the wasm bulk-memory instructions `memory.fill` / `memory.copy`. The browser
//! runs those with its own native routine, so these tests show the best
//! bandwidth this browser can reach, which is the honest ceiling for any web code.
//!
//! Reference (mirrored in tests):
//!
//! `mem_fill` prepare(seed, size): buf = `size` bytes (contents not read).
//!   run(): acc = 0x811C9DC5
//!     for p in 0..FILL_PASSES:
//!       v = (seed + p) & 0xFF; set every byte of buf to v
//!       acc = fold(acc, buf[0]); acc = fold(acc, buf[size/2]); acc = fold(acc, buf[size-1])
//!     return fold(acc, size)
//!   Work: size x FILL_PASSES bytes written.
//!
//! `mem_copy` prepare(seed, size): src = `size` bytes filled like sha256's
//!   buffer (4-byte little-endian chunks of Rng(seed).next_u32(); the last chunk
//!   truncated), dst = `size` bytes.
//!   run(): acc = 0x811C9DC5
//!     for p in 0..COPY_PASSES:
//!       copy src -> dst (all `size` bytes)
//!       acc = fold(acc, dst[(p * 4099) % size])
//!     return fold(fold(acc, dst[size-1]), size)
//!   Work: size x COPY_PASSES bytes copied (each byte read once and written
//!   once; the figure counts bytes copied, not bytes moved).
//!
//! `mem_latency` prepare(seed, size): n = size / 64 cache lines (size must be a
//!   multiple of 64 and >= 128, else status 2).
//!   order = [0, 1, ..., n-1]; Sattolo shuffle with rng = Rng(seed):
//!     for i from n-1 down to 1: j = rng.next_u32() % i; swap(order[i], order[j])
//!   (Sattolo's variant, j < i, gives a single cycle through every line.)
//!   Line k's first u32 holds the index of the next line:
//!     for i in 0..n: next[order[i]] = order[(i + 1) % n]
//!   run(): idx = 0; repeat LATENCY_HOPS times: idx = next[idx]; return idx
//!   Each hop depends on the previous one, so hops cannot overlap: the time
//!   per hop is the latency of a random access at this working-set size.
//!   Work: LATENCY_HOPS dependent loads.

use crate::arena;
use crate::checksum::{Rng, START, fold};
use crate::global::Global;
use core::hint::black_box;

pub const FILL_PASSES: u32 = 40;
pub const COPY_PASSES: u32 = 96;
/// Not a power of two: the chain length is, and a multiple of it would always
/// end back on line 0, making the checksum useless.
pub const LATENCY_HOPS: u32 = (1 << 20) + 7;
/// u32 slots per 64-byte cache line.
const LINE_U32: usize = 16;

struct State {
    seed: u32,
    a: &'static mut [u8],
    b: &'static mut [u8],
    chain: &'static mut [u32],
}

static STATE: Global<State> = Global::new(State {
    seed: 0,
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

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_prepare(seed: u32, size: u32) -> u32 {
    let s = clear();
    if size == 0 {
        return 2;
    }
    let n = size as usize;
    let (Some(a), Some(b)) = (arena::alloc_slice::<u8>(n), arena::alloc_slice::<u8>(n)) else {
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

#[unsafe(no_mangle)]
pub extern "C" fn mem_copy_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let n = s.a.len();
    let mut acc = START;
    for p in 0..COPY_PASSES {
        let src: &[u8] = black_box(&*s.a);
        let dst: &mut [u8] = black_box(&mut *s.b);
        dst.copy_from_slice(src);
        acc = fold(acc, dst[(p as usize * 4099) % n] as u32);
    }
    fold(fold(acc, s.b[n - 1] as u32), n as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_latency_prepare(seed: u32, size: u32) -> u32 {
    let s = clear();
    let bytes = size as usize;
    if bytes < 128 || !bytes.is_multiple_of(64) {
        return 2;
    }
    let n = bytes / 64;
    let (Some(chain), Some(order)) = (
        arena::alloc_slice::<u32>(n * LINE_U32),
        arena::alloc_slice::<u32>(n),
    ) else {
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
    for i in 0..n {
        let next = order[(i + 1) % n];
        chain[order[i] as usize * LINE_U32] = next;
    }
    s.chain = chain;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mem_latency_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let chain: &[u32] = &*s.chain;
    let mut idx: u32 = 0;
    for _ in 0..LATENCY_HOPS {
        idx = chain[idx as usize * LINE_U32];
    }
    idx
}
