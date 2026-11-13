// Introsort of u32 values (kernels/src/sort.rs).
import type { KernelDef } from '../types.ts';

export const sortU32: KernelDef = {
  id: 'sort_u32',
  name: 'Sort (u32)',
  stresses: 'branches, cache',
  unit: 'M elements/s',
  seed: 1,
  sizes: { smoke: 1_000, standard: 6_000_000 },
  expected: { smoke: 2_766_581_911, standard: 3_616_629_640 },
  work: (size) => size / 1e6,
};
