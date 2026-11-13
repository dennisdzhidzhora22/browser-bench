// Pipeline smoke kernel (kernels/src/mix.rs). Not a scored benchmark; used by
// tests and as the reference example of a KernelDef.
import type { KernelDef } from './types.ts';

export const MIX_SEED = 1;

export const MIX_SIZES = {
  smoke: 1_000,
  standard: 200_000_000,
} as const;

export type MixSize = keyof typeof MIX_SIZES;

export const MIX_EXPECTED: Record<MixSize, number> = {
  smoke: 648_056_936,
  standard: 980_582_964,
};

export const mix: KernelDef = {
  id: 'mix',
  name: 'Mix (pipeline check)',
  stresses: 'integer ops',
  unit: 'M iter/s',
  seed: MIX_SEED,
  sizes: MIX_SIZES,
  expected: MIX_EXPECTED,
  work: (size) => size / 1e6,
};
