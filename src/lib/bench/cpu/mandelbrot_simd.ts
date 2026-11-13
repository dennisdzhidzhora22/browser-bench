// Mandelbrot with f64x2 lanes; same iteration counts and checksum as the scalar kernel (kernels/src/mandelbrot.rs).
import type { KernelDef } from '../types.ts';

export const mandelbrotSimd: KernelDef = {
  id: 'mandelbrot_simd',
  name: 'Mandelbrot (SIMD)',
  stresses: 'simd128',
  unit: 'Mpixels/s',
  seed: 1,
  sizes: { smoke: 64, standard: 3_000 },
  expected: { smoke: 2_310_917_514, standard: 2_773_226_483 },
  work: (size) => (size * Math.floor((size * 3) / 4)) / 1e6,
  simd: true,
};
