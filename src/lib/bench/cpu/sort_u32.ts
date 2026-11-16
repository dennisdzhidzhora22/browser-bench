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
  // All-cores test: smaller size so one instance per core fits in memory.
  multi: { size: 1_000_000, expected: 3_432_757_072 },
  // Endurance / Stress: a rep of about 5-13 ms on a fast core alone.
  loop: { size: 150_000, expected: 4_228_455_512 },
  work: (size) => size / 1e6,
};
