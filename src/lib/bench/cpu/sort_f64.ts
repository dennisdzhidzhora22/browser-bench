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
  // All-cores test: smaller size so one instance per core fits in memory.
  multi: { size: 1_000_000, expected: 1_194_051_492 },
  // Endurance / Stress: a rep of about 5-13 ms on a fast core alone.
  loop: { size: 100_000, expected: 2_420_974_639 },
  work: (size) => size / 1e6,
};
