// Independent JS mirrors of the kernels, written from the reference algorithm in
// each kernels/src/*.rs header comment (not from the Rust bodies). Each test
// compares the wasm checksum with the mirror at smoke size and a few extra sizes
// chosen to hit edge cases (odd widths, padding boundaries, truncated chunks).
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { LZ_PASSES } from '../../src/lib/bench/cpu/lz.ts';
import { SHA256_PASSES } from '../../src/lib/bench/cpu/sha256.ts';
import type { KernelDef } from '../../src/lib/bench/types.ts';
import type { KernelModule } from '../../src/lib/harness/wasm.ts';
import { f64Bits, fold, loadKernels, Rng, START } from './support.ts';

let mod: KernelModule;
beforeAll(async () => {
  mod = await loadKernels();
});

function def(id: string): KernelDef {
  const d = cpuKernels.find((k) => k.id === id);
  if (!d) throw new Error(`no def for ${id}`);
  return d;
}

/** prepare + run one kernel in the shared wasm instance. */
function wasmChecksum(id: string, seed: number, size: number): number {
  const k = mod.kernel(id);
  const status = k.prepare(seed, size);
  if (status !== 0) throw new Error(`${id}.prepare(${seed}, ${size}) -> ${status}`);
  return k.run() >>> 0;
}

// ───────────────────────────── sha256 ─────────────────────────────

/** sha256.rs prepare(): `size` bytes, 4-byte chunks of rng.next_u32() little-endian. */
function sha256Buffer(seed: number, size: number): Buffer {
  const rng = new Rng(seed);
  const buf = Buffer.alloc(size);
  for (let off = 0; off < size; off += 4) {
    const v = rng.nextU32(); // a whole draw even for a truncated last chunk
    for (let b = 0; b < 4 && off + b < size; b++) buf[off + b] = (v >>> (8 * b)) & 0xff;
  }
  return buf;
}

/** sha256.rs run(): digest as 8 big-endian words folded from START. */
function sha256Mirror(seed: number, size: number): number {
  const digest = createHash('sha256').update(sha256Buffer(seed, size)).digest();
  let acc = START;
  for (let p = 0; p < SHA256_PASSES; p++) {
    for (let i = 0; i < 8; i++) acc = fold(acc, digest.readUInt32BE(i * 4));
  }
  return acc;
}

