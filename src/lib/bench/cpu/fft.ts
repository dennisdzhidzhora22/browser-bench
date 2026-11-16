// Radix-2 complex f64 FFT, 4096 points (kernels/src/fft.rs). size = transforms per run.
import type { KernelDef } from '../types.ts';

export const fft: KernelDef = {
  id: 'fft',
  name: 'FFT (4096-point complex)',
  stresses: 'float',
  unit: 'transforms/s',
  seed: 1,
  sizes: { smoke: 4, standard: 10_000 },
  expected: { smoke: 3_877_711_093, standard: 2_569_804_454 },
  // All-cores test: short runs (~30 ms) so fixed-time windows are fine-grained.
  multi: { size: 800, expected: 3_257_962_583 },
  // Endurance / Stress: a rep of about 5-13 ms on a fast core alone.
  loop: { size: 80, expected: 4_294_083_563 },
  work: (size) => size,
};
