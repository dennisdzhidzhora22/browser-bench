//! Shared checksum and RNG helpers. Mirrored in JS by tests; keep them simple.

/// FNV-1a style fold of one u32 into an accumulator.
///   acc = (acc ^ v) * 0x01000193   (wrapping u32)
#[inline(always)]
pub fn fold(acc: u32, v: u32) -> u32 {
    (acc ^ v).wrapping_mul(0x0100_0193)
}

/// Initial accumulator for `fold`.
pub const START: u32 = 0x811C_9DC5;

/// Folds the exact bits of an f64 (low word, then high word).
#[inline(always)]
pub fn f64_bits(acc: u32, v: f64) -> u32 {
    let b = v.to_bits();
    fold(fold(acc, b as u32), (b >> 32) as u32)
}

/// xorshift32. A zero seed is replaced with 0x9E3779B9.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(if seed == 0 { 0x9E37_79B9 } else { seed })
    }

    #[inline(always)]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform in [0, 1): `(next_u32() >> 8) as f64 / 16777216.0`.
    #[inline(always)]
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u32() >> 8) as f64 / 16_777_216.0
    }
}