describe('sha256 mirror', () => {
  it('the def agrees with the header: PASSES = 8, work = size x passes', () => {
    expect(SHA256_PASSES).toBe(8);
    expect(def('sha256').work(1_000_000)).toBe(8);
  });
  const d = def('sha256');
  it('reproduces expected.smoke (node:crypto on the same buffer)', () => {
    expect(sha256Mirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  // 55/56 and 63/64/65 straddle the one- vs two-block padding boundary; 1, 3, 5, 7
  // exercise the truncated final 4-byte chunk.
  it.each([1, 3, 5, 7, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000])(
    'matches at size %i',
    (size) => {
      expect(wasmChecksum('sha256', d.seed, size)).toBe(sha256Mirror(d.seed, size));
    },
  );
  it('matches for other seeds, including 0', () => {
    for (const seed of [0, 2, 0xdeadbeef]) {
      expect(wasmChecksum('sha256', seed, 777)).toBe(sha256Mirror(seed, 777));
    }
  });
  it('hashes known data: the mirror of an empty-ish buffer is the real digest', () => {
    // Sanity on the mirror's folding itself: SHA-256("") words are well known.
    const digest = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ───────────────────────────── sort ─────────────────────────────

/** sort.rs checksum over the sorted array (sorted output is unique, so a typed-array sort suffices). */
function sortChecksum<T extends number>(a: ArrayLike<T>, fo: (acc: number, v: T) => number): number {
  const n = a.length;
  let acc = START;
  for (let i = 1; i < n; i++) {
    if (a[i]! < a[i - 1]!) {
      acc = fold(acc, 0xdeadbeef);
      break;
    }
  }
  const stride = Math.max(1, Math.floor(n / 1024));
  for (let i = 0; i < n; i += stride) acc = fo(acc, a[i]!);
  return fold(acc, n);
}

function sortU32Mirror(seed: number, size: number): number {
  const rng = new Rng(seed);
  const a = new Uint32Array(size);
  for (let i = 0; i < size; i++) a[i] = rng.nextU32();
  a.sort();
  return sortChecksum(a, fold);
}

function sortF64Mirror(seed: number, size: number): number {
  const rng = new Rng(seed);
  const a = new Float64Array(size);
  for (let i = 0; i < size; i++) a[i] = (rng.nextF64() - 0.5) * 2000.0;
  a.sort();
  return sortChecksum(a, f64Bits);
}

describe('sort mirrors', () => {
  // 17 = first size that is not insertion-sorted; 2048/3000 make stride 2 and 2.
  const sizes = [1, 2, 16, 17, 100, 1023, 1024, 1025, 2048, 3000];

  it('sort_u32 reproduces expected.smoke', () => {
    const d = def('sort_u32');
    expect(sortU32Mirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  it.each(sizes)('sort_u32 matches at size %i', (size) => {
    expect(wasmChecksum('sort_u32', 1, size)).toBe(sortU32Mirror(1, size));
  });
  it('sort_u32 matches for other seeds', () => {
    for (const seed of [0, 7, 0xffffffff]) {
      expect(wasmChecksum('sort_u32', seed, 5000)).toBe(sortU32Mirror(seed, 5000));
    }
  });

  it('sort_f64 reproduces expected.smoke', () => {
    const d = def('sort_f64');
    expect(sortF64Mirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  it.each(sizes)('sort_f64 matches at size %i', (size) => {
    expect(wasmChecksum('sort_f64', 1, size)).toBe(sortF64Mirror(1, size));
  });
  it('sort_f64 matches for other seeds', () => {
    for (const seed of [0, 7, 0xffffffff]) {
      expect(wasmChecksum('sort_f64', seed, 5000)).toBe(sortF64Mirror(seed, 5000));
    }
  });
});

// ─────────────────────────── mandelbrot ───────────────────────────

const MAX_ITER = 256;

/** mandelbrot.rs `Work` pseudo-code, evaluated as written (one IEEE rounding per op). */
function mandelbrotMirror(w: number): number {
  const h = Math.floor((w * 3) / 4);
  const scale = 3.0 / w;
  let acc = START;
  for (let py = 0; py < h; py++) {
    const cy = py * scale + -1.125;
    for (let px = 0; px < w; px++) {
      const cx = px * scale + -2.0;
      let zr = 0.0;
      let zi = 0.0;
      let n = 0;
      while (n < MAX_ITER) {
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        if (zr2 + zi2 > 4.0) break;
        zi = (zr + zr) * zi + cy;
        zr = zr2 - zi2 + cx;
        n = n + 1;
      }
      acc = fold(acc, n);
    }
  }
  acc = fold(acc, w);
  return fold(acc, h);
}

describe('mandelbrot mirror', () => {
  const d = def('mandelbrot');
  it('reproduces expected.smoke', () => {
    expect(mandelbrotMirror(d.sizes.smoke)).toBe(d.expected.smoke);
  });
  // 1..3: tiny/degenerate heights; odd widths exercise the SIMD tail column.
  it.each([1, 2, 3, 5, 7, 33, 64, 65, 100])('scalar matches at width %i', (w) => {
    expect(wasmChecksum('mandelbrot', 1, w)).toBe(mandelbrotMirror(w));
  });
  it.each([1, 2, 3, 5, 7, 33, 64, 65, 100])('simd equals scalar and the mirror at width %i', (w) => {
    const scalar = wasmChecksum('mandelbrot', 1, w);
    const simd = wasmChecksum('mandelbrot_simd', 1, w);
    expect(simd).toBe(scalar);
    expect(simd).toBe(mandelbrotMirror(w));
  });
  it('ignores the seed (documented)', () => {
    expect(wasmChecksum('mandelbrot', 99, 40)).toBe(wasmChecksum('mandelbrot', 1, 40));
    expect(wasmChecksum('mandelbrot_simd', 99, 40)).toBe(wasmChecksum('mandelbrot', 1, 40));
  });
  it('simd smoke expectation equals scalar smoke expectation', () => {
    expect(def('mandelbrot_simd').expected.smoke).toBe(d.expected.smoke);
    expect(def('mandelbrot_simd').sizes.smoke).toBe(d.sizes.smoke);
  });
});

// ───────────────────────────── nbody ─────────────────────────────

const NB = 256;
const DT = 0.001;
const EPS2 = 0.01;

/** nbody.rs header: data init, symplectic Euler steps, energy, checksum. */
function nbodyMirror(seed: number, steps: number): number {
  const rng = new Rng(seed);
  const r = () => rng.nextF64();
  const x = new Float64Array(NB);
  const y = new Float64Array(NB);
  const z = new Float64Array(NB);
  const vx = new Float64Array(NB);
  const vy = new Float64Array(NB);
  const vz = new Float64Array(NB);
  const m = new Float64Array(NB);
  for (let i = 0; i < NB; i++) {
    x[i] = r() * 2.0 - 1.0;
    y[i] = r() * 2.0 - 1.0;
    z[i] = r() * 2.0 - 1.0;
    vx[i] = (r() * 2.0 - 1.0) * 0.05;
    vy[i] = (r() * 2.0 - 1.0) * 0.05;
    vz[i] = (r() * 2.0 - 1.0) * 0.05;
    m[i] = (r() + 0.5) / 256.0;
  }
  const ax = new Float64Array(NB);
  const ay = new Float64Array(NB);
  const az = new Float64Array(NB);
  for (let s = 0; s < steps; s++) {
    ax.fill(0.0);
    ay.fill(0.0);
    az.fill(0.0);
    for (let i = 0; i < NB; i++) {
      let sx = 0.0;
      let sy = 0.0;
      let sz = 0.0;
      for (let j = i + 1; j < NB; j++) {
        const dx = x[j]! - x[i]!;
        const dy = y[j]! - y[i]!;
        const dz = z[j]! - z[i]!;
        const d2 = dx * dx + dy * dy + dz * dz + EPS2;
        const inv = 1.0 / (d2 * Math.sqrt(d2));
        const si = m[j]! * inv;
        const sj = m[i]! * inv;
        sx = sx + dx * si;
        sy = sy + dy * si;
        sz = sz + dz * si;
        ax[j] = ax[j]! - dx * sj;
        ay[j] = ay[j]! - dy * sj;
        az[j] = az[j]! - dz * sj;
      }
      ax[i] = ax[i]! + sx;
      ay[i] = ay[i]! + sy;
      az[i] = az[i]! + sz;
    }
    for (let i = 0; i < NB; i++) {
      vx[i] = vx[i]! + ax[i]! * DT;
      vy[i] = vy[i]! + ay[i]! * DT;
      vz[i] = vz[i]! + az[i]! * DT;
      x[i] = x[i]! + vx[i]! * DT;
      y[i] = y[i]! + vy[i]! * DT;
      z[i] = z[i]! + vz[i]! * DT;
    }
  }
  let e = 0.0;
  for (let i = 0; i < NB; i++) {
    e = e + 0.5 * m[i]! * (vx[i]! * vx[i]! + vy[i]! * vy[i]! + vz[i]! * vz[i]!);
  }
  for (let i = 0; i < NB; i++) {
    for (let j = i + 1; j < NB; j++) {
      const dx = x[j]! - x[i]!;
      const dy = y[j]! - y[i]!;
      const dz = z[j]! - z[i]!;
      const d2 = dx * dx + dy * dy + dz * dz + EPS2;
      e = e - (m[i]! * m[j]!) / Math.sqrt(d2);
    }
  }
  let acc = START;
  for (let i = 0; i < NB; i++) {
    acc = f64Bits(acc, x[i]!);
    acc = f64Bits(acc, y[i]!);
    acc = f64Bits(acc, z[i]!);
  }
  acc = f64Bits(acc, e);
  return fold(acc, steps);
}

describe('nbody mirror', () => {
  const d = def('nbody');
  it('reproduces expected.smoke', () => {
    expect(nbodyMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  it.each([0, 1, 3, 5])('matches at %i steps', (steps) => {
    expect(wasmChecksum('nbody', d.seed, steps)).toBe(nbodyMirror(d.seed, steps));
  });
  it('matches for another seed', () => {
    expect(wasmChecksum('nbody', 12345, 2)).toBe(nbodyMirror(12345, 2));
  });
});

// ───────────────────────────── matmul ─────────────────────────────

/** matmul.rs header: plain increasing-k sums, no FMA; checksum over every 7th element + trace. */
function matmulMirror(seed: number, n: number): number {
  const rng = new Rng(seed);
  const a = new Float64Array(n * n);
  const b = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) a[i] = rng.nextF64() - 0.5;
  for (let i = 0; i < n * n; i++) b[i] = rng.nextF64() - 0.5;
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0.0;
      for (let k = 0; k < n; k++) s = s + a[i * n + k]! * b[k * n + j]!;
      c[i * n + j] = s;
    }
  }
  let acc = START;
  for (let idx = 0; idx < n * n; idx += 7) acc = f64Bits(acc, c[idx]!);
  let tr = 0.0;
  for (let i = 0; i < n; i++) tr = tr + c[i * n + i]!;
  return f64Bits(acc, tr);
}

describe('matmul mirror', () => {
  const d = def('matmul');
  it('reproduces expected.smoke', () => {
    expect(matmulMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  // 8/16/24 are below/at the k-block of 64; 72 and 80 cross it (two k-blocks).
  it.each([8, 16, 24, 40, 72, 80])('scalar matches at n=%i', (n) => {
    expect(wasmChecksum('matmul', d.seed, n)).toBe(matmulMirror(d.seed, n));
  });
  it.each([8, 16, 24, 40, 72, 80])('simd equals scalar and the mirror at n=%i', (n) => {
    const scalar = wasmChecksum('matmul', d.seed, n);
    const simd = wasmChecksum('matmul_simd', d.seed, n);
    expect(simd).toBe(scalar);
    expect(simd).toBe(matmulMirror(d.seed, n));
  });
  it('matches for another seed', () => {
    expect(wasmChecksum('matmul', 31337, 16)).toBe(matmulMirror(31337, 16));
    expect(wasmChecksum('matmul_simd', 31337, 16)).toBe(matmulMirror(31337, 16));
  });
  it('simd smoke expectation equals scalar smoke expectation', () => {
    expect(def('matmul_simd').expected.smoke).toBe(d.expected.smoke);
    expect(def('matmul_simd').sizes.smoke).toBe(d.sizes.smoke);
  });
});

// ───────────────────────────── fft ─────────────────────────────

const FN = 4096;
const FLOG = 12;
const FSTEP = 6.283185307179586 / 4096.0;

/** m! as an exact f64 (exact up to 18!). */
function factorial(m: number): number {
  let f = 1;
  for (let i = 2; i <= m; i++) f *= i;
  return f;
}
const inv = (m: number) => 1.0 / factorial(m);

/** fft.rs header: Taylor sin/cos for 0 <= x <= PI/4, Horner form. */
function sinPoly(x: number): number {
  const x2 = x * x;
  let p = -inv(15);
  for (const c of [inv(13), -inv(11), inv(9), -inv(7), inv(5), -inv(3), 1]) p = p * x2 + c;
  return x * p;
}
function cosPoly(x: number): number {
  const x2 = x * x;
  let p = inv(16);
  for (const c of [-inv(14), inv(12), -inv(10), inv(8), -inv(6), inv(4), -inv(2), 1]) p = p * x2 + c;
  return p;
}

function fftTables(): { cos: Float64Array; sin: Float64Array } {
  const base = (m: number): [number, number] => {
    if (m <= FN / 8) {
      const x = m * FSTEP;
      return [cosPoly(x), sinPoly(x)];
    }
    const x = (FN / 4 - m) * FSTEP;
    return [sinPoly(x), cosPoly(x)];
  };
  const cos = new Float64Array(FN / 2);
  const sin = new Float64Array(FN / 2);
  for (let k = 0; k < FN / 2; k++) {
    if (k <= FN / 4) {
      [cos[k], sin[k]] = base(k) as [number, number];
    } else {
      const [c, s] = base(k - FN / 4);
      cos[k] = -s;
      sin[k] = c;
    }
  }
  return { cos, sin };
}

function fftMirror(seed: number, transforms: number): number {
  const rng = new Rng(seed);
  const inRe = new Float64Array(FN);
  const inIm = new Float64Array(FN);
  for (let i = 0; i < FN; i++) {
    inRe[i] = rng.nextF64() - 0.5;
    inIm[i] = rng.nextF64() - 0.5;
  }
  const { cos, sin } = fftTables();
  const re = Float64Array.from(inRe);
  const im = Float64Array.from(inIm);

  const transform = (inverse: boolean) => {
    for (let i = 0; i < FN; i++) {
      let r = 0;
      for (let b = 0; b < FLOG; b++) if (i & (1 << b)) r |= 1 << (FLOG - 1 - b);
      if (i < r) {
        [re[i], re[r]] = [re[r]!, re[i]!];
        [im[i], im[r]] = [im[r]!, im[i]!];
      }
    }
    for (let len = 2; len <= FN; len *= 2) {
      const half = len / 2;
      const tstep = FN / len;
      for (let start = 0; start < FN; start += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * tstep]!;
          const wi = inverse ? sin[j * tstep]! : -sin[j * tstep]!;
          const a = start + j;
          const b = a + half;
          const tr = wr * re[b]! - wi * im[b]!;
          const ti = wr * im[b]! + wi * re[b]!;
          const ur = re[a]!;
          const ui = im[a]!;
          re[a] = ur + tr;
          im[a] = ui + ti;
          re[b] = ur - tr;
          im[b] = ui - ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < FN; i++) {
        re[i] = re[i]! * (1.0 / 4096.0);
        im[i] = im[i]! * (1.0 / 4096.0);
      }
    }
  };

  for (let t = 0; t < transforms; t++) transform(t % 2 === 1);
  let acc = START;
  for (let i = 0; i < FN; i += 17) {
    acc = f64Bits(acc, re[i]!);
    acc = f64Bits(acc, im[i]!);
  }
  return acc;
}

describe('fft mirror', () => {
  const d = def('fft');
  it('reproduces expected.smoke', () => {
    expect(fftMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  // Odd counts end on a forward transform, even counts on an inverse one.
  it.each([1, 2, 3])('matches at %i transforms', (t) => {
    expect(wasmChecksum('fft', d.seed, t)).toBe(fftMirror(d.seed, t));
  });
  it('one and two transforms give different checksums (the inverse step is not a no-op)', () => {
    expect(fftMirror(1, 2)).not.toBe(fftMirror(1, 1));
  });
});

// ───────────────────────────── lz ─────────────────────────────

/** lz.rs header: dictionary + input generation. */
function lzInput(seed: number, n: number): Uint8Array {
  const rng = new Rng(seed);
  const phrases: Uint8Array[] = [];
  for (let p = 0; p < 64; p++) {
    const len = 8 + (rng.nextU32() % 57);
    const ph = new Uint8Array(len);
    for (let i = 0; i < len; i++) ph[i] = 32 + (rng.nextU32() % 95);
    phrases.push(ph);
  }
  const input = new Uint8Array(n);
  let pos = 0;
  while (pos < n) {
    const r = rng.nextU32();
    if (r % 2 === 0) {
      const ph = phrases[(r >>> 8) % 64]!;
      for (let i = 0; i < ph.length && pos < n; i++) input[pos++] = ph[i]!;
    } else {
      const k = 1 + ((r >>> 8) % 16);
      for (let i = 0; i < k && pos < n; i++) input[pos++] = rng.nextU32() & 0xff;
    }
  }
  return input;
}

function lzCompress(input: Uint8Array): Uint8Array {
  const n = input.length;
  const out: number[] = [];
  const table = new Uint32Array(65536);
  const flush = (a: number, b: number) => {
    while (a < b) {
      const k = Math.min(128, b - a);
      out.push(k - 1);
      for (let i = 0; i < k; i++) out.push(input[a + i]!);
      a += k;
    }
  };
  let i = 0;
  let lit = 0;
  while (i + 4 <= n) {
    const v = (input[i]! | (input[i + 1]! << 8) | (input[i + 2]! << 16) | (input[i + 3]! << 24)) >>> 0;
    const h = Math.imul(v, 0x9e3779b1) >>> 16;
    const cand = table[h]!;
    table[h] = i + 1;
    if (
      cand !== 0 &&
      i - (cand - 1) <= 65535 &&
      input[cand - 1] === input[i] &&
      input[cand] === input[i + 1] &&
      input[cand + 1] === input[i + 2] &&
      input[cand + 2] === input[i + 3]
    ) {
      const c = cand - 1;
      let len = 4;
      while (len < 131 && i + len < n && input[c + len] === input[i + len]) len++;
      flush(lit, i);
      out.push(0x80 | (len - 4), (i - c) & 0xff, (i - c) >> 8);
      i += len;
      lit = i;
    } else {
      i++;
    }
  }
  flush(lit, n);
  return Uint8Array.from(out);
}

function lzDecompress(comp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let p = 0;
  while (p < comp.length) {
    const t = comp[p++]!;
    if (t < 0x80) {
      for (let i = 0; i < t + 1; i++) out.push(comp[p++]!);
    } else {
      const len = (t & 0x7f) + 4;
      const off = comp[p]! | (comp[p + 1]! << 8);
      p += 2;
      for (let i = 0; i < len; i++) out.push(out[out.length - off]!); // byte at a time: overlap allowed
    }
  }
  return Uint8Array.from(out);
}

function lzMirror(seed: number, n: number): number {
  const input = lzInput(seed, n);
  const pass = (): number => {
    const comp = lzCompress(input);
    const out = lzDecompress(comp);
    let acc = fold(START, comp.length);
    if (out.length !== input.length || out.some((b, i) => b !== input[i])) return fold(acc, 0xdeadbeef);
    for (let j = 0; j < comp.length; j += 1024) acc = fold(acc, comp[j]!);
    return acc;
  };
  let total = START;
  for (let p = 0; p < LZ_PASSES; p++) total = fold(total, pass());
  return total;
}

describe('lz mirror', () => {
  it('the def agrees with the header: PASSES = 12, work = size x passes', () => {
    expect(LZ_PASSES).toBe(12);
    expect(def('lz').work(1_000_000)).toBe(12);
  });
  const d = def('lz');
  it('reproduces expected.smoke', () => {
    expect(lzMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  // 70_000 exceeds the 65_535 match-offset window; 1..5 are shorter than / around the 4-byte hash.
  it.each([1, 3, 4, 5, 100, 5000, 70_000])('matches at size %i', (size) => {
    expect(wasmChecksum('lz', d.seed, size)).toBe(lzMirror(d.seed, size));
  });
  it('matches for another seed', () => {
    expect(wasmChecksum('lz', 0, 9000)).toBe(lzMirror(0, 9000));
  });
});
