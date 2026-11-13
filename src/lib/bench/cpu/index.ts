// CPU single-core kernel list, in run order. The `mix` pipeline check is not
// listed: it is not a scored benchmark.
import type { KernelDef } from '../types.ts';
import { fft } from './fft.ts';
import { lz } from './lz.ts';
import { mandelbrot } from './mandelbrot.ts';
import { mandelbrotSimd } from './mandelbrot_simd.ts';
import { matmul } from './matmul.ts';
import { matmulSimd } from './matmul_simd.ts';
import { nbody } from './nbody.ts';
import { sha256 } from './sha256.ts';
import { sortF64 } from './sort_f64.ts';
import { sortU32 } from './sort_u32.ts';
import { trace } from './trace.ts';

export const cpuKernels: readonly KernelDef[] = [
  sha256,
  lz,
  sortU32,
  sortF64,
  nbody,
  mandelbrot,
  mandelbrotSimd,
  matmul,
  matmulSimd,
  fft,
  trace,
];
