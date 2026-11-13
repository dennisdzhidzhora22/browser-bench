//! M0 smoke kernel: a xorshift32 stream folded into a checksum.
//!
//! It exists to prove the pipeline end to end (Rust -> wasm -> worker -> UI ->
//! tests). It is not a scored benchmark.
//!
//! Reference (mirrored in tests so the checksum is checked independently):
//!   x = seed, or 0x9E3779B9 if seed == 0
//!   acc = 0
//!   repeat `iterations` times:
//!     x ^= x << 13; x ^= x >> 17; x ^= x << 5
//!     acc = rotl(acc, 5) ^ x, then acc = acc * 0x01000193   (all wrapping u32)
//!   return acc

pub fn run(seed: u32, iterations: u32) -> u32 {
    let mut x = if seed == 0 { 0x9E37_79B9 } else { seed };
    let mut acc: u32 = 0;
    for _ in 0..iterations {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        acc = (acc.rotate_left(5) ^ x).wrapping_mul(0x0100_0193);
    }
    acc
}
