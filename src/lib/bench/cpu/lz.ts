// LZ77-style compress + decompress round trip (kernels/src/lz.rs).
import type { KernelDef } from '../types.ts';

/** Compress + decompress passes per `run` call (PASSES in kernels/src/lz.rs). */
export const LZ_PASSES = 12;

export const lz: KernelDef = {
  id: 'lz',
  name: 'LZ compress + decompress',
  stresses: 'branches, memory access',
  unit: 'MB/s',
  seed: 1,
  // standard: 16 MB input (~3.5x compressible), 12 passes, ~550 ms per run on
  // the reference PC (Node). Arena use is about 3 x size (~48 MB).
  sizes: { smoke: 65_536, standard: 16_000_000 },
  expected: { smoke: 1_494_155_333, standard: 3_626_520_757 },
  // All-cores test: smaller size so one instance per core fits in memory.
  multi: { size: 2_000_000, expected: 1_205_869_237 },
  // MB of input processed per run = size x passes / 1e6. Each pass compresses
  // every input byte once and decompresses it once (plus a verify compare); the
  // figure counts input bytes per pass, not both directions.
  work: (size) => (size * LZ_PASSES) / 1e6,
};
