// SHA-256 over a fixed pseudo-random buffer (kernels/src/sha256.rs).
import type { KernelDef } from '../types.ts';

export const sha256: KernelDef = {
  id: 'sha256',
  name: 'SHA-256',
  stresses: 'integer, bit ops',
  unit: 'MB/s',
  seed: 1,
  // standard: 128 MB buffer, ~400 ms per run on the reference PC (Node, ~320 MB/s).
  sizes: { smoke: 4_096, standard: 128_000_000 },
  expected: { smoke: 349_656_606, standard: 2_780_954_640 },
  // Each run hashes `size` bytes once.
  work: (size) => size / 1e6,
};
