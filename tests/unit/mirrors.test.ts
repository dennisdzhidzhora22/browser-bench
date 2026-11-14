// Independent JS mirrors of the kernels, written from the reference algorithm in
// each kernels/src/*.rs header comment (not from the Rust bodies). Each test
// compares the wasm checksum with the mirror at smoke size and a few extra sizes
// chosen to hit edge cases (odd widths, padding boundaries, truncated chunks).
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { LZ_PASSES } from '../../src/lib/bench/cpu/lz.ts';
import { SHA256_PASSES } from '../../src/lib/bench/cpu/sha256.ts';
import {
  COPY_MT_PASSES,
  COPY_PASSES,
  FILL_PASSES,
  latencyDefs,
  latencyHops,
  memCopy,
  memCopyMulti,
  memFill,
} from '../../src/lib/bench/memory/index.ts';
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

// ───────────────────────────── trace ─────────────────────────────

type Vec = [number, number, number];
const vadd = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a: Vec, b: Vec): Vec => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const vscale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vnorm = (v: Vec): Vec => {
  const l = Math.sqrt(vdot(v, v));
  return [v[0] / l, v[1] / l, v[2] / l];
};

interface TraceSphere {
  c: Vec;
  r: number;
  albedo: Vec;
  mirror: boolean;
}
// trace.rs header "Scene", in the documented order.
const TRACE_SPHERES: TraceSphere[] = [
  { c: [0, 1, 3], r: 1.0, albedo: [0.8, 0.3, 0.3], mirror: false },
  { c: [-2.2, 0.8, 4], r: 0.8, albedo: [0.3, 0.8, 0.3], mirror: false },
  { c: [2.1, 1, 3.5], r: 1.0, albedo: [0.9, 0.9, 0.9], mirror: true },
  { c: [0.6, 0.35, 1.6], r: 0.35, albedo: [0.3, 0.4, 0.9], mirror: false },
];
const TRACE_PLANE_ALBEDO: Vec = [0.6, 0.6, 0.6];
const TRACE_SPP = 4;
const TRACE_DEPTH = 4;
const TRACE_EPS = 1e-4;

function traceSky(d: Vec): Vec {
  const t = 0.5 * (d[1] + 1.0);
  return [(1.0 - t) + t * 0.5, (1.0 - t) + t * 0.7, (1.0 - t) + t * 1.0];
}

function traceRadiance(o0: Vec, d0: Vec, rng: Rng): Vec {
  let o = o0;
  let d = d0;
  let thr: Vec = [1, 1, 1];
  for (let bounce = 0; bounce < TRACE_DEPTH; bounce++) {
    let best = 1e30;
    let hit = -1; // 0..3 sphere, 4 plane, -1 none
    for (let i = 0; i < TRACE_SPHERES.length; i++) {
      const s = TRACE_SPHERES[i]!;
      const oc = vsub(o, s.c);
      const b = vdot(oc, d);
      const c = vdot(oc, oc) - s.r * s.r;
      const disc = b * b - c;
      if (disc > 0) {
        const q = Math.sqrt(disc);
        let t = -b - q;
        if (t < TRACE_EPS) t = -b + q;
        if (t > TRACE_EPS && t < best) {
          best = t;
          hit = i;
        }
      }
    }
    if (d[1] < -1e-9) {
      const t = -o[1] / d[1];
      if (t > TRACE_EPS && t < best) {
        best = t;
        hit = 4;
      }
    }
    if (hit === -1) return vmul(thr, traceSky(d));
    const p = vadd(o, vscale(d, best));
    let n: Vec;
    let albedo: Vec;
    let mirror = false;
    if (hit === 4) {
      n = [0, 1, 0];
      albedo = TRACE_PLANE_ALBEDO;
    } else {
      const s = TRACE_SPHERES[hit]!;
      n = [(p[0] - s.c[0]) / s.r, (p[1] - s.c[1]) / s.r, (p[2] - s.c[2]) / s.r];
      albedo = s.albedo;
      mirror = s.mirror;
    }
    thr = vmul(thr, albedo);
    if (mirror) {
      d = vsub(d, vscale(n, 2.0 * vdot(d, n)));
    } else {
      let x: number;
      let y: number;
      let z: number;
      for (;;) {
        x = 2.0 * rng.nextF64() - 1.0;
        y = 2.0 * rng.nextF64() - 1.0;
        z = 2.0 * rng.nextF64() - 1.0;
        const l2 = x * x + y * y + z * z;
        if (l2 < 1.0 && l2 > 1e-6) break;
      }
      d = vnorm(vadd(n, [x, y, z]));
    }
    o = p;
  }
  return [0, 0, 0];
}

