// Points constants (docs/SPEC.md, section 6). A kernel scoring exactly its
// constant earns 1000 points. Frozen per SCORE_VERSION: any change to a
// kernel, its size or a constant bumps SCORE_VERSION, and results with
// different versions are never compared.
//
// FROZEN (M8) for SCORE_VERSION 1: medians of one Full standard-size run on the
// reference PC ("Owner PC"), rounded to 3 significant digits by scripts/make-reference.mjs.
// Run 9fe60e4e-fcdc-460f-a434-c775fa307c9b, 2026-11-17T15:03:55.554Z,
// Google Chrome 157.0.8103.79, 16 logical cores.
// Do not edit by hand: any change to a constant, a kernel or its size bumps SCORE_VERSION.
//
// Memory: the 17 mem_latency sizes share one kernel id, so they combine into
// one latency sub-score before the component geomean (lib/scoring/score.ts).

export const SCORE_VERSION = 1;

/** Units where smaller is better: these score constant / result. */
export const LOWER_IS_BETTER: ReadonlySet<string> = new Set(['ns']);

/** One constant per `<component>/<defKey>`, in the kernel's record unit. */
export const CONSTANTS: Readonly<Record<string, number>> = {
  // CPU, single core
  'cpu-single/sha256': 345,
  'cpu-single/lz': 434,
  'cpu-single/sort_u32': 16.4,
  'cpu-single/sort_f64': 14.7,
  'cpu-single/nbody': 11300,
  'cpu-single/mandelbrot': 9.97,
  'cpu-single/mandelbrot_simd': 17.4,
  'cpu-single/matmul': 10.4,
  'cpu-single/matmul_simd': 18.1,
  'cpu-single/fft': 25200,
  'cpu-single/trace': 26200,
  // CPU, all cores (combined throughput)
  'cpu-multi/sha256': 3540,
  'cpu-multi/lz': 3780,
  'cpu-multi/sort_u32': 202,
  'cpu-multi/sort_f64': 160,
  'cpu-multi/nbody': 101000,
  'cpu-multi/mandelbrot': 134,
  'cpu-multi/mandelbrot_simd': 225,
  'cpu-multi/matmul': 60.7,
  'cpu-multi/matmul_simd': 108,
  'cpu-multi/fft': 191000,
  'cpu-multi/trace': 242000,
  // Memory (GB/s; latency in ns per access, lower is better)
  'memory/mem_fill': 16.4,
  'memory/mem_copy': 21,
  'memory/mem_copy_mt': 50.1,
  'memory/mem_latency:16384': 0.766,
  'memory/mem_latency:32768': 0.774,
  'memory/mem_latency:65536': 1.71,
  'memory/mem_latency:131072': 1.71,
  'memory/mem_latency:262144': 2.94,
  'memory/mem_latency:524288': 3.33,
  'memory/mem_latency:1048576': 4,
  'memory/mem_latency:2097152': 4.3,
  'memory/mem_latency:4194304': 12.5,
  'memory/mem_latency:8388608': 15,
  'memory/mem_latency:12582912': 18.2,
  'memory/mem_latency:16777216': 28.8,
  'memory/mem_latency:25165824': 102,
  'memory/mem_latency:33554432': 133,
  'memory/mem_latency:67108864': 160,
  'memory/mem_latency:134217728': 167,
  'memory/mem_latency:268435456': 170,
  // GPU (WebGPU only; the WebGL2 fallback earns no points)
  'gpu/gpu_nbody': 283,
  'gpu/gpu_matmul': 8250,
  'gpu/gpu_draws': 2630,
  'gpu/gpu_fragment': 3560,
  // Storage (standard 256 MiB file only)
  'storage/storage_seq_write': 1790,
  'storage/storage_seq_read': 5860,
  'storage/storage_rand_write': 25900,
  'storage/storage_rand_read': 332000,
};
