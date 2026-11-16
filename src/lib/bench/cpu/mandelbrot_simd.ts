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
  // All-cores test: short runs (~30 ms) so fixed-time windows are fine-grained.
  multi: { size: 800, expected: 357_525_391 },
  // Endurance / Stress: a rep of about 5-13 ms on a fast core alone.
  loop: { size: 384, expected: 3_745_048_948 },
  work: (size) => (size * Math.floor((size * 3) / 4)) / 1e6,
  simd: true,
};
