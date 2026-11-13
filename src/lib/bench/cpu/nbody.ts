// N-body gravity, 256 bodies, size = time steps (kernels/src/nbody.rs).
import type { KernelDef } from '../types.ts';

export const nbody: KernelDef = {
  id: 'nbody',
  name: 'N-body',
  stresses: 'scalar float',
  unit: 'steps/s',
  seed: 1,
  sizes: { smoke: 2, standard: 4_000 },
  expected: { smoke: 539_028_224, standard: 1_354_116_538 },
  // All-cores test: short runs (~30 ms) so fixed-time windows are fine-grained.
  multi: { size: 320, expected: 921_392_367 },
  work: (size) => size,
};
