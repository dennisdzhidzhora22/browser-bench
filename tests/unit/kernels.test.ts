import { beforeAll, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { latencyDefs, memCopy, memFill, memoryKernels } from '../../src/lib/bench/memory/index.ts';
import { mix, MIX_EXPECTED, MIX_SEED, MIX_SIZES } from '../../src/lib/bench/mix.ts';
import type { KernelDef } from '../../src/lib/bench/types.ts';
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
    expect(ABI_VERSION).toBe(5);
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

  it('exposes prepare and run for every CPU kernel, every memory kernel and mix', () => {
    const ids = [...cpuKernels.map((k) => k.id), ...memoryKernels.map((k) => k.id), mix.id];
    expect(ids).toContain('mem_latency');
    for (const id of ids) {
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

// ── All-cores sizes (docs/SPEC.md, 3.2): one instance per core, so memory matters ──

const withMulti = cpuKernels.filter((d) => d.multi !== undefined);

describe('CPU kernels at their all-cores (`multi`) size', () => {
  it('every CPU kernel defines a multi size (one wasm instance per core must stay small)', () => {
    expect(withMulti.map((d) => d.id)).toEqual(cpuKernels.map((d) => d.id));
  });

  it.each(withMulti.map((k) => [k.id, k] as const))('%s', (_id, def) => {
    const multi = def.multi!;
    expect(Number.isInteger(multi.size) && multi.size > 0, 'size').toBe(true);
    expect(multi.size, 'multi is a reduction, not an increase').toBeLessThanOrEqual(def.sizes.standard);
    expect(Number.isInteger(multi.expected) && multi.expected >= 0 && multi.expected <= 0xffffffff).toBe(true);

    // Fresh instance: linear memory never shrinks.
    return loadKernels().then((m) => {
      const k = m.kernel(def.id);
      expect(k.prepare(def.seed, multi.size)).toBe(0);
      const first = k.run() >>> 0;
      expect(k.run() >>> 0).toBe(first);
      expect(k.run() >>> 0).toBe(first);
      expect(first).toBe(multi.expected);
    });
  });
});

describe('peak wasm memory per instance', () => {
  const LIMIT = 20 * 1024 * 1024;

  it.each(cpuKernels.map((k) => [k.id, k] as const))('%s stays under 20 MB at its all-cores size', async (_id, def) => {
    const { size } = def.multi ?? { size: def.sizes.standard };
    const m = await loadKernels(); // fresh instance
    const k = m.kernel(def.id);
    expect(k.prepare(def.seed, size)).toBe(0);
    k.run();
    expect(m.memory.buffer.byteLength, `${def.id} size=${size}`).toBeLessThan(LIMIT);
  });
});

// ── M3: memory kernels (kernels/src/mem.rs, docs/SPEC.md 3.3) ─────────────────

const MB = 1 << 20;
/** Request that can never fit in 32-bit wasm memory, whatever the arena base. */
const TOO_BIG = 0xfffffff0;

const memName = (d: KernelDef) => (d.variant ? `${d.id}:${d.variant}` : d.id);

describe('memory kernel defs: structure', () => {
  it('lists fill, copy and 15 latency defs sharing the mem_latency kernel', () => {
    expect(memoryKernels).toHaveLength(17);
    expect(memoryKernels.map((d) => d.id)).toEqual(['mem_fill', 'mem_copy', ...Array<string>(15).fill('mem_latency')]);
    expect(latencyDefs).toHaveLength(15);
  });

  it.each(memoryKernels.map((d) => [memName(d), d] as const))('%s has a sane definition', (_name, d) => {
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.unit.length).toBeGreaterThan(0);
    expect(d.stresses.length).toBeGreaterThan(0);
    for (const size of ['smoke', 'standard'] as const) {
      expect(Number.isInteger(d.sizes[size])).toBe(true);
      expect(d.sizes[size]).toBeGreaterThan(0);
      const e = d.expected[size];
      expect(Number.isInteger(e) && e >= 0 && e <= 0xffffffff).toBe(true);
      const w = d.work(d.sizes[size]);
      expect(Number.isFinite(w) && w > 0).toBe(true);
    }
    expect(d.sizes.smoke).toBeLessThan(d.sizes.standard);
  });

  it('latency sizes: 16 KB to 256 MB, ascending powers of two, valid for prepare()', () => {
    const sizes = latencyDefs.map((d) => d.sizes.standard);
    expect(sizes[0]).toBe(16 * 1024);
    expect(sizes[sizes.length - 1]).toBe(256 * MB);
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i]!;
      expect(Math.log2(s) % 1, `${s} is a power of two`).toBe(0);
      expect(s % 64).toBe(0);
      expect(s).toBeGreaterThanOrEqual(128);
      if (i > 0) expect(s).toBe(sizes[i - 1]! * 2);
      expect(latencyDefs[i]!.variant).toBe(String(s));
    }
  });

  it('the all-cores copy size is small enough for one instance per core', () => {
    const multi = memCopy.multi!;
    expect(multi).toBeDefined();
    expect(multi.size).toBe(8 * MB);
    expect(multi.size).toBeLessThan(memCopy.sizes.standard);
    expect(Number.isInteger(multi.expected) && multi.expected >= 0 && multi.expected <= 0xffffffff).toBe(true);
    // Only copy has a multi variant (App.svelte runs memCopy on several workers).
    expect(memoryKernels.filter((d) => d.multi !== undefined)).toEqual([memCopy]);
  });
});

describe('memory kernels at smoke size (every def in memoryKernels)', () => {
  it.each(memoryKernels.map((d) => [memName(d), d] as const))('%s', (_name, d) => {
    const k = mod.kernel(d.id);
    expect(k.prepare(d.seed, d.sizes.smoke)).toBe(0);
    const first = k.run() >>> 0;
    const second = k.run() >>> 0;
    const third = k.run() >>> 0;
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toBe(d.expected.smoke);
  });

  it('the 15 latency defs share one smoke size and checksum', () => {
    expect(new Set(latencyDefs.map((d) => d.expected.smoke)).size).toBe(1);
    expect(new Set(latencyDefs.map((d) => d.sizes.smoke)).size).toBe(1);
  });

  it('copy at its all-cores (multi) size', async () => {
    const m = await loadKernels(); // fresh instance: memory never shrinks
    const k = m.kernel(memCopy.id);
    expect(k.prepare(memCopy.seed, memCopy.multi!.size)).toBe(0);
    const first = k.run() >>> 0;
    expect(k.run() >>> 0).toBe(first);
    expect(k.run() >>> 0).toBe(first);
    expect(first).toBe(memCopy.multi!.expected);
    // Two 8 MB buffers plus the module: small enough for one instance per core.
    expect(m.memory.buffer.byteLength).toBeLessThan(24 * MB);
  });

  it('re-preparing the same kernel gives the same checksum', () => {
    for (const d of [memFill, memCopy, latencyDefs[0]!]) {
      const k = mod.kernel(d.id);
      k.prepare(d.seed, d.sizes.smoke);
      const a = k.run() >>> 0;
      k.prepare(d.seed, d.sizes.smoke);
      expect(k.run() >>> 0, d.id).toBe(a);
    }
  });

  it('memory and CPU kernels sharing one instance do not disturb each other', () => {
    const order = [
      ...memoryKernels.slice(0, 3),
      ...cpuKernels.slice(0, 3),
      ...memoryKernels.slice(3, 5),
      cpuKernels[3]!,
    ].reverse();
    for (const d of order) {
      const k = mod.kernel(d.id);
      expect(k.prepare(d.seed, d.sizes.smoke), d.id).toBe(0);
      expect(k.run() >>> 0, d.id).toBe(d.expected.smoke);
    }
  });

  it('a different seed changes the checksum', () => {
    for (const d of [memFill, memCopy]) {
      const k = mod.kernel(d.id);
      expect(k.prepare(d.seed + 1, d.sizes.smoke)).toBe(0);
      expect(k.run() >>> 0, d.id).not.toBe(d.expected.smoke);
    }
    // Latency: the checksum is a line index (< 64 at smoke), so one other seed could collide.
    const d = latencyDefs[0]!;
    const k = mod.kernel(d.id);
    const seen = new Set<number>();
    for (const seed of [2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(k.prepare(seed, d.sizes.smoke)).toBe(0);
      seen.add(k.run() >>> 0);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('latency checksum is a valid line index', () => {
    const k = mod.kernel('mem_latency');
    for (const [bytes, seed] of [[128, 1], [192, 2], [4096, 3], [65_536, 4]] as const) {
      expect(k.prepare(seed, bytes)).toBe(0);
      expect(k.run() >>> 0).toBeLessThan(bytes / 64);
    }
  });
});

describe('memory prepare() status codes', () => {
  it.each([
    ['mem_fill', 0],
    ['mem_copy', 0],
    ['mem_latency', 0],
    ['mem_latency', 1],
    ['mem_latency', 63],
    ['mem_latency', 64], // one line: a chain needs at least two
    ['mem_latency', 65],
    ['mem_latency', 127],
    ['mem_latency', 129],
    ['mem_latency', 191],
    ['mem_latency', 200],
    ['mem_latency', 4_095],
    ['mem_latency', 4_097],
    ['mem_latency', 0xffffffff],
  ] as const)('%s size=%i returns 2', (id, size) => {
    expect(mod.kernel(id).prepare(1, size)).toBe(2);
  });

  it.each([
    ['mem_latency', 128],
    ['mem_latency', 192],
    ['mem_latency', 320],
    ['mem_fill', 1],
    ['mem_fill', 3],
    ['mem_copy', 1],
    ['mem_copy', 7],
  ] as const)('%s size=%i is accepted and runs without trapping', (id, size) => {
    const k = mod.kernel(id);
    expect(k.prepare(1, size)).toBe(0);
    expect(() => k.run()).not.toThrow();
  });

  it('a valid prepare after a rejected one still works', () => {
    for (const d of [memFill, memCopy, latencyDefs[0]!]) {
      const k = mod.kernel(d.id);
      expect(k.prepare(d.seed, 0), d.id).toBe(2);
      expect(k.prepare(d.seed, d.sizes.smoke), d.id).toBe(0);
      expect(k.run() >>> 0, d.id).toBe(d.expected.smoke);
    }
    const lat = mod.kernel('mem_latency');
    expect(lat.prepare(1, 100)).toBe(2);
    expect(lat.prepare(1, latencyDefs[0]!.sizes.smoke)).toBe(0);
    expect(lat.run() >>> 0).toBe(latencyDefs[0]!.expected.smoke);
  });
});

describe('memory prepare() out of memory returns status 1', () => {
  it.each([
    ['mem_fill', TOO_BIG],
    ['mem_copy', TOO_BIG],
    ['mem_latency', 0xffffffc0], // multiple of 64
    ['mem_latency', 0xffffff00],
  ] as const)('%s size=%i', async (id, size) => {
    const m = await loadKernels(); // fresh instance
    const before = m.memory.buffer.byteLength;
    expect(m.kernel(id).prepare(1, size)).toBe(1);
    // A failed grow leaves memory as it was. (Not asserted for mem_latency: its prepare
    // allocates the chain and the shuffle table in one tuple, so the table can still grow
    // memory by size/64 u32s after the chain allocation failed. Reported to the Builder.)
    if (id !== 'mem_latency') expect(m.memory.buffer.byteLength).toBe(before);
  });

  it.each(memoryKernels.slice(0, 3).map((d) => [d.id, d] as const))(
    '%s: the instance still works after an out-of-memory prepare',
    async (_id, d) => {
      const m = await loadKernels();
      const k = m.kernel(d.id);
      const big = d.id === 'mem_latency' ? 0xffffffc0 : TOO_BIG;
      expect(k.prepare(d.seed, big)).toBe(1);
      expect(k.prepare(d.seed, d.sizes.smoke)).toBe(0);
      expect(k.run() >>> 0).toBe(d.expected.smoke);
      // And a different kernel in the same instance.
      const od = d === memFill ? memCopy : memFill;
      const other = m.kernel(od.id);
      expect(other.prepare(od.seed, od.sizes.smoke)).toBe(0);
      expect(other.run() >>> 0).toBe(od.expected.smoke);
    },
  );

  it('a CPU kernel still works after a memory kernel ran out of memory', async () => {
    const m = await loadKernels();
    expect(m.kernel('mem_fill').prepare(1, TOO_BIG)).toBe(1);
    const d = cpuKernels[0]!;
    const k = m.kernel(d.id);
    expect(k.prepare(d.seed, d.sizes.smoke)).toBe(0);
    expect(k.run() >>> 0).toBe(d.expected.smoke);
  });
});

// Standard sizes: up to 256 MB of wasm memory per kernel. Opt in with BENCH_STANDARD=1.
describe.skipIf(process.env['BENCH_STANDARD'] !== '1')('memory kernels at standard size', () => {
  it.each(memoryKernels.map((d) => [memName(d), d] as const))('%s', { timeout: 300_000 }, async (_name, d) => {
    // Fresh instance per kernel so linear memory (which never shrinks) is released.
    const m = await loadKernels();
    const k = m.kernel(d.id);
    expect(k.prepare(d.seed, d.sizes.standard)).toBe(0);
    const first = k.run() >>> 0;
    expect(first).toBe(d.expected.standard);
    expect(k.run() >>> 0).toBe(first);
    expect(k.run() >>> 0).toBe(first);
  });

  it('several kernels in one instance, largest first (arena reuse after reset)', { timeout: 300_000 }, async () => {
    const m = await loadKernels();
    for (const d of [latencyDefs[14]!, memCopy, memFill, latencyDefs[0]!]) {
      const k = m.kernel(d.id);
      expect(k.prepare(d.seed, d.sizes.standard), d.id).toBe(0);
      expect(k.run() >>> 0, d.id).toBe(d.expected.standard);
    }
  });
});
