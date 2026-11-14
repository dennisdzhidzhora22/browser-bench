// Storage test implementations (docs/SPEC.md, 3.5). Worker only: they use
// FileSystemSyncAccessHandle, which browsers expose only in dedicated workers.
// The file layout and the check rules are described in ./types.ts.
//
// Timed code (runBatch) makes only synchronous read/write/flush calls on
// preallocated buffers and views. The `{ at }` options object is allocated once
// and mutated. Everything else (creating, filling, checking, deleting the file)
// happens outside the timed region.

import {
  BLOCK,
  CHUNK,
  RANDOM_LIST,
  RANDOM_OPS,
  READ_RING,
  SEQ_RING,
  SLOTS,
  type StorageKernel,
  type StorageKernelFactory,
} from './types.ts';

const WORDS_PER_BLOCK = BLOCK / 4;
/** Blocks read back after a sequential-write test, besides the first and last chunk. */
const WRITE_SAMPLES = 64;

/** Deterministic u32 PRNG (xorshift32). */
function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

interface Pattern {
  bytes: Uint8Array<ArrayBuffer>;
  words: Uint32Array<ArrayBuffer>;
}

function makePattern(seed: number): Pattern {
  const words = new Uint32Array(CHUNK / 4);
  const next = xorshift(seed);
  for (let i = 0; i < words.length; i++) words[i] = next();
  return { bytes: new Uint8Array(words.buffer), words };
}

/** Stamp the header words of every block in chunk `c`, so `p.bytes` is that chunk's content. */
function stampChunk(p: Pattern, c: number, gen: number): void {
  const base = c * SLOTS;
  const w = p.words;
  for (let s = 0; s < SLOTS; s++) {
    w[s * WORDS_PER_BLOCK] = base + s;
    w[s * WORDS_PER_BLOCK + 1] = gen;
  }
}

/** Seeded random block indices in [0, blocks). */
function randomBlocks(seed: number, blocks: number, count: number): Uint32Array {
  const next = xorshift(seed ^ 0x5bd1e995);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = next() % blocks;
  return out;
}

/**
 * Check one block held at `buf[at..at+BLOCK)` against the layout: index `b`,
 * generation `gen`, pattern bytes after the header. Returns why it failed.
 */
function checkBlock(
  p: Pattern,
  buf: Uint8Array,
  at: number,
  b: number,
  gen: number,
): string | undefined {
  const head = new Uint32Array(buf.buffer, buf.byteOffset + at, 2);
  if (head[0] !== b) return `block ${b}: holds index ${head[0]}`;
  if (head[1] !== gen) return `block ${b}: holds pass ${head[1]}, expected ${gen}`;
  const ref = (b % SLOTS) * BLOCK;
  for (let i = 8; i < BLOCK; i++) {
    if (buf[at + i] !== p.bytes[ref + i]) return `block ${b}: byte ${i} differs`;
  }
  return undefined;
}

/** Views of `buf` in `count` consecutive pieces of `len` bytes. Made once, before timing. */
function pieces(buf: Uint8Array<ArrayBuffer>, count: number, len: number): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < count; i++) out.push(buf.subarray(i * len, (i + 1) * len));
  return out;
}

/** File handling shared by all four tests. */
abstract class FileTest implements StorageKernel {
  protected h!: FileSystemSyncAccessHandle;
  protected p!: Pattern;
  protected size = 0;
  protected chunks = 0;
  protected blocks = 0;
  protected seed = 0;
  /** Reads or writes that moved fewer bytes than asked, during timing. */
  protected short = 0;
  /** Write pass counter; the file starts at pass 0. */
  protected gen = 0;
  protected readonly opt = { at: 0 };
  private dir: FileSystemDirectoryHandle | undefined;
  private name = '';

  constructor(private readonly id: string) {}

  async prepare(dir: FileSystemDirectoryHandle, seed: number, size: number): Promise<void> {
    if (size < CHUNK || size % CHUNK !== 0) throw new Error(`${this.id}: size must be a multiple of 1 MiB`);
    this.size = size;
    this.chunks = size / CHUNK;
    this.blocks = size / BLOCK;
    this.seed = seed;
    this.p = makePattern(seed);
    this.dir = dir;
    this.name = `${this.id}.bin`;
    const file = await dir.getFileHandle(this.name, { create: true });
    this.h = await file.createSyncAccessHandle();
    this.h.truncate(0);
    await this.setup();
  }

