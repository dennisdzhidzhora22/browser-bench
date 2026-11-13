// M0 smoke kernel definition. Proves the pipeline; not a scored benchmark.

export const MIX_SEED = 1;

/** Iteration counts. `standard` takes roughly 250–400 ms on a desktop CPU. */
export const MIX_SIZES = {
  smoke: 1_000,
  standard: 200_000_000,
} as const;

export type MixSize = keyof typeof MIX_SIZES;

/**
 * Expected checksums for seed MIX_SEED. Computed from the reference algorithm
 * documented in kernels/src/mix.rs and checked against the wasm build.
 */
export const MIX_EXPECTED: Record<MixSize, number> = {
  smoke: 648_056_936,
  standard: 980_582_964,
};
