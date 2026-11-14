// Storage tests that need no browser: defs, sizing/cleanup helpers (faked navigator.storage), the four
// test kernels driven against an in-memory OPFS fake, the storage worker driven in-process, and how the
// orchestrator treats a storage run. Nothing here asserts on speed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { components } from '../../src/lib/bench/components.ts';
import { storageFactories } from '../../src/lib/bench/storage/kernels.ts';
import {
  formatBytes,
  listRunDirs,
  MIN_STANDARD_BYTES,
  newRunDir,
  planStorage,
  QUOTA_FRACTION,
  removeRunDir,
  STORAGE_SIZES,
  storageDefsFor,
  storageKernels,
  sweepRunDirs,
} from '../../src/lib/bench/storage/index.ts';
import {
  BLOCK,
  CHUNK,
  DIR_PREFIX,
  MIB,
  RANDOM_OPS,
  READ_RING,
  SLOTS,
  STORAGE_TARGET_MS,
  STORAGE_VALID,
  type StorageKernel,
} from '../../src/lib/bench/storage/types.ts';
import { defKey, type KernelDef, type SizeId } from '../../src/lib/bench/types.ts';
import {
  resultToOutcome,
  SAMPLING,
  startRun,
} from '../../src/lib/harness/orchestrator.ts';
import type {
  FromWorker,
  InitRequest,
  RunRequest,
  RunResult,
  ToWorker,
} from '../../src/lib/harness/protocol.ts';
import {
  asDir,
  FakeFs,
  header,
  setHeader,
  type FakeDir,
  type FileFaults,
} from './fake-opfs.ts';

const SIZES: SizeId[] = ['smoke', 'standard'];
const IDS = ['storage_seq_write', 'storage_seq_read', 'storage_rand_write', 'storage_rand_read'];
const SMOKE = STORAGE_SIZES.smoke;

// ───────────────────────────────── defs ─────────────────────────────────

describe('storage defs', () => {
  it('are the four tests of SPEC 3.5, in a fixed order, with the right units', () => {
    expect(storageKernels.map((d) => d.id)).toEqual(IDS);
    expect(storageKernels.map((d) => d.unit)).toEqual(['MB/s', 'MB/s', 'IOPS', 'IOPS']);
  });

  it('ids and keys are unique and non-empty; names are set', () => {
    expect(new Set(storageKernels.map((d) => d.id)).size).toBe(storageKernels.length);
    const keys = storageKernels.map(defKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of storageKernels) {
      expect(d.name.length, d.id).toBeGreaterThan(0);
      expect(d.stresses.length, d.id).toBeGreaterThan(0);
    }
  });

  it('the Storage component is selectable and lists exactly these defs', () => {
    const c = components.find((x) => x.id === 'storage')!;
    expect(c.kernels).toBe(storageKernels);
    expect(c.kernels.length).toBeGreaterThan(0);
  });

  it('sizes: smoke 2 MiB, standard 256 MiB, whole MiB multiples, smoke < standard', () => {
    expect(STORAGE_SIZES).toEqual({ smoke: 2 * MIB, standard: 256 * MIB });
    for (const d of storageKernels) {
      for (const s of SIZES) {
        expect(Number.isInteger(d.sizes[s]), `${d.id} ${s}`).toBe(true);
        expect(d.sizes[s] % CHUNK, `${d.id} ${s}`).toBe(0);
        expect(d.sizes[s]).toBeGreaterThan(0);
      }
      expect(d.sizes.smoke).toBeLessThan(d.sizes.standard);
    }
  });

  it('work is positive and finite at both sizes', () => {
    for (const d of storageKernels) {
      for (const s of SIZES) {
        const w = d.work(d.sizes[s]);
        expect(Number.isFinite(w), `${d.id} work(${s})`).toBe(true);
        expect(w, `${d.id} work(${s})`).toBeGreaterThan(0);
      }
    }
  });

  it('known work formulas: sequential tests count decimal MB, random tests count operations', () => {
    const by = (id: string) => storageKernels.find((d) => d.id === id)!;
    for (const id of ['storage_seq_write', 'storage_seq_read']) {
      expect(by(id).work(256 * MIB)).toBeCloseTo(268.435456, 9);
      expect(by(id).work(2 * MIB)).toBeCloseTo(2.097152, 9);
    }
    for (const id of ['storage_rand_write', 'storage_rand_read']) {
      expect(by(id).work(256 * MIB)).toBe(RANDOM_OPS);
      expect(by(id).work(2 * MIB)).toBe(RANDOM_OPS);
    }
  });

  it('validated-output contract: expected is 1 everywhere, with the storage sample target', () => {
    expect(STORAGE_VALID).toBe(1);
    expect(STORAGE_TARGET_MS).toBeGreaterThanOrEqual(250); // SPEC 5: samples of at least 250 ms
    for (const d of storageKernels) {
      for (const s of SIZES) expect(d.expected[s], `${d.id} ${s}`).toBe(STORAGE_VALID);
      expect(d.targetMs, d.id).toBe(STORAGE_TARGET_MS);
      expect(d.seed, d.id).toBeGreaterThan(0);
    }
  });

  it('every def has a factory and every factory belongs to a def; factories give fresh kernels', () => {
    expect(Object.keys(storageFactories).sort()).toEqual([...IDS].sort());
    for (const d of storageKernels) {
      const a = storageFactories[d.id]!();
      expect(a, d.id).not.toBe(storageFactories[d.id]!());
      for (const m of ['prepare', 'beforeBatch', 'runBatch', 'validate', 'dispose'] as const) {
        expect(typeof a[m], `${d.id}.${m}`).toBe('function');
      }
    }
  });

  it('storageDefsFor changes only the chosen size id and leaves the originals alone', () => {
    const fitted = storageDefsFor('standard', 32 * MIB);
    expect(fitted.map((d) => d.id)).toEqual(IDS);
    for (const [i, d] of fitted.entries()) {
      expect(d.sizes.standard).toBe(32 * MIB);
      expect(d.sizes.smoke).toBe(SMOKE);
      expect(storageKernels[i]!.sizes.standard).toBe(256 * MIB);
    }
    const smoke = storageDefsFor('smoke', 4 * MIB);
    expect(smoke[0]!.sizes).toEqual({ smoke: 4 * MIB, standard: 256 * MIB });
  });
});

