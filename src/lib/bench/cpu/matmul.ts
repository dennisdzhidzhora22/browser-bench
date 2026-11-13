// Dense f64 matrix multiply, scalar (kernels/src/matmul.rs). size = n (n x n), multiple of 8.
import type { KernelDef } from '../types.ts';

export const matmul: KernelDef = {
  id: 'matmul',
  name: 'Matrix multiply (f64)',
  stresses: 'float, cache',
  unit: 'GFLOP/s',
  seed: 1,
  sizes: { smoke: 32, standard: 1152 },
  expected: { smoke: 419_049_538, standard: 3_813_767_060 },
  work: (n) => (2 * n * n * n) / 1e9,
};
