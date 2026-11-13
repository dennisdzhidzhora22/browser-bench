// LZ77-style compress + decompress round trip (kernels/src/lz.rs).
import type { KernelDef } from '../types.ts';

/** Compress + decompress passes per `run` call (PASSES in kernels/src/lz.rs). */
export const LZ_PASSES = 2;

export const lz: KernelDef = {
  id: 'lz',
  name: 'LZ compress + decompress',
  stresses: 'branches, memory access',
  unit: 'MB/s',
  seed: 1,
  // standard: 64 MB input (~3.5x compressible), 2 passes, ~330 ms per run on the
  // reference PC (Node, ~390 MB/s). Arena use is about 3 x size (~192 MB).
  sizes: { smoke: 65_536, standard: 64_000_000 },
  expected: { smoke: 1_870_316_165, standard: 1_150_290_637 },
  // MB of input processed per run = size x passes / 1e6. Each pass compresses
  // every input byte once and decompresses it once (plus a verify compare); the
  // figure counts input bytes per pass, not both directions.
  work: (size) => (size * LZ_PASSES) / 1e6,
};
