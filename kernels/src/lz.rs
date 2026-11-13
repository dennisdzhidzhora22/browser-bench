//! LZ77-style compress + decompress kernel (`lz`). Stresses branches and
//! memory access. Original byte-oriented format and greedy hash matcher.
//!
//! Reference (mirrored in tests). All arithmetic is wrapping u32.
//!
//! prepare(seed, size): n = size, rng = checksum::Rng::new(seed)
//!   Dictionary, 64 phrases, p = 0..63 in order:
//!     len_p = 8 + rng.next_u32() % 57                      (8..=64)
//!     then len_p bytes, each 32 + rng.next_u32() % 95      (printable ASCII)
//!   Input, pos = 0, while pos < n:
//!     r = rng.next_u32()
//!     if r % 2 == 0: copy phrase (r >> 8) % 64, truncated at n
//!     else: k = 1 + (r >> 8) % 16; then k times, while pos < n:
//!           byte = rng.next_u32() & 0xFF (stop drawing once pos reaches n)
//!
//! Compressed format, a sequence of tokens:
//!   t < 0x80   literal run: t + 1 raw bytes follow (1..=128)
//!   t >= 0x80  match: len = (t & 0x7F) + 4 (4..=131), then offset as u16
//!              little-endian (1..=65535); copy len bytes from out[pos - off]
//!              one byte at a time (overlap allowed)
//!
//! Compressor (greedy, deterministic):
//!   table = 65536 u32 entries, all 0 (0 = empty, else position + 1)
//!   i = 0, lit = 0
//!   while i + 4 <= n:
//!     v = input[i..i+4] as little-endian u32
//!     h = (v * 0x9E3779B1) >> 16
//!     cand = table[h]; table[h] = i + 1
//!     if cand != 0 and i - (cand - 1) <= 65535 and input[cand-1..cand+3] == input[i..i+4]:
//!       c = cand - 1, len = 4
//!       while len < 131 and i + len < n and input[c + len] == input[i + len]: len += 1
//!       flush literals [lit, i)
//!       emit 0x80 | (len - 4), (i - c) & 0xFF, (i - c) >> 8
//!       i += len, lit = i          (positions inside the match are not hashed)
//!     else: i += 1
//!   flush literals [lit, n)
//!   flush [a, b): while a < b: k = min(128, b - a); emit k - 1, input[a..a+k]; a += k
//!
//! run(): compress input -> comp (length clen), decompress comp -> out.
//!   acc = fold(0x811C9DC5, clen)         (fold(acc, v) = (acc ^ v) * 0x01000193)
//!   if out != input (length or any byte): return fold(acc, 0xDEADBEEF)
//!   for j = 0, 1024, 2048, ... < clen: acc = fold(acc, comp[j])
//!   return acc
//!
//! Work: `size` input bytes go through the compressor once and come out of the
//! decompressor once (plus one compare). Worst case clen <= n + n/128 + 1.

use crate::arena;
use crate::checksum::{Rng, START, fold};
use crate::global::Global;

const HASH_BITS: u32 = 16;
const MAX_OFF: usize = 65_535;
const MIN_MATCH: usize = 4;
const MAX_MATCH: usize = 131;
const MAX_LIT: usize = 128;

struct State {
    input: &'static mut [u8],
    comp: &'static mut [u8],
    out: &'static mut [u8],
    table: &'static mut [u32],
}

static STATE: Global<State> = Global::new(State {
    input: &mut [],
    comp: &mut [],
    out: &mut [],
    table: &mut [],
});

