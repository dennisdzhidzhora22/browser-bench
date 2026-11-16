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
  // All-cores test: smaller size so one instance per core fits in memory.
  multi: { size: 512, expected: 490_095_203 },
  // Endurance / Stress: a rep of about 5-13 ms on a fast core alone.
  loop: { size: 288, expected: 682_264 },
  work: (n) => (2 * n * n * n) / 1e9,
};
