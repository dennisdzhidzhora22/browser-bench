// Dense f64 matrix multiply, simd128 f64x2 (kernels/src/matmul.rs). Bit-identical results to
// the scalar version, so checksums at equal sizes match; the standard size is larger because
// it runs faster.
import type { KernelDef } from '../types.ts';

export const matmulSimd: KernelDef = {
  id: 'matmul_simd',
  name: 'Matrix multiply (f64, SIMD)',
  stresses: 'float, cache, simd128',
  unit: 'GFLOP/s',
  seed: 1,
  sizes: { smoke: 32, standard: 1440 },
  expected: { smoke: 419_049_538, standard: 1_847_568_248 },
  work: (n) => (2 * n * n * n) / 1e9,
  simd: true,
};