// ───────────────────────── sizing (faked navigator.storage) ─────────────────────────

describe('formatBytes', () => {
  it('picks GiB, MiB or KiB', () => {
    expect(formatBytes(3 * 1024 * MIB)).toBe('3.0 GiB');
    expect(formatBytes(64 * MIB)).toBe('64 MiB');
    expect(formatBytes(MIB)).toBe('1 MiB');
    expect(formatBytes(512 * 1024)).toBe('512 KiB');
  });
});

describe('planStorage (faked navigator.storage)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage(estimate: StorageEstimate | Error | undefined, hasOpfs = true): void {
    vi.stubGlobal('navigator', {
      storage: {
        ...(hasOpfs ? { getDirectory: async () => ({}) } : {}),
        estimate: async () => {
          if (estimate instanceof Error) throw estimate;
          return estimate ?? {};
        },
      },
    });
  }

  it('constants: a quarter of the quota left, 16 MiB minimum', () => {
    expect(QUOTA_FRACTION).toBe(0.25);
    expect(MIN_STANDARD_BYTES).toBe(16 * MIB);
  });

  it('plenty of quota: the full standard size, not scaled, with the free bytes reported', async () => {
    fakeStorage({ quota: 50 * 1024 * MIB, usage: 1 * MIB });
    expect(await planStorage('standard')).toEqual({
      ok: true,
      fileBytes: 256 * MIB,
      scaled: false,
      freeBytes: 50 * 1024 * MIB - 1 * MIB,
    });
  });

  it('exactly four times the standard size free is still not scaled', async () => {
    fakeStorage({ quota: 1024 * MIB, usage: 0 });
    const plan = await planStorage('standard');
    expect(plan).toMatchObject({ ok: true, fileBytes: 256 * MIB, scaled: false });
  });

  it('less quota: scaled down to a quarter of what is left, in whole MiB, and flagged scaled', async () => {
    fakeStorage({ quota: 500 * MIB, usage: 100 * MIB }); // 400 MiB left -> 100 MiB
    expect(await planStorage('standard')).toEqual({
      ok: true,
      fileBytes: 100 * MIB,
      scaled: true,
      freeBytes: 400 * MIB,
    });
    fakeStorage({ quota: 1000 * MIB + 1234, usage: 0 }); // 250 MiB + a bit: rounded down to whole MiB
    const plan = await planStorage('standard');
    expect(plan).toMatchObject({ ok: true, fileBytes: 250 * MIB, scaled: true });
    if (plan.ok) expect(plan.fileBytes % CHUNK).toBe(0);
  });

  it('the minimum: 64 MiB free gives exactly 16 MiB; one byte less is refused', async () => {
    fakeStorage({ quota: 64 * MIB, usage: 0 });
    expect(await planStorage('standard')).toMatchObject({ ok: true, fileBytes: 16 * MIB, scaled: true });
    fakeStorage({ quota: 64 * MIB - 1, usage: 0 });
    expect((await planStorage('standard')).ok).toBe(false);
  });

  it('below the minimum: a message that says how much is available and how much is needed', async () => {
    fakeStorage({ quota: 50 * MIB, usage: 10 * MIB });
    const plan = await planStorage('standard');
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toMatch(/Not enough storage quota/);
    expect(plan.message).toContain('40 MiB'); // what the site may still use
    expect(plan.message).toContain('64 MiB'); // 16 MiB / 0.25
    expect(plan.message).toMatch(/quarter/);
  });

  it('usage above quota counts as nothing left, not a negative number', async () => {
    fakeStorage({ quota: 10 * MIB, usage: 20 * MIB });
    const plan = await planStorage('standard');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('0 KiB');
  });

  it('a missing usage counts as 0', async () => {
    fakeStorage({ quota: 400 * MIB });
    expect(await planStorage('standard')).toMatchObject({ ok: true, fileBytes: 100 * MIB, scaled: true });
  });

  it('smoke: the 2 MiB file fits with 8 MiB free; with less it is refused (no scaling below smoke)', async () => {
    fakeStorage({ quota: 8 * MIB, usage: 0 });
    expect(await planStorage('smoke')).toMatchObject({ ok: true, fileBytes: 2 * MIB, scaled: false });
    fakeStorage({ quota: 4 * MIB, usage: 0 });
    const plan = await planStorage('smoke');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('8 MiB');
  });

  it('no estimate (no quota field, or estimate() throws): tries the full size, reports no free bytes', async () => {
    fakeStorage(undefined);
    const a = await planStorage('standard');
    expect(a).toEqual({ ok: true, fileBytes: 256 * MIB, scaled: false });
    expect('freeBytes' in a).toBe(false);
    fakeStorage(new Error('estimate failed'));
    expect(await planStorage('standard')).toEqual({ ok: true, fileBytes: 256 * MIB, scaled: false });
    fakeStorage({ usage: 5 }); // usage without quota
    expect(await planStorage('smoke')).toEqual({ ok: true, fileBytes: 2 * MIB, scaled: false });
  });

  it('no OPFS (no getDirectory, or no navigator.storage): a clear unavailable message', async () => {
    fakeStorage({ quota: 1e12, usage: 0 }, false);
    const a = await planStorage('standard');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.message).toMatch(/Origin Private File System/);
    vi.stubGlobal('navigator', {});
    const b = await planStorage('smoke');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.message).toMatch(/OPFS/);
  });
});

