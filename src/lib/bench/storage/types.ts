// Shared shapes and file layout for the storage tests (docs/SPEC.md, 3.5).
//
// File layout. The file is a sequence of 4 KiB blocks. Block b holds:
//   bytes 0..3   u32 b (its own index), so a read from the wrong offset fails
//   bytes 4..7   u32 gen (which write pass produced it), so a skipped write fails
//   bytes 8..    bytes 8.. of pattern slot (b mod SLOTS), seeded random data
// The pattern is PATTERN_BYTES of xorshift32 output from the test's seed. Each
// 1 MiB chunk of the file is the pattern with the two header words stamped in,
// so a write source is the pattern buffer itself after stamping (no copies, no
// allocation). Header words are native-endian u32; writer and checker use the
// same Uint32Array view, so the file round-trips on any machine.

/** Random-access unit, and the block size of the layout above. */
export const BLOCK = 4096;
/** Sequential chunk and pattern length: 1 MiB. File sizes are multiples of this. */
export const CHUNK = 1 << 20;
export const SLOTS = CHUNK / BLOCK; // 256
export const MIB = 1 << 20;

/**
 * Random 4 KiB operations per repetition of a random test. Small, so the rep
 * calibration (not this constant) sets the sample length: about 70 ms per rep
 * at 3,500 IOPS, and still at least READ_RING.
 */
export const RANDOM_OPS = 256;
/** Precomputed random block indices; ops walk this list and wrap. Power of two. */
export const RANDOM_LIST = 1 << 16;
/** Random reads land in a ring of this many 4 KiB slots, checked after timing. */
export const READ_RING = 64;
/** Sequential reads land in a ring of this many 1 MiB chunks, checked after timing. */
export const SEQ_RING = 16;

/** Expected value meaning "output validated" (same convention as GPU_VALID). */
export const STORAGE_VALID = 1;
/** Target length of one timed sample, standard size (SPEC 5: at least 250 ms). */
export const STORAGE_TARGET_MS = 250;

/** Every run's files live in one OPFS directory whose name starts with this. */
export const DIR_PREFIX = 'bb-storage-';

export interface StorageKernel {
  /** Create and (for read tests) fill the file. Untimed. */
  prepare(dir: FileSystemDirectoryHandle, seed: number, size: number): Promise<void>;
  /** Untimed, before each timed batch: clear read buffers so stale data cannot pass. */
  beforeBatch(): void;
  /** `reps` repetitions. Synchronous OPFS calls only; nothing allocated. Timed. */
  runBatch(reps: number): void;
  /** Check what the timed batches read or wrote. Untimed. */
  validate(): { ok: boolean; detail?: string };
  /** Close the access handle and delete the file. Must not throw. */
  dispose(): Promise<void>;
}

export type StorageKernelFactory = () => StorageKernel;
