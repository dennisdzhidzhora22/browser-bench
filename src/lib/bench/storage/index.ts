// Storage tests registry, sizing and cleanup (docs/SPEC.md, 3.5). Page side:
// the test code itself is in ./kernels.ts and loads only in the storage worker.
//
// Size. `size` is the test file in bytes. Standard is 256 MiB: one pass of the
// sequential tests is then well over the 250 ms sample target on a fast SSD,
// and the random tests spread over 65,536 blocks. It cannot defeat the OS
// file cache (that would take a file larger than RAM, so minutes of writing
// and gigabytes of quota), so read numbers include cache hits; the results
// page says so (SPEC R4). Before a run the page scales the file down to fit
// a quarter of the quota left for this site.
//
// Cleanup. Every run's files live in one OPFS directory named DIR_PREFIX +
// a unique suffix. Cancel terminates the worker, which then cannot clean up,
// so the page removes the directory after every run (done, error or cancel)
// and sweeps leftovers from crashed runs at page load and before each storage
// run. A Web Lock per directory keeps the sweep away from live runs in other tabs.

import type { KernelDef, SizeId } from '../types.ts';
import {
  CHUNK,
  DIR_PREFIX,
  MIB,
  RANDOM_OPS,
  STORAGE_TARGET_MS,
  STORAGE_VALID,
} from './types.ts';

/** Test file size in bytes, per size id. */
export const STORAGE_SIZES: Record<SizeId, number> = { smoke: 2 * MIB, standard: 256 * MIB };
/** Smallest standard-size file worth running; below this the page reports low quota. */
export const MIN_STANDARD_BYTES = 16 * MIB;
/** Use at most this fraction of the quota left for the site. */
export const QUOTA_FRACTION = 0.25;

const common = {
  seed: 1,
  sizes: STORAGE_SIZES,
  expected: { smoke: STORAGE_VALID, standard: STORAGE_VALID },
  targetMs: STORAGE_TARGET_MS,
} as const;

const mb = (size: number) => size / 1e6;

export const storageKernels: readonly KernelDef[] = [
  {
    id: 'storage_seq_write',
    name: 'Sequential write + flush',
    stresses: '1 MiB writes, then flush()',
    unit: 'MB/s',
    work: mb,
    ...common,
  },
  {
    id: 'storage_seq_read',
    name: 'Sequential read',
    stresses: '1 MiB reads',
    unit: 'MB/s',
    work: mb,
    ...common,
  },
  {
    id: 'storage_rand_write',
    name: 'Random write 4 KiB',
    stresses: `${RANDOM_OPS} writes, then flush()`,
    unit: 'IOPS',
    work: () => RANDOM_OPS,
    ...common,
  },
  {
    id: 'storage_rand_read',
    name: 'Random read 4 KiB',
    stresses: `${RANDOM_OPS} reads`,
    unit: 'IOPS',
    work: () => RANDOM_OPS,
    ...common,
  },
];

/** The defs with the size actually used for `sizeId` (after fitting the quota). */
export function storageDefsFor(sizeId: SizeId, fileBytes: number): KernelDef[] {
  return storageKernels.map((d) => ({ ...d, sizes: { ...d.sizes, [sizeId]: fileBytes } }));
}

export type StoragePlan =
  | { ok: true; fileBytes: number; scaled: boolean; freeBytes?: number }
  | { ok: false; message: string };

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n >= MIB) return `${Math.round(n / MIB)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}

/**
 * Check that OPFS exists and pick the file size: the standard size, or less
 * when a quarter of the quota left is smaller. Runs before any measurement.
 */
export async function planStorage(sizeId: SizeId): Promise<StoragePlan> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    return {
      ok: false,
      message:
        'This browser has no Origin Private File System (OPFS), so the storage tests cannot run.',
    };
  }
  const want = STORAGE_SIZES[sizeId];
  let free: number | undefined;
  try {
    const e = await navigator.storage.estimate();
    if (e.quota !== undefined) free = Math.max(0, e.quota - (e.usage ?? 0));
  } catch {
    // no estimate: try the standard size
  }
  const fit = free === undefined ? want : Math.floor((free * QUOTA_FRACTION) / CHUNK) * CHUNK;
  const fileBytes = Math.min(want, fit);
  const min = sizeId === 'smoke' ? want : MIN_STANDARD_BYTES;
  if (fileBytes < min) {
    return {
      ok: false,
      message:
        `Not enough storage quota: this site may use ${formatBytes(free ?? 0)} more, and the ` +
        `storage tests need at least ${formatBytes(min / QUOTA_FRACTION)} free (they use a ` +
        `quarter of it). Free disk space or clear this site's data, then try again.`,
    };
  }
  return { ok: true, fileBytes, scaled: fileBytes < want, ...(free !== undefined ? { freeBytes: free } : {}) };
}

/** A fresh, unique directory name for one run. */
export function newRunDir(): string {
  return `${DIR_PREFIX}${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long the page keeps retrying to remove a run's directory after the run. */
export const REMOVE_BUDGET_MS = 15_000;

/**
 * Remove `name` (recursively) from the OPFS root. A terminated worker keeps
 * its file lock until the browser has torn it down, which can take seconds
 * when it was inside a large synchronous write (measured: about 2 s while
 * writing the 256 MiB file), so retry with backoff for up to `budgetMs`
 * (NoModificationAllowedError until then). True when the directory is gone.
 */
export async function removeRunDir(name: string, budgetMs = REMOVE_BUDGET_MS): Promise<boolean> {
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    return false;
  }
  const start = performance.now();
  let delay = 50;
  for (;;) {
    try {
      await root.removeEntry(name, { recursive: true });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return true;
      if (performance.now() - start + delay > budgetMs) return false;
      await sleep(delay);
      delay = Math.min(500, delay * 2);
    }
  }
}

/** Names of all test directories in the OPFS root. */
export async function listRunDirs(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  const out: string[] = [];
  for await (const [name, h] of root.entries()) {
    if (h.kind === 'directory' && name.startsWith(DIR_PREFIX)) out.push(name);
  }
  return out;
}

/**
 * Run `fn` while holding a Web Lock named after the run directory. The lock
 * belongs to the page (Worker.terminate() does not release it) and the
 * browser drops it when the page unloads, so "lock free" means "no live run
 * uses this directory", in this tab or any other.
 */
export async function withRunLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return fn();
  return navigator.locks.request(dir, () => fn());
}

/**
 * Remove test directories left by crashed, closed or reloaded runs. A
 * directory whose lock is held belongs to a live run in another tab and is
 * skipped. A free lock proves it is stale, so the full retry budget is safe
 * (a just-closed page's worker can keep its file lock for seconds).
 */
export async function sweepRunDirs(): Promise<void> {
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') return;
    for (const name of await listRunDirs()) {
      if (!navigator.locks) {
        await removeRunDir(name, 500); // no Web Locks: short budget, live runs stay locked
        continue;
      }
      await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
        if (lock) await removeRunDir(name, REMOVE_BUDGET_MS);
      });
    }
  } catch {
    // best effort; the next run or page load tries again
  }
}