// ───────────────────────── run directory helpers ─────────────────────────

describe('run directory helpers (fake OPFS root)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function useFs(): FakeFs {
    const fs = new FakeFs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
    return fs;
  }

  it('newRunDir: starts with the prefix and is unique', () => {
    const names = Array.from({ length: 50 }, () => newRunDir());
    for (const n of names) expect(n.startsWith(DIR_PREFIX)).toBe(true);
    expect(DIR_PREFIX).toBe('bb-storage-');
    expect(new Set(names).size).toBe(names.length);
  });

  it('removeRunDir removes a directory with files and reports true; a missing one is also true', async () => {
    const fs = useFs();
    const d = await fs.root.getDirectoryHandle('bb-storage-a', { create: true });
    await d.getFileHandle('x.bin', { create: true });
    expect(await removeRunDir('bb-storage-a')).toBe(true);
    expect(fs.root.names()).toEqual([]);
    expect(await removeRunDir('bb-storage-never-existed')).toBe(true);
  });

  it('removeRunDir retries while a file is locked and succeeds once it is released', async () => {
    const fs = useFs();
    const d = await fs.root.getDirectoryHandle('bb-storage-a', { create: true });
    const h = await (await d.getFileHandle('x.bin', { create: true })).createSyncAccessHandle();
    setTimeout(() => h.close(), 120); // the "terminated worker" lets go a bit later
    expect(await removeRunDir('bb-storage-a', 5_000)).toBe(true);
    expect(fs.root.names()).toEqual([]);
  });

  it('removeRunDir gives up and returns false when the budget runs out; the directory stays', async () => {
    const fs = useFs();
    const d = await fs.root.getDirectoryHandle('bb-storage-a', { create: true });
    await (await d.getFileHandle('x.bin', { create: true })).createSyncAccessHandle(); // never closed
    expect(await removeRunDir('bb-storage-a', 200)).toBe(false);
    expect(fs.root.names()).toEqual(['bb-storage-a']);
  });

  it('removeRunDir returns false (does not throw) when OPFS cannot be opened', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          throw new Error('denied');
        },
      },
    });
    expect(await removeRunDir('bb-storage-a', 100)).toBe(false);
  });

  it('listRunDirs lists only directories whose name starts with the prefix', async () => {
    const fs = useFs();
    await fs.root.getDirectoryHandle('bb-storage-1', { create: true });
    await fs.root.getDirectoryHandle('bb-storage-2', { create: true });
    await fs.root.getDirectoryHandle('other', { create: true });
    await fs.root.getFileHandle('bb-storage-file', { create: true }); // a file, not a directory
    expect((await listRunDirs()).sort()).toEqual(['bb-storage-1', 'bb-storage-2']);
  });

  it('sweepRunDirs removes stale test directories and leaves everything else', async () => {
    const fs = useFs();
    const stale = await fs.root.getDirectoryHandle('bb-storage-old', { create: true });
    await stale.getFileHandle('storage_seq_write.bin', { create: true });
    await fs.root.getDirectoryHandle('keep-me', { create: true });
    await fs.root.getFileHandle('bb-storage-file', { create: true });
    // A directory locked by another tab's live run is skipped, not an error.
    const locked = await fs.root.getDirectoryHandle('bb-storage-busy', { create: true });
    await (await locked.getFileHandle('b.bin', { create: true })).createSyncAccessHandle();
    await sweepRunDirs();
    expect(fs.root.names()).toEqual(['bb-storage-busy', 'bb-storage-file', 'keep-me']);
  });

  it('sweepRunDirs removes everything when nothing is locked', async () => {
    const fs = useFs();
    for (const n of ['bb-storage-a', 'bb-storage-b']) await fs.root.getDirectoryHandle(n, { create: true });
    await fs.root.getDirectoryHandle('keep', { create: true });
    await sweepRunDirs();
    expect(fs.root.names()).toEqual(['keep']);
  });

  it('sweepRunDirs never throws: no OPFS, or a root that fails', async () => {
    vi.stubGlobal('navigator', {});
    await expect(sweepRunDirs()).resolves.toBeUndefined();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          throw new Error('denied');
        },
      },
    });
    await expect(sweepRunDirs()).resolves.toBeUndefined();
  });
});

// ───────────────────────── kernels against a fake OPFS ─────────────────────────

