import { beforeAll, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { mix, MIX_EXPECTED, MIX_SEED, MIX_SIZES } from '../../src/lib/bench/mix.ts';
import { ABI_VERSION, instantiateKernels, type KernelModule } from '../../src/lib/harness/wasm.ts';
import { loadKernels } from './support.ts';

/** Independent JS mirror of the reference algorithm in kernels/src/mix.rs. */
function mixReference(seed: number, iterations: number): number {
  let x = seed >>> 0 === 0 ? 0x9e3779b9 : seed >>> 0;
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    const rotl = ((acc << 5) | (acc >>> 27)) >>> 0;
    acc = Math.imul((rotl ^ x) >>> 0, 0x01000193) >>> 0;
  }
  return acc;
}

let mod: KernelModule;

beforeAll(async () => {
  mod = await loadKernels();
});

describe('kernels.wasm module', () => {
  it('reports the ABI version the page expects', () => {
    expect(mod.abi_version()).toBe(ABI_VERSION);
    expect(ABI_VERSION).toBe(3);
  });

  it('exports linear memory', () => {
    expect(mod.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it('rejects a module with a mismatched ABI version', async () => {
    // Minimal module exporting abi_version() -> 9999.
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // type: () -> i32
      0x03, 0x02, 0x01, 0x00, // func 0 : type 0
      0x07, 0x0f, 0x01, 0x0b, 0x61, 0x62, 0x69, 0x5f, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x00, // export
      0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0x8f, 0x4e, 0x0b, // body: i32.const 9999
    ]);
    await expect(instantiateKernels(new WebAssembly.Module(bytes))).rejects.toThrow(/ABI mismatch/);
  });

  it('rejects a module with no abi_version export', async () => {
    // Empty module: magic + version only.
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await expect(instantiateKernels(new WebAssembly.Module(bytes))).rejects.toThrow(/abi_version/);
  });

  it('throws for an unknown kernel id', () => {
    expect(() => mod.kernel('no_such_kernel')).toThrow(/not found/);
    expect(() => mod.kernel('')).toThrow(/not found/);
    // Only the exact `<id>_prepare` / `<id>_run` pair counts.
    expect(() => mod.kernel('abi_version')).toThrow(/not found/);
  });

  it('exposes prepare and run for every CPU kernel plus mix', () => {
    for (const id of [...cpuKernels.map((k) => k.id), mix.id]) {
      const k = mod.kernel(id);
      expect(typeof k.prepare, id).toBe('function');
      expect(typeof k.run, id).toBe('function');
    }
  });
});

describe('mix (pipeline check)', () => {
  it('matches the expected checksum at smoke size', () => {
    const k = mod.kernel('mix');
    expect(k.prepare(MIX_SEED, MIX_SIZES.smoke)).toBe(0);
    expect(k.run() >>> 0).toBe(MIX_EXPECTED.smoke);
  });

  it('the JS mirror reproduces MIX_EXPECTED.smoke', () => {
    expect(mixReference(MIX_SEED, MIX_SIZES.smoke)).toBe(MIX_EXPECTED.smoke);
  });

  it('is idempotent: run() returns the same value every call', () => {
    const k = mod.kernel('mix');
    k.prepare(MIX_SEED, MIX_SIZES.smoke);
    const a = k.run() >>> 0;
    expect(k.run() >>> 0).toBe(a);
    expect(k.run() >>> 0).toBe(a);
  });

  it('returns 0 for zero iterations', () => {
    const k = mod.kernel('mix');
    expect(k.prepare(MIX_SEED, 0)).toBe(0);
    expect(k.run() >>> 0).toBe(0);
    expect(k.prepare(0, 0)).toBe(0);
    expect(k.run() >>> 0).toBe(0);
  });

  const cases: Array<[seed: number, iterations: number]> = [
    [MIX_SEED, MIX_SIZES.smoke],
    [0, 1_000], // seed 0 uses the 0x9E3779B9 substitute
    [0, 1],
    [1, 1],
    [2, 7],
    [42, 12_345],
    [0xdeadbeef, 5_000],
    [0xffffffff, 3_333],
    [0x9e3779b9, 1_000], // equals the seed-0 substitute
    [123_456_789, 100_000],
  ];

  it.each(cases)('matches the JS mirror for seed=%i iterations=%i', (seed, iterations) => {
    const k = mod.kernel('mix');
    expect(k.prepare(seed, iterations)).toBe(0);
    expect(k.run() >>> 0).toBe(mixReference(seed, iterations));
  });

  it('seed 0 behaves like seed 0x9E3779B9', () => {
    const k = mod.kernel('mix');
    k.prepare(0, 1_000);
    const a = k.run() >>> 0;
    k.prepare(0x9e3779b9, 1_000);
    expect(k.run() >>> 0).toBe(a);
  });
});

describe('CPU kernel defs: structure', () => {
  it('lists 11 kernels with unique ids', () => {
    expect(cpuKernels).toHaveLength(11);
    expect(new Set(cpuKernels.map((k) => k.id)).size).toBe(cpuKernels.length);
  });

  it.each(cpuKernels.map((k) => [k.id, k] as const))('%s has a sane definition', (_id, def) => {
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.unit.length).toBeGreaterThan(0);
    for (const size of ['smoke', 'standard'] as const) {
      expect(Number.isInteger(def.sizes[size])).toBe(true);
      expect(def.sizes[size]).toBeGreaterThan(0);
      const e = def.expected[size];
      expect(Number.isInteger(e) && e >= 0 && e <= 0xffffffff).toBe(true);
      const w = def.work(def.sizes[size]);
      expect(Number.isFinite(w) && w > 0).toBe(true);
    }
    expect(def.sizes.smoke).toBeLessThan(def.sizes.standard);
  });
});

