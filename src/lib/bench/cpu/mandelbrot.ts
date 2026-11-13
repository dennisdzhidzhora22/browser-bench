// Scalar f64 Mandelbrot, size = image width, height = floor(3w/4) (kernels/src/mandelbrot.rs).
import type { KernelDef } from '../types.ts';

export const mandelbrot: KernelDef = {
  id: 'mandelbrot',
  name: 'Mandelbrot',
  stresses: 'float, tight loops',
  unit: 'Mpixels/s',
  seed: 1,
  sizes: { smoke: 64, standard: 2_240 },
  expected: { smoke: 2_310_917_514, standard: 895_799_607 },
  work: (size) => (size * Math.floor((size * 3) / 4)) / 1e6,
};