describe('storage kernels (in-memory OPFS)', () => {
  const SEED = 1;

  /** A fresh fs, a run directory in it, and a kernel prepared in it. */
  async function setup(id: string, faults: FileFaults = {}, size = SMOKE, seed = SEED) {
    const fs = new FakeFs();
    fs.faults[`${id}.bin`] = faults;
    const dir = await fs.root.getDirectoryHandle('bb-storage-t', { create: true });
    const k = storageFactories[id]!();
    await k.prepare(asDir(dir), seed, size);
    const h = () => fs.handleOf(dir, `${id}.bin`);
    return { fs, dir, k, h, bytes: () => h().bytes() };
  }

  /** One timed batch the way the worker does it. */
  const batch = (k: StorageKernel, reps: number) => {
    k.beforeBatch();
    k.runBatch(reps);
  };

  describe('prepare', () => {
    it.each(IDS)('%s: rejects sizes that are not a whole number of MiB', async (id) => {
      for (const bad of [0, 1, BLOCK, CHUNK - 1, CHUNK + 1, 1.5 * CHUNK]) {
        const fs = new FakeFs();
        const dir = await fs.root.getDirectoryHandle('d', { create: true });
        await expect(storageFactories[id]!().prepare(asDir(dir), 1, bad), `${id} ${bad}`).rejects.toThrow(/multiple of 1 MiB/);
      }
    });

    it.each(IDS)('%s: creates "<id>.bin" in the given directory', async (id) => {
      const { dir } = await setup(id);
      expect(dir.names()).toEqual([`${id}.bin`]);
    });

    it('the write tests start with an empty file; the read tests fill it to the full size', async () => {
      expect((await setup('storage_seq_write')).bytes().length).toBe(0);
      expect((await setup('storage_seq_read')).bytes().length).toBe(SMOKE);
      expect((await setup('storage_rand_read')).bytes().length).toBe(SMOKE);
      // The random write test overwrites in place, so it needs the full file first.
      expect((await setup('storage_rand_write')).bytes().length).toBe(SMOKE);
    });
  });

  describe('block layout: every 4 KiB block carries its index and a write-pass number', () => {
    it('a filled file has header [b, 0] in every block and the pattern after the header', async () => {
      const { bytes } = await setup('storage_seq_read');
      const f = bytes();
      const blocks = SMOKE / BLOCK;
      for (let b = 0; b < blocks; b++) expect(header(f, b), `block ${b}`).toEqual([b, 0]);
      // Block b and block b + SLOTS use the same pattern slot: identical after the 8 header bytes.
      for (const b of [0, 1, 37, 255]) {
        const a = f.subarray(b * BLOCK + 8, (b + 1) * BLOCK);
        const c = f.subarray((b + SLOTS) * BLOCK + 8, (b + SLOTS + 1) * BLOCK);
        expect(Buffer.from(a).equals(Buffer.from(c)), `slot ${b}`).toBe(true);
      }
      // ...and different slots differ (it is random data, not a constant).
      expect(Buffer.from(f.subarray(8, BLOCK)).equals(Buffer.from(f.subarray(BLOCK + 8, 2 * BLOCK)))).toBe(false);
    });

    it('the pattern depends on the seed: same seed same bytes, other seed other bytes', async () => {
      const a = await setup('storage_seq_read', {}, SMOKE, 1);
      const b = await setup('storage_seq_read', {}, SMOKE, 1);
      const c = await setup('storage_seq_read', {}, SMOKE, 2);
      expect(Buffer.from(a.bytes()).equals(Buffer.from(b.bytes()))).toBe(true);
      expect(Buffer.from(a.bytes()).equals(Buffer.from(c.bytes()))).toBe(false);
    });

    it('each sequential-write pass stamps its pass number into every block', async () => {
      const { k, bytes } = await setup('storage_seq_write');
      batch(k, 3);
      const f = bytes();
      expect(f.length).toBe(SMOKE);
      for (let b = 0; b < SMOKE / BLOCK; b++) expect(header(f, b), `block ${b}`).toEqual([b, 3]);
    });

    it('a random-write rep rewrites at most RANDOM_OPS blocks with the new pass number and their own index', async () => {
      const { k, bytes } = await setup('storage_rand_write');
      batch(k, 1);
      const f = bytes();
      let written = 0;
      for (let b = 0; b < SMOKE / BLOCK; b++) {
        const [idx, gen] = header(f, b);
        expect(idx, `block ${b}`).toBe(b);
        expect([0, 1], `block ${b} pass`).toContain(gen);
        if (gen === 1) written++;
      }
      expect(written).toBeGreaterThanOrEqual(1);
      expect(written).toBeLessThanOrEqual(RANDOM_OPS);
    });
  });

  describe('seeded random offsets', () => {
    async function offsets(id: string, seed: number, reps = 1): Promise<number[]> {
      const { k, h } = await setup(id, {}, SMOKE, seed);
      const before = h().readAt.length; // the read test's fill() does not read, but be explicit
      batch(k, reps);
      return h().readAt.slice(before);
    }

    it('a random-read rep issues RANDOM_OPS reads at 4 KiB-aligned offsets inside the file', async () => {
      const at = await offsets('storage_rand_read', 1);
      expect(at).toHaveLength(RANDOM_OPS);
      for (const o of at) {
        expect(o % BLOCK).toBe(0);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o + BLOCK).toBeLessThanOrEqual(SMOKE);
      }
      // Random, not a sweep: many different blocks, not in ascending order.
      expect(new Set(at).size).toBeGreaterThan(64);
      expect(at.some((o, i) => i > 0 && o < at[i - 1]!)).toBe(true);
    });

    it('the same seed gives the same offsets, a different seed gives different ones', async () => {
      const a = await offsets('storage_rand_read', 1);
      const b = await offsets('storage_rand_read', 1);
      const c = await offsets('storage_rand_read', 2);
      expect(b).toEqual(a);
      expect(c).not.toEqual(a);
    });

    it('later reps continue the sequence instead of repeating the first one', async () => {
      const two = await offsets('storage_rand_read', 1, 2);
      expect(two).toHaveLength(2 * RANDOM_OPS);
      expect(two.slice(RANDOM_OPS)).not.toEqual(two.slice(0, RANDOM_OPS));
    });

    it('a random-write rep writes at aligned in-range offsets (seen as changed blocks), deterministically', async () => {
      const changed = async (seed: number) => {
        const { k, bytes } = await setup('storage_rand_write', {}, SMOKE, seed);
        batch(k, 1);
        const f = bytes();
        const out: number[] = [];
        for (let b = 0; b < SMOKE / BLOCK; b++) if (header(f, b)[1] === 1) out.push(b);
        return out;
      };
      const a = await changed(1);
      expect(await changed(1)).toEqual(a);
      expect(await changed(2)).not.toEqual(a);
    });
  });

  describe('validation accepts a correct run', () => {
    it.each(IDS)('%s: validate() is ok after one and after several batches', async (id) => {
      const { k } = await setup(id);
      batch(k, 1);
      expect(k.validate()).toEqual({ ok: true });
      batch(k, 3);
      expect(k.validate()).toEqual({ ok: true });
    });

    it.each(IDS)('%s: still ok after a larger file (4 MiB)', async (id) => {
      const { k } = await setup(id, {}, 4 * MIB);
      batch(k, 2);
      expect(k.validate()).toEqual({ ok: true });
    });
  });

  describe('validation rejects wrong data', () => {
    it('seq write: a block holding the wrong index', async () => {
      const { k, bytes } = await setup('storage_seq_write');
      batch(k, 2);
      setHeader(bytes(), 7, 0, 8);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/block 7: holds index 8/);
    });

    it('seq write: a block holding an older pass (a skipped write)', async () => {
      const { k, bytes } = await setup('storage_seq_write');
      batch(k, 2);
      setHeader(bytes(), 300, 1, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/block 300: holds pass 1, expected 2/);
    });

    it('seq write: a damaged data byte after the header', async () => {
      const { k, bytes } = await setup('storage_seq_write');
      batch(k, 1);
      bytes()[5 * BLOCK + 100]! ^= 0xff;
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/block 5: byte 100 differs/);
    });

    it('seq write: a write that was reported done but never stored (dropped in the last pass)', async () => {
      // Writes 0,1 are pass 1 (two chunks); write 2 is pass 2, chunk 0: drop it.
      const { k } = await setup('storage_seq_write', { dropWrite: (_at, nth) => nth === 2 });
      batch(k, 2);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/holds pass 1, expected 2/);
    });

    it('seq write: a file of the wrong size', async () => {
      const { k, h } = await setup('storage_seq_write');
      batch(k, 1);
      h().truncate(SMOKE - CHUNK);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/file is \d+ bytes, expected 2097152/);
    });

    it('seq write: a write that moved fewer bytes than asked', async () => {
      const { k } = await setup('storage_seq_write', { shortWrite: true });
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/fewer bytes than asked/);
    });

    it('seq read: reads of a cleared buffer cannot pass (a read that moved nothing)', async () => {
      const { k } = await setup('storage_seq_read');
      batch(k, 1);
      expect(k.validate().ok).toBe(true);
      k.beforeBatch(); // clears the ring; no read ran after it
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/differs|holds index/);
    });

    it('seq read: a block with the wrong index in the file', async () => {
      const { k, bytes } = await setup('storage_seq_read');
      setHeader(bytes(), 511, 0, 510); // inside the last chunk
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/block 511: holds index 510/);
    });

    it('seq read: a block with the wrong pass number in the file', async () => {
      const { k, bytes } = await setup('storage_seq_read');
      setHeader(bytes(), 3, 1, 5);
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/block 3: holds pass 5, expected 0/);
    });

    it('seq read: reads that land at the wrong offset', async () => {
      const { k } = await setup('storage_seq_read', { readShift: CHUNK });
      batch(k, 1);
      expect(k.validate().ok).toBe(false);
    });

    it('seq read: a read that moved fewer bytes than asked', async () => {
      const { k } = await setup('storage_seq_read', { shortRead: true });
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/fewer bytes than asked/);
    });

    it('rand read: reads of a cleared buffer cannot pass', async () => {
      const { k } = await setup('storage_rand_read');
      batch(k, 1);
      expect(k.validate().ok).toBe(true);
      k.beforeBatch();
      expect(k.validate().ok).toBe(false);
    });

    it('rand read: every block holding the wrong index', async () => {
      const { k, bytes } = await setup('storage_rand_read');
      const f = bytes();
      for (let b = 0; b < SMOKE / BLOCK; b++) setHeader(f, b, 0, b + 1);
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/holds index/);
    });

    it('rand read: every block holding the wrong pass number', async () => {
      const { k, bytes } = await setup('storage_rand_read');
      const f = bytes();
      for (let b = 0; b < SMOKE / BLOCK; b++) setHeader(f, b, 1, 9);
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/holds pass 9, expected 0/);
    });

    it('rand read: reads from the wrong offset and short reads', async () => {
      const a = await setup('storage_rand_read', { readShift: BLOCK });
      batch(a.k, 1);
      expect(a.k.validate().ok).toBe(false);
      const b = await setup('storage_rand_read', { shortRead: true });
      batch(b.k, 1);
      const v = b.k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/fewer bytes than asked/);
    });

    it('rand write: writes that were reported done but never stored', async () => {
      // fill() writes 2 chunks (nth 0,1); everything after that is a timed random write.
      const { k } = await setup('storage_rand_write', { dropWrite: (_at, nth) => nth >= 2 });
      batch(k, 2);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/holds pass 0, expected 2/);
    });

    it('rand write: the last operations\' blocks hold an older pass', async () => {
      const { k, bytes } = await setup('storage_rand_write');
      batch(k, 1);
      const f = bytes();
      // Roll every written block back to pass 0: the last READ_RING ops must notice.
      for (let b = 0; b < SMOKE / BLOCK; b++) if (header(f, b)[1] === 1) setHeader(f, b, 1, 0);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/holds pass 0, expected 1/);
    });

    it('rand write: a damaged block among the last operations', async () => {
      const { k, bytes } = await setup('storage_rand_write');
      batch(k, 1);
      const f = bytes();
      for (let b = 0; b < SMOKE / BLOCK; b++) if (header(f, b)[1] === 1) f[b * BLOCK + 200]! ^= 0xff;
      expect(k.validate().ok).toBe(false);
    });

    it('rand write: a short write while preparing fails prepare; a short timed write fails validation', async () => {
      await expect(setup('storage_rand_write', { shortWrite: true })).rejects.toThrow(/short write while preparing/);
      const { k } = await setup('storage_rand_write', { shortWrite: (nth) => nth >= 2 });
      batch(k, 1);
      const v = k.validate();
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(/fewer bytes than asked/);
    });

    it('READ_RING is no larger than a rep, so validation always sees the latest pass', () => {
      expect(READ_RING).toBeLessThanOrEqual(RANDOM_OPS);
    });
  });

  describe('dispose', () => {
    it.each(IDS)('%s: closes the handle and deletes its file', async (id) => {
      const { k, h, dir } = await setup(id);
      batch(k, 1);
      const handle = h(); // the file is gone from the directory afterwards
      await k.dispose();
      expect(handle.closed).toBe(true);
      expect(dir.names()).toEqual([]);
    });

    it.each(IDS)('%s: is safe before prepare and when called twice', async (id) => {
      await expect(storageFactories[id]!().dispose()).resolves.toBeUndefined();
      const { k } = await setup(id);
      await k.dispose();
      await expect(k.dispose()).resolves.toBeUndefined();
    });

    it('does not throw when the file is already gone', async () => {
      const { k, dir } = await setup('storage_seq_read');
      await dir.removeEntry('storage_seq_read.bin').catch(() => {});
      await expect(k.dispose()).resolves.toBeUndefined();
    });
  });
});