  /** Per-test preparation, after the file is open and empty. */
  protected abstract setup(): Promise<void> | void;
  abstract runBatch(reps: number): void;
  abstract validate(): { ok: boolean; detail?: string };
  beforeBatch(): void {}

  /** Write the whole file at pass 0 and flush (untimed). */
  protected fill(): void {
    for (let c = 0; c < this.chunks; c++) {
      stampChunk(this.p, c, 0);
      this.opt.at = c * CHUNK;
      if (this.h.write(this.p.bytes, this.opt) !== CHUNK) throw new Error(`${this.id}: short write while preparing`);
    }
    this.h.flush();
  }

  /** Read block `b` from the file into `buf` and check it (untimed). */
  protected readCheck(buf: Uint8Array<ArrayBuffer>, b: number, gen: number): string | undefined {
    this.opt.at = b * BLOCK;
    const n = this.h.read(buf, this.opt);
    if (n !== BLOCK) return `block ${b}: read back ${n} bytes`;
    return checkBlock(this.p, buf, 0, b, gen);
  }

  protected shortDetail(): { ok: false; detail: string } {
    return { ok: false, detail: `${this.short} operations moved fewer bytes than asked` };
  }

  async dispose(): Promise<void> {
    try {
      this.h?.close();
    } catch {
      // already closed
    }
    try {
      if (this.dir && this.name) await this.dir.removeEntry(this.name);
    } catch {
      // the page removes the whole run directory afterwards
    }
  }
}

/** Sequential write of the whole file in 1 MiB chunks, then flush(). One rep = one pass. */
class SeqWrite extends FileTest {
  protected setup(): void {}

  runBatch(reps: number): void {
    const h = this.h;
    const p = this.p;
    const opt = this.opt;
    for (let r = 0; r < reps; r++) {
      const gen = ++this.gen;
      for (let c = 0; c < this.chunks; c++) {
        stampChunk(p, c, gen);
        opt.at = c * CHUNK;
        if (h.write(p.bytes, opt) !== CHUNK) this.short++;
      }
      h.flush();
    }
  }

  validate(): { ok: boolean; detail?: string } {
    if (this.short) return this.shortDetail();
    if (this.h.getSize() !== this.size) return { ok: false, detail: `file is ${this.h.getSize()} bytes, expected ${this.size}` };
    // Every block of the last pass carries its generation, so read back the
    // first and last chunk and seeded random blocks, all at the latest pass.
    const buf = new Uint8Array(BLOCK);
    const check: number[] = [];
    for (let s = 0; s < SLOTS; s++) check.push(s, this.blocks - SLOTS + s);
    for (const b of randomBlocks(this.seed + 1, this.blocks, WRITE_SAMPLES)) check.push(b);
    for (const b of check) {
      const err = this.readCheck(buf, b, this.gen);
      if (err) return { ok: false, detail: err };
    }
    return { ok: true };
  }
}

/** Sequential read of the whole file in 1 MiB chunks. One rep = one pass. */
class SeqRead extends FileTest {
  private ring!: Uint8Array<ArrayBuffer>;
  private views!: Uint8Array<ArrayBuffer>[];
  private slots = 0;

  protected setup(): void {
    this.fill();
    this.slots = Math.min(SEQ_RING, this.chunks);
    this.ring = new Uint8Array(this.slots * CHUNK);
    this.views = pieces(this.ring, this.slots, CHUNK);
  }

  override beforeBatch(): void {
    this.ring.fill(0);
  }

  runBatch(reps: number): void {
    const h = this.h;
    const opt = this.opt;
    const views = this.views;
    const slots = this.slots;
    for (let r = 0; r < reps; r++) {
      for (let c = 0; c < this.chunks; c++) {
        opt.at = c * CHUNK;
        if (h.read(views[c % slots]!, opt) !== CHUNK) this.short++;
      }
    }
  }