#[unsafe(no_mangle)]
pub extern "C" fn lz_prepare(seed: u32, size: u32) -> u32 {
    arena::reset();
    let n = size as usize;
    let (Some(input), Some(comp), Some(out), Some(table)) = (
        arena::alloc_slice::<u8>(n),
        arena::alloc_slice::<u8>(n + n / MAX_LIT + 16),
        arena::alloc_slice::<u8>(n),
        arena::alloc_slice::<u32>(1 << HASH_BITS),
    ) else {
        return 1;
    };

    let mut rng = Rng::new(seed);
    let mut dict = [[0u8; 64]; 64];
    let mut dict_len = [0usize; 64];
    for (phrase, len) in dict.iter_mut().zip(dict_len.iter_mut()) {
        *len = 8 + (rng.next_u32() % 57) as usize;
        for b in phrase.iter_mut().take(*len) {
            *b = (32 + rng.next_u32() % 95) as u8;
        }
    }
    let mut pos = 0;
    while pos < n {
        let r = rng.next_u32();
        if r.is_multiple_of(2) {
            let p = ((r >> 8) % 64) as usize;
            let k = dict_len[p].min(n - pos);
            input[pos..pos + k].copy_from_slice(&dict[p][..k]);
            pos += k;
        } else {
            let k = 1 + ((r >> 8) % 16) as usize;
            for _ in 0..k {
                if pos >= n {
                    break;
                }
                input[pos] = rng.next_u32() as u8;
                pos += 1;
            }
        }
    }

    // SAFETY: single-threaded instance; no other reference is alive.
    let s = unsafe { STATE.get() };
    s.input = input;
    s.comp = comp;
    s.out = out;
    s.table = table;
    0
}

#[inline(always)]
fn read_u32(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

#[inline(always)]
fn flush_literals(input: &[u8], mut a: usize, b: usize, comp: &mut [u8], mut o: usize) -> usize {
    while a < b {
        let k = (b - a).min(MAX_LIT);
        comp[o] = (k - 1) as u8;
        comp[o + 1..o + 1 + k].copy_from_slice(&input[a..a + k]);
        o += 1 + k;
        a += k;
    }
    o
}

fn compress(input: &[u8], comp: &mut [u8], table: &mut [u32]) -> usize {
    table.fill(0);
    let n = input.len();
    let mut i = 0;
    let mut lit = 0;
    let mut o = 0;
    while i + MIN_MATCH <= n {
        let v = read_u32(input, i);
        let h = (v.wrapping_mul(0x9E37_79B1) >> (32 - HASH_BITS)) as usize;
        let cand = table[h] as usize;
        table[h] = (i + 1) as u32;
        if cand != 0 && i - (cand - 1) <= MAX_OFF && read_u32(input, cand - 1) == v {
            let c = cand - 1;
            let mut len = MIN_MATCH;
            while len < MAX_MATCH && i + len < n && input[c + len] == input[i + len] {
                len += 1;
            }
            o = flush_literals(input, lit, i, comp, o);
            let off = i - c;
            comp[o] = 0x80 | (len - MIN_MATCH) as u8;
            comp[o + 1] = off as u8;
            comp[o + 2] = (off >> 8) as u8;
            o += 3;
            i += len;
            lit = i;
        } else {
            i += 1;
        }
    }
    flush_literals(input, lit, n, comp, o)
}

/// Returns the number of bytes written, or `None` on a malformed stream.
fn decompress(comp: &[u8], out: &mut [u8]) -> Option<usize> {
    let mut r = 0;
    let mut d = 0;
    while r < comp.len() {
        let t = comp[r] as usize;
        if t < 0x80 {
            let k = t + 1;
            out.get_mut(d..d + k)?
                .copy_from_slice(comp.get(r + 1..r + 1 + k)?);
            r += 1 + k;
            d += k;
        } else {
            let len = (t & 0x7F) + MIN_MATCH;
            let off = *comp.get(r + 1)? as usize | (*comp.get(r + 2)? as usize) << 8;
            r += 3;
            if off == 0 || off > d || d + len > out.len() {
                return None;
            }
            let src = d - off;
            if off >= len {
                out.copy_within(src..src + len, d);
            } else {
                for k in 0..len {
                    out[d + k] = out[src + k];
                }
            }
            d += len;
        }
    }
    Some(d)
}

#[unsafe(no_mangle)]
pub extern "C" fn lz_run() -> u32 {
    // SAFETY: as above.
    let s = unsafe { STATE.get() };
    let clen = compress(s.input, s.comp, s.table);
    let comp = &s.comp[..clen];
    let acc = fold(START, clen as u32);
    let n = s.input.len();
    match decompress(comp, s.out) {
        Some(d) if d == n && s.out[..] == s.input[..] => {}
        _ => return fold(acc, 0xDEAD_BEEF),
    }
    comp.iter()
        .step_by(1024)
        .fold(acc, |a, &b| fold(a, b as u32))
}