// ───────────────────────── the storage worker, in-process ─────────────────────────

describe('storage.worker (in-process, fake OPFS)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  interface Setup {
    fs: FakeFs;
    replies: FromWorker[];
    send(msg: ToWorker): Promise<void>;
    rootNames(): string[];
    runDir(): FakeDir;
  }

  async function loadWorker(
    opts: { opfs?: boolean; syncApi?: boolean; faults?: Record<string, FileFaults> } = {},
  ): Promise<Setup> {
    const { opfs = true, syncApi = true, faults = {} } = opts;
    vi.resetModules();
    const fs = new FakeFs();
    Object.assign(fs.faults, faults);
    const replies: FromWorker[] = [];
    const fake: { postMessage(m: FromWorker): void; onmessage?: (e: { data: ToWorker }) => Promise<void>; navigator: unknown } = {
      postMessage: (m) => void replies.push(m),
      navigator: { storage: opfs ? { getDirectory: async () => fs.root } : {} },
    };
    vi.stubGlobal('self', fake);
    if (syncApi) vi.stubGlobal('FileSystemFileHandle', class { createSyncAccessHandle() {} });
    else vi.stubGlobal('FileSystemFileHandle', class {});
    await import('../../src/workers/storage.worker.ts');
    expect(typeof fake.onmessage).toBe('function');
    return {
      fs,
      replies,
      send: (data) => fake.onmessage!({ data }),
      rootNames: () => fs.root.names(),
      runDir: () => fs.root.children.get('bb-storage-w') as FakeDir,
    };
  }

  const init = (dir = 'bb-storage-w'): ToWorker => ({ type: 'init', spinMs: 0, storage: { dir } });
  const run = (kernel: string, over: Partial<RunRequest> = {}): RunRequest => ({
    type: 'run',
    id: 5,
    kernel,
    seed: 1,
    size: SMOKE,
    minSamples: 3,
    maxSamples: 3,
    targetSpread: 1,
    maxMs: 10_000,
    ...over,
  });
  const last = (s: Setup) => s.replies[s.replies.length - 1]!;

  it('init creates the run directory and replies ready with abi 0 and the API description', async () => {
    const s = await loadWorker();
    await s.send(init());
    expect(s.replies).toEqual([
      { type: 'ready', abi: 0, info: { api: 'OPFS, sync access handle', dir: 'bb-storage-w' } },
    ]);
    expect(s.rootNames()).toEqual(['bb-storage-w']);
  });

  it('init without a run directory is an error', async () => {
    const s = await loadWorker();
    await s.send({ type: 'init', spinMs: 0 });
    expect(last(s)).toMatchObject({ type: 'error', message: expect.stringMatching(/needs a run directory/) });
    expect(s.rootNames()).toEqual([]);
  });

  it('init without OPFS, or without synchronous access, is a clear error', async () => {
    const a = await loadWorker({ opfs: false });
    await a.send(init());
    expect(last(a)).toMatchObject({ type: 'error', message: expect.stringMatching(/no Origin Private File System/) });
    const b = await loadWorker({ syncApi: false });
    await b.send(init());
    expect(last(b)).toMatchObject({ type: 'error', message: expect.stringMatching(/no synchronous file access/) });
  });

  it('a run before init reports "worker not initialised"; so does a run after a failed init', async () => {
    const s = await loadWorker();
    await s.send(run('storage_seq_read'));
    expect(last(s)).toMatchObject({ type: 'error', id: 5, kernel: 'storage_seq_read', message: 'worker not initialised' });
    await s.send({ type: 'init', spinMs: 0 });
    await s.send(run('storage_seq_read'));
    expect(last(s)).toMatchObject({ type: 'error', message: 'worker not initialised' });
  });

  it('an unknown test name is an error carrying the id and kernel', async () => {
    const s = await loadWorker();
    await s.send(init());
    await s.send(run('storage_nope', { id: 9 }));
    expect(last(s)).toMatchObject({ type: 'error', id: 9, kernel: 'storage_nope', message: expect.stringMatching(/not found/) });
  });

  it('messages for the other workers are refused by name', async () => {
    const s = await loadWorker();
    await s.send(init());
    await s.send({ type: 'prepare', id: 2, kernel: 'x', seed: 1, size: 1 });
    expect(last(s)).toMatchObject({ type: 'error', id: 2, message: expect.stringMatching(/does not support "prepare"/) });
  });

  it.each(IDS)('%s: a smoke run gives a valid result (checksum 1), 3 samples, and leaves no file behind', async (id) => {
    const s = await loadWorker();
    await s.send(init());
    await s.send(run(id));
    const r = last(s) as RunResult;
    expect(r.type).toBe('result');
    expect(r).toMatchObject({ id: 5, kernel: id, checksum: STORAGE_VALID, checksumConsistent: true });
    expect(r.times).toHaveLength(3);
    expect(r.detail).toBeUndefined();
    expect(r.reps).toBe(1);
    expect(r.short).toBeUndefined();
    expect(s.runDir().names()).toEqual([]); // dispose removed the file
  });

  it('with targetMs it calibrates repetitions per sample (at least 1, never a failure)', async () => {
    const s = await loadWorker();
    await s.send(init());
    await s.send(run('storage_rand_read', { targetMs: 5 }));
    const r = last(s) as RunResult;
    expect(r.type).toBe('result');
    expect(r.checksum).toBe(STORAGE_VALID);
    expect(r.reps).toBeGreaterThanOrEqual(1);
  });

  it('all four tests can run one after another in the same directory', async () => {
    const s = await loadWorker();
    await s.send(init());
    for (const [i, id] of IDS.entries()) {
      await s.send(run(id, { id: i }));
      expect(last(s)).toMatchObject({ type: 'result', id: i, checksum: STORAGE_VALID });
    }
    expect(s.runDir().names()).toEqual([]);
  });

  it('failed validation: checksum 0 with the detail, and the file is still removed', async () => {
    const s = await loadWorker({ faults: { 'storage_seq_write.bin': { shortWrite: true } } });
    await s.send(init());
    await s.send(run('storage_seq_write'));
    const r = last(s) as RunResult;
    expect(r.type).toBe('result');
    expect(r.checksum).toBe(0);
    expect(r.detail).toMatch(/fewer bytes than asked/);
    expect(s.runDir().names()).toEqual([]);
  });

  it('a write error (quota) becomes a readable message, and the file is still removed', async () => {
    const s = await loadWorker({
      faults: { 'storage_seq_write.bin': { throwOnWrite: new DOMException('full', 'QuotaExceededError') } },
    });
    await s.send(init());
    await s.send(run('storage_seq_write'));
    expect(last(s)).toMatchObject({
      type: 'error',
      id: 5,
      kernel: 'storage_seq_write',
      message: 'storage quota exceeded while writing the test file',
    });
    expect(s.runDir().names()).toEqual([]);
  });

  it('any other error keeps its own message', async () => {
    const s = await loadWorker({ faults: { 'storage_rand_read.bin': { throwOnWrite: new Error('disk on fire') } } });
    await s.send(init());
    await s.send(run('storage_rand_read'));
    expect(last(s)).toMatchObject({ type: 'error', message: 'disk on fire' });
  });

  it('a bad size is an error, not a crash', async () => {
    const s = await loadWorker();
    await s.send(init());
    await s.send(run('storage_seq_read', { size: 1000 }));
    expect(last(s)).toMatchObject({ type: 'error', message: expect.stringMatching(/multiple of 1 MiB/) });
  });
});