  validate(): { ok: boolean; detail?: string } {
    if (this.short) return this.shortDetail();
    // The ring was cleared before the last batch and now holds the file's last
    // `slots` chunks: check every block in them.
    for (let c = this.chunks - this.slots; c < this.chunks; c++) {
      const buf = this.views[c % this.slots]!;
      for (let s = 0; s < SLOTS; s++) {
        const err = checkBlock(this.p, buf, s * BLOCK, c * SLOTS + s, 0);
        if (err) return { ok: false, detail: err };
      }
    }
    return { ok: true };
  }
}

/** Shared by the random tests: a seeded list of block indices, walked in order. */
abstract class RandomTest extends FileTest {
  protected list!: Uint32Array;
  /** Operations done so far; op k uses list[k % RANDOM_LIST]. */
  protected k = 0;

  protected setup(): void {
    this.fill();
    this.list = randomBlocks(this.seed, this.blocks, RANDOM_LIST);
    this.k = 0;
  }
}

/** Random 4 KiB writes at block-aligned offsets, then flush(). One rep = RANDOM_OPS writes. */
class RandWrite extends RandomTest {
  private slotViews!: Uint8Array<ArrayBuffer>[];

  protected override setup(): void {
    super.setup();
    this.slotViews = pieces(this.p.bytes, SLOTS, BLOCK);
  }

  runBatch(reps: number): void {
    const h = this.h;
    const opt = this.opt;
    const w = this.p.words;
    const list = this.list;
    const views = this.slotViews;
    const mask = RANDOM_LIST - 1;
    for (let r = 0; r < reps; r++) {
      const gen = ++this.gen;
      for (let i = 0; i < RANDOM_OPS; i++) {
        const b = list[this.k++ & mask]!;
        const slot = b % SLOTS;
        w[slot * WORDS_PER_BLOCK] = b;
        w[slot * WORDS_PER_BLOCK + 1] = gen;
        opt.at = b * BLOCK;
        if (h.write(views[slot]!, opt) !== BLOCK) this.short++;
      }
      h.flush();
    }
  }

  validate(): { ok: boolean; detail?: string } {
    if (this.short) return this.shortDetail();
    // The last READ_RING ops all belong to the last rep, so their blocks must
    // hold the latest pass (the file was filled at pass 0).
    const buf = new Uint8Array(BLOCK);
    const mask = RANDOM_LIST - 1;
    for (let j = this.k - READ_RING; j < this.k; j++) {
      const err = this.readCheck(buf, this.list[j & mask]!, this.gen);
      if (err) return { ok: false, detail: err };
    }
    return { ok: true };
  }
}

/** Random 4 KiB reads at block-aligned offsets. One rep = RANDOM_OPS reads. */
class RandRead extends RandomTest {
  private ring!: Uint8Array<ArrayBuffer>;
  private views!: Uint8Array<ArrayBuffer>[];

  protected override setup(): void {
    super.setup();
    this.ring = new Uint8Array(READ_RING * BLOCK);
    this.views = pieces(this.ring, READ_RING, BLOCK);
  }

  override beforeBatch(): void {
    this.ring.fill(0);
  }

  runBatch(reps: number): void {
    const h = this.h;
    const opt = this.opt;
    const list = this.list;
    const views = this.views;
    const mask = RANDOM_LIST - 1;
    for (let r = 0; r < reps; r++) {
      for (let i = 0; i < RANDOM_OPS; i++) {
        const k = this.k++;
        opt.at = list[k & mask]! * BLOCK;
        if (h.read(views[k % READ_RING]!, opt) !== BLOCK) this.short++;
      }
    }
  }

  validate(): { ok: boolean; detail?: string } {
    if (this.short) return this.shortDetail();
    // The ring was cleared before the last batch and holds its last READ_RING reads.
    const mask = RANDOM_LIST - 1;
    for (let j = this.k - READ_RING; j < this.k; j++) {
      const err = checkBlock(this.p, this.views[j % READ_RING]!, 0, this.list[j & mask]!, 0);
      if (err) return { ok: false, detail: err };
    }
    return { ok: true };
  }
}

/** Factories by KernelDef.id, used by the storage worker. */
export const storageFactories: Readonly<Record<string, StorageKernelFactory>> = {
  storage_seq_write: () => new SeqWrite('storage_seq_write'),
  storage_seq_read: () => new SeqRead('storage_seq_read'),
  storage_rand_write: () => new RandWrite('storage_rand_write'),
  storage_rand_read: () => new RandRead('storage_rand_read'),
};
