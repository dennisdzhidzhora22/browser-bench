// Memory tests (docs/SPEC.md, 3.3). Kernels in kernels/src/mem.rs.
import type { KernelDef } from '../types.ts';

/** Passes and hops per `run` (FILL_PASSES, COPY_PASSES, LATENCY_HOPS in mem.rs). */
export const FILL_PASSES = 40;
export const COPY_PASSES = 96;
export const LATENCY_HOPS = (1 << 20) + 7;

const MB = 1 << 20;

export const memFill: KernelDef = {
  id: 'mem_fill',
  name: 'Fill',
  stresses: 'write bandwidth',
  unit: 'GB/s',
  seed: 1,
  // 128 MB: far larger than any CPU cache, so this measures RAM.
  sizes: { smoke: 4_096, standard: 128 * MB },
  expected: { smoke: 3_957_342_055, standard: 2_210_860_903 },
  // GB written per run.
  work: (size) => (size * FILL_PASSES) / 1e9,
};

export const memCopy: KernelDef = {
  id: 'mem_copy',
  name: 'Copy',
  stresses: 'read + write bandwidth',
  unit: 'GB/s',
  seed: 1,
  sizes: { smoke: 4_096, standard: 64 * MB },
  expected: { smoke: 740_218_992, standard: 688_219_860 },
  // All-cores copy: 2 x 8 MB per worker; 16 workers = 256 MB, still far past the caches.
  multi: { size: 8 * MB, expected: 3_270_555_192 },
  // GB copied per run (each byte read once and written once; counted once).
  work: (size) => (size * COPY_PASSES) / 1e9,
};

/** Working-set sizes for the latency curve, and their expected checksums (seed 1). */
const LATENCY_POINTS: readonly [size: number, expected: number][] = [
  [16 << 10, 191],
  [32 << 10, 27],
  [64 << 10, 1_007],
  [128 << 10, 1_016],
  [256 << 10, 3_188],
  [512 << 10, 3_018],
  [1 * MB, 3_310],
  [2 * MB, 13_766],
  [4 * MB, 46_407],
  [8 * MB, 23_311],
  [16 * MB, 45_804],
  [32 * MB, 194_244],
  [64 * MB, 165_723],
  [128 * MB, 397_049],
  [256 * MB, 3_940_308],
];

export function formatBytes(n: number): string {
  return n >= MB ? `${n / MB} MB` : `${n >> 10} KB`;
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
  work: () => LATENCY_HOPS,
}));

export const memoryKernels: readonly KernelDef[] = [memFill, memCopy, ...latencyDefs];

/** ns per access from a latency outcome's throughput (hops/s). */
export function latencyNs(throughput: number | undefined): number | undefined {
  return throughput && throughput > 0 ? 1e9 / throughput : undefined;
}