// ───────────────────────── orchestrator: storage runs ─────────────────────────

describe('startRun with storage', () => {
  class FakeWorker {
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onmessageerror: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    terminated = 0;
    readonly received: ToWorker[] = [];
    constructor(private readonly handler: (m: ToWorker) => FromWorker | 'hang') {}
    postMessage(msg: ToWorker): void {
      this.received.push(msg);
      const reply = this.handler(msg);
      if (reply === 'hang') return;
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent<FromWorker>));
    }
    terminate(): void {
      this.terminated++;
    }
    get runs(): RunRequest[] {
      return this.received.filter((m): m is RunRequest => m.type === 'run');
    }
    get inits(): InitRequest[] {
      return this.received.filter((m): m is InitRequest => m.type === 'init');
    }
  }

  const ok = (defs: readonly KernelDef[], sizeId: SizeId) => (msg: ToWorker): FromWorker => {
    if (msg.type === 'init') return { type: 'ready', abi: 0, info: { api: 'OPFS, sync access handle' } };
    if (msg.type !== 'run') throw new Error(`unexpected ${msg.type}`);
    const def = defs.find((d) => d.id === msg.kernel)!;
    return {
      type: 'result',
      id: msg.id,
      kernel: msg.kernel,
      checksum: def.expected[sizeId],
      checksumConsistent: true,
      prepareMs: 1,
      times: Float64Array.of(10, 20, 30),
      reps: 4,
    };
  };

  it('does not call loadModule, and init carries storage unchanged but no module and no gpu', async () => {
    const w = new FakeWorker(ok(storageKernels, 'smoke'));
    let loads = 0;
    const outcomes = await startRun({
      kernels: storageKernels,
      size: 'smoke',
      mode: 'quick',
      storage: { dir: 'bb-storage-xyz' },
      spinMs: 0,
      loadModule: () => {
        loads++;
        return Promise.reject(new Error('should not be called'));
      },
      makeWorker: () => w as unknown as Worker,
    }).done;
    expect(loads).toBe(0);
    expect(w.inits).toHaveLength(1);
    expect('module' in w.inits[0]!).toBe(false);
    expect('gpu' in w.inits[0]!).toBe(false);
    expect(w.inits[0]!.storage).toEqual({ dir: 'bb-storage-xyz' });
    expect(outcomes.map((o) => o.def.id)).toEqual(IDS);
    expect(outcomes.every((o) => o.valid && o.checksumOk)).toBe(true);
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it('without storage, init has no storage field (and the module is loaded)', async () => {
    const w = new FakeWorker(ok(storageKernels, 'smoke'));
    let loads = 0;
    await startRun({
      kernels: [storageKernels[0]!],
      size: 'smoke',
      mode: 'quick',
      spinMs: 0,
      loadModule: () => {
        loads++;
        return Promise.resolve({} as WebAssembly.Module);
      },
      makeWorker: () => w as unknown as Worker,
    }).done;
    expect(loads).toBe(1);
    expect('storage' in w.inits[0]!).toBe(false);
  });

  it('run requests carry the fitted size, the sampling plan, and targetMs only at standard size', async () => {
    const fitted = storageDefsFor('standard', 32 * MIB);
    const w = new FakeWorker(ok(fitted, 'standard'));
    await startRun({
      kernels: fitted,
      size: 'standard',
      mode: 'quick',
      storage: { dir: 'bb-storage-a' },
      spinMs: 0,
      makeWorker: () => w as unknown as Worker,
    }).done;
    expect(w.runs.map((r) => r.size)).toEqual([32 * MIB, 32 * MIB, 32 * MIB, 32 * MIB]);
    for (const r of w.runs) expect(r).toMatchObject({ ...SAMPLING.quick, targetMs: STORAGE_TARGET_MS, seed: 1 });

    const sw = new FakeWorker(ok(storageKernels, 'smoke'));
    await startRun({
      kernels: storageKernels,
      size: 'smoke',
      mode: 'quick',
      storage: { dir: 'bb-storage-a' },
      spinMs: 0,
      makeWorker: () => sw as unknown as Worker,
    }).done;
    for (const r of sw.runs) {
      expect(r.size).toBe(SMOKE);
      expect('targetMs' in r).toBe(false);
    }
  });

  it('a worker init error (no OPFS) rejects the run without running anything', async () => {
    const w = new FakeWorker((m) =>
      m.type === 'init' ? { type: 'error', message: 'this browser has no Origin Private File System (OPFS)' } : 'hang',
    );
    await expect(
      startRun({
        kernels: storageKernels,
        size: 'smoke',
        mode: 'quick',
        storage: { dir: 'bb-storage-a' },
        spinMs: 0,
        makeWorker: () => w as unknown as Worker,
      }).done,
    ).rejects.toThrow(/worker init failed: .*OPFS/);
    expect(w.runs).toHaveLength(0);
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });
});

