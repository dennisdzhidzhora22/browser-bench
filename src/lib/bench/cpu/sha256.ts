// SHA-256 over a fixed pseudo-random buffer (kernels/src/sha256.rs).
import type { KernelDef } from '../types.ts';

/** Hash passes per `run` call (PASSES in kernels/src/sha256.rs). */
export const SHA256_PASSES = 8;

export const sha256: KernelDef = {
  id: 'sha256',
  name: 'SHA-256',
  stresses: 'integer, bit ops',
  unit: 'MB/s',
  seed: 1,
  // standard: 16 MB buffer hashed SHA256_PASSES times, ~410-480 ms per run on
  // the reference PC (Node). Small buffer so one instance per core stays cheap.
  sizes: { smoke: 4_096, standard: 16_000_000 },
  expected: { smoke: 222_303_941, standard: 4_203_668_933 },
  // MB hashed per run = size x passes / 1e6.
  work: (size) => (size * SHA256_PASSES) / 1e6,
};
