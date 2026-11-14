// Memory tests (docs/SPEC.md, 3.3). Kernels in kernels/src/mem.rs.
import type { KernelDef } from '../types.ts';

/** Passes per `run` (FILL_PASSES, COPY_PASSES, COPY_MT_PASSES in mem.rs). */
export const FILL_PASSES = 20;
export const COPY_PASSES = 48;
export const COPY_MT_PASSES = 2;

const KB = 1 << 10;
const MB = 1 << 20;

/** Dependent loads per latency `run` at a working-set size (latency_hops in mem.rs). */
export function latencyHops(size: number): number {
  const n = Math.floor(size / 64);
  const base =
    size < 16 * KB
      ? n * 16
      : size <= 32 * KB
        ? 2 ** 26
        : size <= 256 * KB
          ? 2 ** 25
          : size <= 2 * MB
            ? 2 ** 24
            : size <= 8 * MB
              ? 2 ** 23
              : size <= 64 * MB
                ? 2 ** 22
                : Math.max(n, 2 ** 21);
  return base + 7;
}

export const memFill: KernelDef = {
  id: 'mem_fill',
  name: 'Fill',
  stresses: 'write bandwidth',
  unit: 'GB/s',
  seed: 1,
  // 256 MB: well past the largest CPU caches (~100 MB L3 on some desktop parts).
  sizes: { smoke: 4_096, standard: 256 * MB },
  expected: { smoke: 618_610_551, standard: 1_425_567_607 },
  // GB written per run.
  work: (size) => (size * FILL_PASSES) / 1e9,
};

export const memCopy: KernelDef = {
  id: 'mem_copy',
  name: 'Copy',
  stresses: 'bytes copied, counted once (memory traffic ≈ 2×)',
  unit: 'GB/s',
  seed: 1,
  // 128 MB -> 128 MB.
  sizes: { smoke: 4_096, standard: 128 * MB },
  expected: { smoke: 2_272_187_849, standard: 4_226_083_811 },
  work: (size) => (size * COPY_PASSES) / 1e9,
};

/**
 * All-cores copy: same work as memCopy, but few passes, so one `run` is short
 * next to the all-cores window. 16 MB -> 16 MB per worker; 8 workers = 256 MB.
 * With few workers the total can fit in a big L3, which then measures cache.
 */
export const memCopyMulti: KernelDef = {
  id: 'mem_copy_mt',
  name: 'Copy',
  stresses: 'bytes copied, counted once (memory traffic ≈ 2×)',
  unit: 'GB/s',
  seed: 1,
  sizes: { smoke: 4_096, standard: 16 * MB },
  expected: { smoke: 3_150_876_299, standard: 1_498_308_565 },
  multi: { size: 16 * MB, expected: 1_498_308_565 },
  work: (size) => (size * COPY_MT_PASSES) / 1e9,
};

/** Working-set sizes for the latency curve, and their expected checksums (seed 1). */
const LATENCY_POINTS: readonly [size: number, expected: number][] = [
  [16 * KB, 191],
  [32 * KB, 27],
  [64 * KB, 1_007],
  [128 * KB, 1_016],
  [256 * KB, 3_188],
  [512 * KB, 3_018],
  [1 * MB, 3_310],
  [2 * MB, 13_766],
  [4 * MB, 46_407],
  [8 * MB, 23_311],
  [12 * MB, 80_162],
  [16 * MB, 45_804],
  [24 * MB, 263_856],
  [32 * MB, 194_244],
  [64 * MB, 165_723],
  [128 * MB, 1_724_444],
  [256 * MB, 1_094_450],
];

export function formatBytes(n: number): string {
  return n >= MB ? `${n / MB} MB` : `${n / KB} KB`;
}

/**
 * One def per working-set size. They share the wasm kernel `mem_latency`;
 * `variant` keeps them apart in lists. Throughput is hops/s, so
 * ns per access = 1e9 / throughput.
 */
export const latencyDefs: readonly KernelDef[] = LATENCY_POINTS.map(([size, expected]) => ({
  id: 'mem_latency',
  variant: String(size),
  name: `Latency ${formatBytes(size)}`,
  stresses: 'random access',
  unit: 'hops/s',
  seed: 1,
  sizes: { smoke: 4_096, standard: size },
  expected: { smoke: 34, standard: expected },
  work: (s) => latencyHops(s),
  // Runs are short (~50 ms+); a spin first puts the thread on a fast core at full clock.
  spinBeforeMs: 150,
}));

/** Single-core memory tests, in run order. All-cores copy (memCopyMulti) runs after them. */
export const memoryKernels: readonly KernelDef[] = [memFill, memCopy, ...latencyDefs];

/** ns per access from a latency outcome's throughput (hops/s). */
export function latencyNs(throughput: number | undefined): number | undefined {
  return throughput && throughput > 0 ? 1e9 / throughput : undefined;
}
