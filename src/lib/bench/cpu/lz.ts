// LZ77-style compress + decompress round trip (kernels/src/lz.rs).
import type { KernelDef } from '../types.ts';

export const lz: KernelDef = {
  id: 'lz',
  name: 'LZ compress + decompress',
  stresses: 'branches, memory access',
  unit: 'MB/s',
  seed: 1,
  // standard: 128 MB input (~3.5x compressible), ~310 ms per run on the reference
  // PC (Node, ~420 MB/s). Arena use is about 3 x size (input, compressed, output).
  sizes: { smoke: 65_536, standard: 128_000_000 },
  expected: { smoke: 3_426_800_092, standard: 49_043_669 },
  // MB of input per run. Each input byte is compressed once and decompressed once
  // (plus a verify compare); the figure counts input bytes, not both directions.
  work: (size) => size / 1e6,
};
