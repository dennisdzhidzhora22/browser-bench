/// <reference lib="webworker" />
// Storage benchmark worker (docs/SPEC.md, 3.5). Same init/run protocol as
// gpu.worker.ts, but the tests use OPFS through FileSystemSyncAccessHandle,
// which only dedicated workers get. The page sends no kernel module, only
// `storage.dir`: this run's OPFS directory. Each test creates its file in
// prepare and deletes it in dispose; the page deletes the directory after the
// run, because a cancelled (terminated) worker cannot clean up.

import { storageFactories } from '../lib/bench/storage/kernels.ts';
import type { StorageKernel } from '../lib/bench/storage/types.ts';
import type {
  FromWorker,
  RunRequest,
  StorageInit,
  ToWorker,
} from '../lib/harness/protocol.ts';
import { fastestSpread } from '../lib/harness/stats.ts';

declare const self: DedicatedWorkerGlobalScope;

/** Upper bound on repetitions per sample, so a broken timing cannot stall a run. */
const MAX_REPS = 10_000;

let dir: FileSystemDirectoryHandle | undefined;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function init(storage: StorageInit): Promise<Record<string, string>> {
  if (typeof self.navigator.storage?.getDirectory !== 'function') {
    throw new Error('this browser has no Origin Private File System (OPFS)');
  }
  if (typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('this browser has OPFS but no synchronous file access in workers');
  }
  const root = await self.navigator.storage.getDirectory();
  dir = await root.getDirectoryHandle(storage.dir, { create: true });
  return { api: 'OPFS, sync access handle', dir: storage.dir };
}

/** One timed batch. Only the synchronous OPFS calls of runBatch sit between the timer reads. */
function timeBatch(k: StorageKernel, reps: number): number {
  k.beforeBatch();
  const t0 = performance.now();
  k.runBatch(reps);
  return performance.now() - t0;
}

async function run(d: FileSystemDirectoryHandle, req: RunRequest): Promise<void> {
  const factory = storageFactories[req.kernel];
  if (!factory) throw new Error(`storage test "${req.kernel}" not found`);
  const k = factory();
  try {
    const p0 = performance.now();
    await k.prepare(d, req.seed, req.size);
    const prepareMs = performance.now() - p0;

    // Warm-up, then calibrate reps so each sample lasts about targetMs: double
    // the batch until it takes at least a quarter of the target, then scale.
    timeBatch(k, 1);
    const target = req.targetMs ?? 0;
    let reps = 1;
    let short = false;
    if (target > 0) {
      let probe = 1;
      let dt = timeBatch(k, probe);
      while (dt < target / 4 && probe < MAX_REPS) {
        probe = Math.min(MAX_REPS, probe * 2);
        dt = timeBatch(k, probe);
      }
      reps = dt > 0 ? Math.min(MAX_REPS, Math.max(1, Math.round((target * probe) / dt))) : MAX_REPS;
      short = reps === MAX_REPS && dt * (reps / probe) < target / 2;
    }

    const times = new Float64Array(req.maxSamples);
    const scratch = new Float64Array(req.maxSamples);
    const start = performance.now();
    let n = 0;
    while (n < req.maxSamples) {
      times[n++] = timeBatch(k, reps);
      if (n < req.minSamples) continue;
      if (fastestSpread(times, n, req.minSamples, scratch) <= req.targetSpread) break;
      if (performance.now() - start > req.maxMs) break;
    }

    const check = k.validate();
    const taken = times.slice(0, n);
    reply(
      {
        type: 'result',
        id: req.id,
        kernel: req.kernel,
        checksum: check.ok ? 1 : 0,
        checksumConsistent: true,
        prepareMs,
        times: taken,
        reps,
        ...(short ? { short } : {}),
        ...(check.ok || !check.detail ? {} : { detail: check.detail }),
      },
      [taken.buffer],
    );
  } finally {
    await k.dispose();
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const req = event.data;
  if (req.type === 'init') {
    try {
      if (!req.storage) throw new Error('storage worker needs a run directory');
      const info = dir ? {} : await init(req.storage);
      reply({ type: 'ready', abi: 0, info });
    } catch (err) {
      reply({ type: 'error', message: errorText(err) });
    }
    return;
  }
  if (req.type !== 'run') {
    reply({ type: 'error', id: req.id, message: `storage worker does not support "${req.type}"` });
    return;
  }
  try {
    if (!dir) throw new Error('worker not initialised');
    await run(dir, req);
  } catch (err) {
    reply({ type: 'error', id: req.id, kernel: req.kernel, message: errorText(err) });
  }
};

function errorText(err: unknown): string {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return 'storage quota exceeded while writing the test file';
  }
  return err instanceof Error ? err.message : String(err);
}
