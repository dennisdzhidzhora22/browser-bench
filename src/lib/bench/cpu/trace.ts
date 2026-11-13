// Small path tracer (kernels/src/trace.rs). size = image width (multiple of 4), height =
// size * 3 / 4, 4 samples per pixel.
import type { KernelDef } from '../types.ts';

export const trace: KernelDef = {
  id: 'trace',
  name: 'Path tracer',
  stresses: 'mixed float, branches',
  unit: 'ksamples/s',
  seed: 1,
  sizes: { smoke: 16, standard: 1792 },
  expected: { smoke: 2_755_351_516, standard: 4_013_853_055 },
  work: (w) => (w * ((w * 3) / 4) * 4) / 1e3,
};
