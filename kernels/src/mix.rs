//! Pipeline smoke kernel (`mix`): a xorshift32 stream folded into a checksum.
//! Proves Rust -> wasm -> worker -> UI -> tests. Not a scored benchmark, and
//! the reference example for the prepare/run ABI.
//!
//! Reference (mirrored in tests):
//!   x = seed, or 0x9E3779B9 if seed == 0
//!   acc = 0
//!   repeat `size` times:
//!     x ^= x << 13; x ^= x >> 17; x ^= x << 5
//!     acc = rotl(acc, 5) ^ x, then acc = acc * 0x01000193   (all wrapping u32)
//!   return acc

use crate::global::Global;

struct State {
    seed: u32,
    size: u32,
}

static STATE: Global<State> = Global::new(State { seed: 0, size: 0 });

#[unsafe(no_mangle)]
pub extern "C" fn mix_prepare(seed: u32, size: u32) -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    s.seed = seed;
    s.size = size;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mix_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let mut x = if s.seed == 0 { 0x9E37_79B9 } else { s.seed };
    let mut acc: u32 = 0;
    for _ in 0..s.size {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        acc = (acc.rotate_left(5) ^ x).wrapping_mul(0x0100_0193);
    }
    acc
}