describe('CPU kernels at smoke size (every def in cpuKernels)', () => {
  it.each(cpuKernels.map((k) => [k.id, k] as const))('%s', (_id, def) => {
    const k = mod.kernel(def.id);
    expect(k.prepare(def.seed, def.sizes.smoke)).toBe(0);
    const first = k.run() >>> 0;
    const second = k.run() >>> 0;
    const third = k.run() >>> 0;
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toBe(def.expected.smoke);
  });

  it('re-preparing the same kernel gives the same checksum', () => {
    const def = cpuKernels[0]!;
    const k = mod.kernel(def.id);
    k.prepare(def.seed, def.sizes.smoke);
    const a = k.run() >>> 0;
    k.prepare(def.seed, def.sizes.smoke);
    expect(k.run() >>> 0).toBe(a);
  });

  it('kernels sharing one instance do not disturb each other (reverse order)', () => {
    for (const def of [...cpuKernels].reverse()) {
      const k = mod.kernel(def.id);
      expect(k.prepare(def.seed, def.sizes.smoke), def.id).toBe(0);
      expect(k.run() >>> 0, def.id).toBe(def.expected.smoke);
    }
  });

  it('a different seed changes the checksum of kernels that consume the seed', () => {
    // mandelbrot ignores the seed by design (see its header).
    for (const def of cpuKernels.filter((d) => !d.id.startsWith('mandelbrot'))) {
      const k = mod.kernel(def.id);
      expect(k.prepare(def.seed + 1, def.sizes.smoke), def.id).toBe(0);
      expect(k.run() >>> 0, def.id).not.toBe(def.expected.smoke);
    }
  });
});

describe('prepare() rejects invalid sizes with status 2', () => {
  // Only where the kernel documents it (kernels/src/{matmul,trace,fft}.rs).
  const cases: Array<[id: string, size: number]> = [
    ['matmul', 0],
    ['matmul', 12],
    ['matmul', 33],
    ['matmul_simd', 0],
    ['matmul_simd', 12],
    ['matmul_simd', 33],
    ['trace', 0],
    ['trace', 6],
    ['trace', 15],
    ['fft', 0],
  ];
  it.each(cases)('%s size=%i returns 2', (id, size) => {
    expect(mod.kernel(id).prepare(1, size)).toBe(2);
  });

  it('a valid prepare after a rejected one still works', () => {
    for (const id of ['matmul', 'matmul_simd', 'trace', 'fft']) {
      const def = cpuKernels.find((d) => d.id === id)!;
      const k = mod.kernel(id);
      expect(k.prepare(def.seed, 0)).toBe(2);
      expect(k.prepare(def.seed, def.sizes.smoke), id).toBe(0);
      expect(k.run() >>> 0, id).toBe(def.expected.smoke);
    }
  });
});

// ~Seconds and up to a few hundred MB per kernel: opt in with BENCH_STANDARD=1.
describe.skipIf(process.env['BENCH_STANDARD'] !== '1')('CPU kernels at standard size', () => {
  it('mix', { timeout: 120_000 }, async () => {
    const k = (await loadKernels()).kernel('mix');
    expect(k.prepare(MIX_SEED, MIX_SIZES.standard)).toBe(0);
    expect(k.run() >>> 0).toBe(MIX_EXPECTED.standard);
  });

  it.each(cpuKernels.map((k) => [k.id, k] as const))('%s', { timeout: 300_000 }, async (_id, def) => {
    // Fresh instance per kernel so linear memory (which never shrinks) is released.
    const k = (await loadKernels()).kernel(def.id);
    expect(k.prepare(def.seed, def.sizes.standard)).toBe(0);
    const first = k.run() >>> 0;
    expect(first).toBe(def.expected.standard);
    expect(k.run() >>> 0).toBe(first);
    expect(k.run() >>> 0).toBe(first);
  });
});