/** trace.rs header: run() over W x H pixels, SPP samples, quantised per channel. */
function traceMirror(seed: number, w: number): number {
  const h = Math.floor((w * 3) / 4);
  let acc = START;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) >>> 0;
      let hs = (seed ^ Math.imul(idx, 0x9e3779b1)) >>> 0;
      hs = (hs ^ (hs >>> 16)) >>> 0;
      hs = Math.imul(hs, 0x85ebca6b) >>> 0;
      hs = (hs ^ (hs >>> 13)) >>> 0;
      const rng = new Rng(hs);
      let col: Vec = [0, 0, 0];
      for (let s = 0; s < TRACE_SPP; s++) {
        const u = rng.nextF64();
        const v = rng.nextF64();
        const sx = ((px + u) / w) * 2.0 - 1.0;
        const sy = 1.0 - ((py + v) / h) * 2.0;
        col = vadd(col, traceRadiance([0, 1, -2], vnorm([sx, sy * 0.75, 1.5]), rng));
      }
      for (const c of col) {
        const m = c * 0.25;
        const q = m >= 1.0 ? 255 : Math.trunc(Math.sqrt(m) * 255.0) >>> 0;
        acc = fold(acc, q);
      }
    }
  }
  return acc;
}

describe('trace mirror', () => {
  const d = def('trace');
  it('the def agrees with the header: smoke width 16, SPP 4 in the work formula', () => {
    expect(d.sizes.smoke).toBe(16);
    expect(d.work(16)).toBe((16 * 12 * 4) / 1e3);
  });
  it('reproduces expected.smoke', () => {
    expect(traceMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  it('matches the smoke size with seed 1', () => {
    expect(wasmChecksum('trace', 1, 16)).toBe(traceMirror(1, 16));
  });
  // Multiples of 4: the minimum (4 x 3), small odd heights (20 x 15), non-power-of-two and a larger one.
  it.each([4, 8, 20, 36, 64])('matches at width %i', (size) => {
    expect(wasmChecksum('trace', d.seed, size)).toBe(traceMirror(d.seed, size));
  });
  it('matches for other seeds, including 0 (replaced by the Rng zero fallback)', () => {
    for (const seed of [0, 2, 0xdeadbeef]) {
      expect(wasmChecksum('trace', seed, 24)).toBe(traceMirror(seed, 24));
    }
  });
  it('rejects sizes that are zero or not a multiple of 4 (status 2)', () => {
    const k = mod.kernel('trace');
    for (const size of [0, 1, 2, 3, 5, 18]) expect(k.prepare(1, size), `size ${size}`).toBe(2);
  });
});

// ─────────────────────── memory: fill, copy, latency ───────────────────────
// Mirrors written from the kernels/src/mem.rs header only.

const MEM_MB = 1 << 20;

/** mem_fill header: per pass set every byte to (seed + p) & 0xFF, fold buf[0], buf[size/2], buf[size-1]. */
function fillMirror(seed: number, size: number): number {
  const buf = new Uint8Array(size);
  let acc = START;
  for (let p = 0; p < FILL_PASSES; p++) {
    const v = ((seed >>> 0) + p) & 0xff; // low byte of the wrapping u32 sum
    buf.fill(v);
    acc = fold(acc, buf[0]!);
    acc = fold(acc, buf[Math.floor(size / 2)]!);
    acc = fold(acc, buf[size - 1]!);
  }
  return fold(acc, size);
}

/**
 * mem_copy / mem_copy_mt header: src = sha256-style buffer; per pass copy src -> dst and fold
 * dst[(p * 4099) % size]. `passes` is COPY_PASSES (mem_copy) or COPY_MT_PASSES (mem_copy_mt).
 */
function copyMirror(seed: number, size: number, passes: number = COPY_PASSES): number {
  const src = sha256Buffer(seed, size);
  const dst = Buffer.alloc(size);
  let acc = START;
  for (let p = 0; p < passes; p++) {
    src.copy(dst);
    acc = fold(acc, dst[(p * 4099) % size]!);
  }
  return fold(fold(acc, dst[size - 1]!), size);
}

/**
 * mem_latency header: Sattolo shuffle (j = next_u32() % i, i from n-1 down to 1), then
 * link order[i] -> order[i + 1] (wrapping). Returns next[line] as a LINE INDEX; the kernel stores
 * base + 64 * next[line] in word 0 of the line (checked against wasm memory below).
 */
function latencyNext(seed: number, bytes: number): Uint32Array {
  const n = bytes / 64;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const rng = new Rng(seed);
  for (let i = n - 1; i >= 1; i--) {
    const j = rng.nextU32() % i;
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  const next = new Uint32Array(n);
  for (let i = 0; i < n; i++) next[order[i]!] = order[(i + 1) % n]!;
  return next;
}

/** Line index reached after `steps` hops from line 0. */
function walk(next: Uint32Array, steps: number): number {
  let idx = 0;
  for (let h = 0; h < steps; h++) idx = next[idx]!;
  return idx;
}

/**
 * mem_latency run(): the line reached after hops(size) hops from line 0, as an index.
 * The chain is one cycle of n lines (checked below), so hops(size) hops land where
 * hops(size) mod n hops do; that keeps the 2^28-hop sizes fast. `fullWalk` does every hop.
 */
function latencyMirror(seed: number, bytes: number, fullWalk = false): number {
  const next = latencyNext(seed, bytes);
  const hops = latencyHops(bytes);
  return walk(next, fullWalk ? hops : hops % (bytes / 64));
}

/** True when walking from line 0 visits every line once and returns to 0 after exactly n steps. */
function isSingleCycle(next: ArrayLike<number>, n: number): boolean {
  const seen = new Uint8Array(n);
  let idx = 0;
  for (let step = 1; step <= n; step++) {
    idx = next[idx]!;
    if (idx >= n) return false;
    if (idx === 0) return step === n; // back at the start: only fine on the last step
    if (seen[idx]) return false;
    seen[idx] = 1;
  }
  return false; // never returned to 0
}

const memSeeds = [0, 1, 2, 3, 42, 0xdeadbeef, 0xffffffff];

describe('mem_fill mirror', () => {
  it('the def agrees with the header: FILL_PASSES = 20, work = size x passes', () => {
    expect(FILL_PASSES).toBe(20);
    expect(memFill.work(1e9)).toBe(20);
  });
  it('reproduces expected.smoke', () => {
    expect(fillMirror(memFill.seed, memFill.sizes.smoke)).toBe(memFill.expected.smoke);
  });
  // 1: buf[0], buf[size/2] and buf[size-1] are the same byte; 2, 3: size/2 rounds down.
  it.each([1, 2, 3, 4, 5, 1000, 4096, 65_537])('matches at size %i', (size) => {
    expect(wasmChecksum('mem_fill', memFill.seed, size)).toBe(fillMirror(memFill.seed, size));
  });
  // 255, 256: the & 0xFF wrap; 0xFFFFFFF0 and 0xFFFFFFFF: seed + p wraps past u32::MAX.
  it.each([0, 1, 2, 255, 256, 257, 0xfffffff0, 0xffffffff])('matches for seed %i', (seed) => {
    expect(wasmChecksum('mem_fill', seed, 4096)).toBe(fillMirror(seed, 4096));
  });
  it('the checksum depends on the seed only through (seed + p) & 0xFF', () => {
    expect(fillMirror(256, 100)).toBe(fillMirror(0, 100));
    expect(fillMirror(1, 100)).not.toBe(fillMirror(0, 100));
  });
});

describe('mem_copy and mem_copy_mt mirrors', () => {
  it('the defs agree with the header: 48 and 2 passes, work = size x passes', () => {
    expect(COPY_PASSES).toBe(48);
    expect(COPY_MT_PASSES).toBe(2);
    expect(memCopy.work(1e9)).toBe(48);
    expect(memCopyMulti.work(1e9)).toBe(2);
  });
  it('mem_copy reproduces expected.smoke (the same buffer generator as sha256)', () => {
    expect(copyMirror(memCopy.seed, memCopy.sizes.smoke, COPY_PASSES)).toBe(memCopy.expected.smoke);
  });
  it('mem_copy_mt reproduces expected.smoke and the 16 MB multi expectation', () => {
    expect(copyMirror(memCopyMulti.seed, memCopyMulti.sizes.smoke, COPY_MT_PASSES)).toBe(memCopyMulti.expected.smoke);
    expect(copyMirror(memCopyMulti.seed, memCopyMulti.multi!.size, COPY_MT_PASSES)).toBe(
      memCopyMulti.multi!.expected,
    );
  });
  // 1, 2, 3, 5, 7: truncated final chunk and size < 4099 (index wraps); 4099, 4100: modulus boundary.
  const sizes = [1, 2, 3, 4, 5, 7, 100, 1000, 4098, 4099, 4100, 10_001, 70_000];
  it.each(sizes)('mem_copy matches at size %i', (size) => {
    expect(wasmChecksum('mem_copy', memCopy.seed, size)).toBe(copyMirror(memCopy.seed, size, COPY_PASSES));
  });
  it.each(sizes)('mem_copy_mt matches at size %i', (size) => {
    expect(wasmChecksum('mem_copy_mt', memCopy.seed, size)).toBe(copyMirror(memCopy.seed, size, COPY_MT_PASSES));
  });
  it.each(memSeeds)('both match for seed %i', (seed) => {
    expect(wasmChecksum('mem_copy', seed, 5000)).toBe(copyMirror(seed, 5000, COPY_PASSES));
    expect(wasmChecksum('mem_copy_mt', seed, 5000)).toBe(copyMirror(seed, 5000, COPY_MT_PASSES));
  });
  it('the pass count matters: the two kernels differ at the same seed and size', () => {
    expect(copyMirror(1, 5000, COPY_PASSES)).not.toBe(copyMirror(1, 5000, COPY_MT_PASSES));
  });
});

describe('mem_latency mirror', () => {
  it('reproduces expected.smoke (every hop: 64 lines x 16 + 7 hops below 16 KiB)', () => {
    const d = latencyDefs[0]!;
    expect(latencyMirror(d.seed, d.sizes.smoke, true)).toBe(d.expected.smoke);
    expect(latencyMirror(d.seed, d.sizes.smoke)).toBe(d.expected.smoke);
  });
  it('the hops % n shortcut equals a full walk (2^25 + 7 hops at 64 KB, 2^26 + 7 at 16 KB)', { timeout: 60_000 }, () => {
    expect(latencyMirror(1, 64 * 1024, true)).toBe(latencyMirror(1, 64 * 1024));
    expect(latencyMirror(2, 16 * 1024, true)).toBe(latencyMirror(2, 16 * 1024));
  });
  // Every real size up to 16 MB (the larger ones run in the BENCH_STANDARD block).
  it.each(latencyDefs.filter((d) => d.sizes.standard <= 16 * MEM_MB).map((d) => [d.variant, d] as const))(
    'reproduces expected.standard at %s bytes',
    (_v, d) => {
      expect(latencyMirror(d.seed, d.sizes.standard)).toBe(d.expected.standard);
    },
  );
  // 128 = two lines (the minimum); 192, 320 = odd line counts; 6400 = 100 lines.
  // Below 16 KiB the hop count is 16 x lines + 7 (tests only), so these runs are tiny.
  it.each([128, 192, 256, 320, 1024, 4096, 6400])('matches the wasm kernel at %i bytes, several seeds', { timeout: 60_000 }, (bytes) => {
    for (const seed of memSeeds) {
      expect(wasmChecksum('mem_latency', seed, bytes), `seed ${seed}`).toBe(latencyMirror(seed, bytes));
    }
  });
  // The edge of each hop-count tier and one line above it: n is not a power of two there, so a wrong
  // tier in the kernel (or in latencyHops) changes hops mod n and therefore the checksum. At
  // power-of-two sizes two tiers can give the same checksum (hops = 2^k + 7 and n | 2^k).
  it.each([
    16 * 1024 - 64, // last size below 16 KiB: n * 16 + 7 hops
    16 * 1024,
    32 * 1024,
    32 * 1024 + 64,
    256 * 1024 + 64,
    2 * MEM_MB + 64,
    8 * MEM_MB,
    8 * MEM_MB + 64,
    12 * MEM_MB,
    24 * MEM_MB,
  ])('matches the wasm kernel at a hop tier edge, %i bytes', { timeout: 60_000 }, (bytes) => {
    expect(wasmChecksum('mem_latency', 1, bytes)).toBe(latencyMirror(1, bytes));
  });
  it('two lines: the chain is 0 -> 1 -> 0, so an odd hop count ends on line 1', () => {
    expect(Array.from(latencyNext(1, 128))).toEqual([1, 0]);
    expect(latencyHops(128) % 2).toBe(1);
    expect(wasmChecksum('mem_latency', 1, 128)).toBe(1);
  });
  it('seed 0 uses the Rng fallback like every other kernel', () => {
    expect(wasmChecksum('mem_latency', 0, 4096)).toBe(latencyMirror(0, 4096));
  });
});

describe('mem_latency chain is a single cycle through every line', () => {
  const sizes = [128, 192, 256, 320, 1024, 4096, 6400, 65_536];

  it.each(sizes)('JS mirror, %i bytes, several seeds', (bytes) => {
    const n = bytes / 64;
    for (const seed of memSeeds) {
      const next = latencyNext(seed, bytes);
      expect(isSingleCycle(next, n), `seed ${seed}`).toBe(true);
      for (let k = 0; k < n; k++) expect(next[k], `seed ${seed} line ${k} is not a fixed point`).not.toBe(k);
    }
  });

  it('JS mirror at the real sizes up to 24 MB', () => {
    for (const d of latencyDefs.filter((x) => x.sizes.standard <= 24 * MEM_MB)) {
      const n = d.sizes.standard / 64;
      expect(isSingleCycle(latencyNext(d.seed, d.sizes.standard), n), d.variant).toBe(true);
    }
  });

  // White box: the wasm chain itself. Word 0 of line k holds the byte ADDRESS of word 0 of the next
  // line: base + 64 * next (header), base = address of line 0. On a fresh instance the arena starts
  // at the initial memory size, 16-aligned, and the chain is the first allocation (kernels/src/
  // arena.rs, mem.rs). A layout change would break this test, not the kernel.
  it.each(sizes)('the wasm chain in memory, %i bytes: absolute addresses, equals the mirror, one cycle', async (bytes) => {
    const n = bytes / 64;
    for (const seed of [1, 2, 0xdeadbeef]) {
      const m = await loadKernels();
      const base = (m.memory.buffer.byteLength + 15) & ~15;
      expect(m.kernel('mem_latency').prepare(seed, bytes)).toBe(0);
      const words = new Uint32Array(m.memory.buffer, base, n * 16);
      const wasmNext = new Uint32Array(n);
      const mirror = latencyNext(seed, bytes);
      for (let k = 0; k < n; k++) {
        const addr = words[k * 16]!;
        expect(addr, `seed ${seed} line ${k}`).toBe(base + 64 * mirror[k]!);
        expect((addr - base) % 64).toBe(0);
        wasmNext[k] = (addr - base) / 64;
      }
      expect(isSingleCycle(wasmNext, n), `seed ${seed}`).toBe(true);
      // Words 1..15 of each line are not part of the chain (header: the buffer is zeroed).
      for (let k = 0; k < n; k++) {
        for (let w = 1; w < 16; w++) expect(words[k * 16 + w], `seed ${seed} line ${k} word ${w}`).toBe(0);
      }
    }
  });
});

describe.skipIf(process.env['BENCH_STANDARD'] !== '1')('memory mirrors reproduce the standard expectations', () => {
  it('mem_fill standard', { timeout: 300_000 }, () => {
    expect(fillMirror(memFill.seed, memFill.sizes.standard)).toBe(memFill.expected.standard);
  });
  it('mem_copy standard', { timeout: 300_000 }, () => {
    expect(copyMirror(memCopy.seed, memCopy.sizes.standard, COPY_PASSES)).toBe(memCopy.expected.standard);
  });
  it.each(latencyDefs.filter((d) => d.sizes.standard > 16 * MEM_MB).map((d) => [d.variant, d] as const))(
    'mem_latency at %s bytes',
    { timeout: 300_000 },
    (_v, d) => {
      const next = latencyNext(d.seed, d.sizes.standard);
      expect(isSingleCycle(next, d.sizes.standard / 64)).toBe(true);
      expect(walk(next, latencyHops(d.sizes.standard) % (d.sizes.standard / 64))).toBe(d.expected.standard);
    },
  );
});