describe('resultToOutcome for storage results', () => {
  const seqWrite = storageKernels[0]!;
  const res = (over: Partial<RunResult> = {}): RunResult => ({
    type: 'result',
    id: 0,
    kernel: seqWrite.id,
    checksum: 1,
    checksumConsistent: true,
    prepareMs: 1,
    times: Float64Array.of(100, 100, 100),
    reps: 2,
    ...over,
  });

  it('checksum 1 is valid; throughput is work * reps / median seconds', () => {
    const o = resultToOutcome(seqWrite, SMOKE, 'smoke', 'quick', res());
    expect(o.valid).toBe(true);
    expect(o.checksumOk).toBe(true);
    // 2 MiB = 2.097152 MB, 2 reps, 0.1 s
    expect(o.throughput).toBeCloseTo((2.097152 * 2) / 0.1, 9);
  });

  it('checksum 0 is invalid and the worker detail reaches the error text', () => {
    const o = resultToOutcome(seqWrite, SMOKE, 'smoke', 'quick', res({ checksum: 0, detail: 'block 7: holds pass 1, expected 2' }));
    expect(o.valid).toBe(false);
    expect(o.checksumOk).toBe(false);
    expect(o.error).toBe('output check failed: block 7: holds pass 1, expected 2');
  });

  it('a short result is noisy but stays valid', () => {
    const o = resultToOutcome(seqWrite, SMOKE, 'smoke', 'quick', res({ short: true }));
    expect(o.noisy).toBe(true);
    expect(o.valid).toBe(true);
  });

  it('a hidden tab discards a valid storage result', () => {
    const o = resultToOutcome(seqWrite, SMOKE, 'smoke', 'quick', res(), true);
    expect(o.checksumOk).toBe(true);
    expect(o.valid).toBe(false);
    expect(o.error).toMatch(/hidden/);
  });
});
