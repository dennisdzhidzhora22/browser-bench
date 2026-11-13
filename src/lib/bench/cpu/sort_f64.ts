// Introsort of f64 values (kernels/src/sort.rs).
import type { KernelDef } from '../types.ts';

export const sortF64: KernelDef = {
  id: 'sort_f64',
  name: 'Sort (f64)',
  stresses: 'branches, cache',
  unit: 'M elements/s',
  seed: 1,
  sizes: { smoke: 1_000, standard: 5_500_000 },
  expected: { smoke: 1_962_531_028, standard: 2_144_314_438 },
  work: (size) => size / 1e6,
};
