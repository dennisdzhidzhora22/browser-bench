//! SHA-256 kernel (`sha256`): hashes a fixed pseudo-random buffer.
//! Stresses 32-bit integer arithmetic and bit operations.
//!
//! Reference (mirrored in tests):
//!
//! prepare(seed, size):
//!   rng = checksum::Rng::new(seed)            (xorshift32, seed 0 -> 0x9E3779B9)
//!   buf = `size` bytes, filled in 4-byte chunks from offset 0:
//!     for each chunk: v = rng.next_u32(); write v's bytes little-endian
//!     (v & 0xFF first). The last chunk is truncated if size % 4 != 0
//!     (it still consumes one whole next_u32()).
//!
//! run(): PASSES = 8 identical passes.
//!   acc = 0x811C9DC5
//!   repeat PASSES times:
//!     d = SHA-256(buf) exactly as FIPS 180-4 (0x80 padding, 64-bit big-endian
//!     bit length). d is taken as 8 u32 words H0..H7 (big-endian word value, so
//!     H0 is the first 4 digest bytes read as a big-endian u32).
//!     for w in H0..H7: acc = (acc ^ w) * 0x01000193   (wrapping u32)
//!   return acc
//!
//! Work: `size` bytes hashed PASSES times per run. Passes keep the buffer small
//! (one instance per core in the multi-core test) while each run stays long.

use crate::arena;
use crate::checksum::{Rng, START, fold};
use crate::global::Global;

struct State {
    buf: &'static mut [u8],
}

static STATE: Global<State> = Global::new(State { buf: &mut [] });

/// Hash passes per `run` call.
const PASSES: u32 = 8;

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H_INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

#[inline(always)]
fn compress(h: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for (i, word) in w.iter_mut().take(16).enumerate() {
        let b = &block[i * 4..i * 4 + 4];
        *word = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = hh
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);
        hh = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
    h[5] = h[5].wrapping_add(f);
    h[6] = h[6].wrapping_add(g);
    h[7] = h[7].wrapping_add(hh);
}

fn sha256(data: &[u8]) -> [u32; 8] {
    let mut h = H_INIT;
    let (blocks, rem) = data.as_chunks::<64>();
    for block in blocks {
        compress(&mut h, block);
    }
    let mut tail = [0u8; 128];
    tail[..rem.len()].copy_from_slice(rem);
    tail[rem.len()] = 0x80;
    let total = if rem.len() < 56 { 64 } else { 128 };
    let bits = (data.len() as u64).wrapping_mul(8);
    tail[total - 8..total].copy_from_slice(&bits.to_be_bytes());
    for block in tail[..total].as_chunks::<64>().0 {
        compress(&mut h, block);
    }
    h
}

#[unsafe(no_mangle)]
pub extern "C" fn sha256_prepare(seed: u32, size: u32) -> u32 {
    // SAFETY: single-threaded instance; no other reference is alive.
    unsafe { STATE.get() }.buf = &mut [];
    arena::reset();
    let Some(buf) = arena::alloc_slice::<u8>(size as usize) else {
        return 1;
    };
    let mut rng = Rng::new(seed);
    for chunk in buf.chunks_mut(4) {
        let b = rng.next_u32().to_le_bytes();
        chunk.copy_from_slice(&b[..chunk.len()]);
    }
    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    s.buf = buf;
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn sha256_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let mut acc = START;
    for _ in 0..PASSES {
        // black_box stops the compiler from hashing once and reusing the digest.
        let buf: &[u8] = core::hint::black_box(&*s.buf);
        acc = sha256(buf).iter().fold(acc, |a, &w| fold(a, w));
    }
    acc
}
