// Introsort of u32 values (kernels/src/sort.rs).
import type { KernelDef } from '../types.ts';

export const sortU32: KernelDef = {
  id: 'sort_u32',
  name: 'Sort (u32)',
  stresses: 'branches, cache',
  unit: 'M elements/s',
  seed: 1,
  // standard: ~620-690 ms per run on the reference PC (Node); headroom over the
  // 250 ms floor for faster desktops.
  sizes: { smoke: 1_000, standard: 8_000_000 },
  expected: { smoke: 2_766_581_911, standard: 329_145_997 },
  work: (size) => size / 1e6,
};
