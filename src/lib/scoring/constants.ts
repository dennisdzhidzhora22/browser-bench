// Points constants (docs/SPEC.md, section 6). A kernel scoring exactly its
// constant earns 1000 points. Frozen per SCORE_VERSION: any change to a
// kernel, its size or a constant bumps SCORE_VERSION, and results with
// different versions are never compared.
//
// PROVISIONAL (M6): medians of one Quick standard-size run of every component,
// rounded to 3 significant digits. Chrome 157 launched by Playwright (headed,
// background throttling off) against `npm run preview` on this PC, 2026-11-14:
// 16 logical cores, 16 workers, GPU "intel · xe-lpg" (WebGPU, Fast), 256 MiB
// storage file. One run only; the 16 MB latency row was noisy (spread 73 %).
// M8 refreezes them from the owner's PC (and bumps SCORE_VERSION if they change).

export const SCORE_VERSION = 1;

/** Units where smaller is better: these score constant / result. */
export const LOWER_IS_BETTER: ReadonlySet<string> = new Set(['ns']);

/** One constant per `<component>/<defKey>`, in the kernel's record unit. */
export const CONSTANTS: Readonly<Record<string, number>> = {
  // CPU, single core
  'cpu-single/sha256': 300,
  'cpu-single/lz': 385,
  'cpu-single/sort_u32': 14.7,
  'cpu-single/sort_f64': 12,
  'cpu-single/nbody': 9520,
  'cpu-single/mandelbrot': 8.69,
  'cpu-single/mandelbrot_simd': 15.4,
  'cpu-single/matmul': 9.3,
  'cpu-single/matmul_simd': 16.3,
  'cpu-single/fft': 23700,
  'cpu-single/trace': 23500,
  // CPU, all cores (combined throughput)
  'cpu-multi/sha256': 4150,
  'cpu-multi/lz': 4640,
  'cpu-multi/sort_u32': 237,
  'cpu-multi/sort_f64': 199,
  'cpu-multi/nbody': 122000,
  'cpu-multi/mandelbrot': 131,
  'cpu-multi/mandelbrot_simd': 233,
  'cpu-multi/matmul': 78.4,
  'cpu-multi/matmul_simd': 142,
  'cpu-multi/fft': 248000,
  'cpu-multi/trace': 290000,
  // Memory (GB/s; latency in ns per access, lower is better)
  'memory/mem_fill': 15.9,
  'memory/mem_copy': 19.3,
  'memory/mem_copy_mt': 51.5,
  'memory/mem_latency:16384': 0.871,
  'memory/mem_latency:32768': 0.824,
  'memory/mem_latency:65536': 1.85,
  'memory/mem_latency:131072': 1.85,
  'memory/mem_latency:262144': 3.32,
  'memory/mem_latency:524288': 3.49,
  'memory/mem_latency:1048576': 4.34,
  'memory/mem_latency:2097152': 5,
  'memory/mem_latency:4194304': 13.7,
  'memory/mem_latency:8388608': 16.2,
  'memory/mem_latency:12582912': 25.6,
  'memory/mem_latency:16777216': 37.1,
  'memory/mem_latency:25165824': 143,
  'memory/mem_latency:33554432': 155,
  'memory/mem_latency:67108864': 166,
  'memory/mem_latency:134217728': 170,
  'memory/mem_latency:268435456': 192,
  // GPU (WebGPU only; the WebGL2 fallback earns no points)
  'gpu/gpu_nbody': 118,
  'gpu/gpu_matmul': 1920,
  'gpu/gpu_draws': 2260,
  'gpu/gpu_fragment': 617,
  // Storage (standard 256 MiB file only)
  'storage/storage_seq_write': 544,
  'storage/storage_seq_read': 849,
  'storage/storage_rand_write': 5980,
  'storage/storage_rand_read': 10800,
};
