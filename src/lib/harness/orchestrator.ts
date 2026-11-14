// Runs a list of kernels, one at a time, on one worker.
//
// Page work is kept out of measurements: the caller's `beforeKernel` hook runs
// (and may repaint) BEFORE each run request is posted, and nothing else
// happens on the page until the reply arrives.

import type { KernelDef, SizeId } from '../bench/types.ts';
import { loadKernelModule } from './module.ts';
import type {
  FromWorker,
  GpuInit,
  InitRequest,
  StorageInit,
  RunRequest,
  RunResult,
} from './protocol.ts';
import { fastest, summarize, type SampleStats } from './stats.ts';

export type RunMode = 'quick' | 'full';

export interface SamplingPlan {
  /** Samples always taken; results use the `minSamples` fastest. */
  minSamples: number;
  maxSamples: number;
  /** Stop early once the fastest `minSamples` agree within this fraction. */
  targetSpread: number;
  /** Stop adding samples past `minSamples` after this many ms. */
  maxMs: number;
}

/** Sampling per mode (docs/SPEC.md, section 5). */
export const SAMPLING: Record<RunMode, SamplingPlan> = {
  quick: { minSamples: 3, maxSamples: 9, targetSpread: 0.05, maxMs: 3_000 },
  full: { minSamples: 7, maxSamples: 21, targetSpread: 0.03, maxMs: 8_000 },
};

/** A result whose fastest samples still disagree by more than this is flagged noisy. */
export const NOISY_SPREAD = 0.1;

/** Busy-spin before the first kernel (see InitRequest.spinMs). */
export const SPIN_MS = 500;

export interface KernelOutcome {
  def: KernelDef;
  /** Stats over the `minSamples` fastest samples. Undefined when the kernel failed. */
  stats?: SampleStats;
  /** Headline number in `def.unit`, from `stats.median`. */
  throughput?: number;
  /** Timed samples actually taken. */
  samples?: number;
  checksumOk: boolean;
  /** True when the tab was hidden while this kernel ran. The result is discarded. */
  hidden: boolean;
  /** True when the fastest samples still spread more than NOISY_SPREAD. */
  noisy: boolean;
  /** Valid = checksum ok and not hidden. Noisy results are valid but flagged. */
  valid: boolean;
  error?: string;
}

export interface RunOptions {
  kernels: readonly KernelDef[];
  size: SizeId;
  mode: RunMode;
  /** Called before each kernel starts. Awaited, so the UI can repaint first. */
  beforeKernel?: (index: number, def: KernelDef) => Promise<void> | void;
  /** Called after each kernel finishes. */
  afterKernel?: (index: number, outcome: KernelOutcome) => void;
  /** Called once the worker is ready, with whatever it reports about itself (GPU: adapter). */
  onReady?: (info: Record<string, string>) => void;
  /** GPU runs: which GPU and API the worker should use. No kernel module is loaded. */
  gpu?: GpuInit;
  /** Storage runs: the OPFS directory for this run. No kernel module is loaded. */
  storage?: StorageInit;
  /** Injection points for tests. */
  makeWorker?: () => Worker;
  loadModule?: () => Promise<WebAssembly.Module>;
  spinMs?: number;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface Run<T = KernelOutcome> {
  done: Promise<T[]>;
  cancel(): void;
}

export function createWorker(): Worker {
  return new Worker(new URL('../../workers/runner.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/** Worker for GPU tests (WebGPU, or WebGL2 fallback). Same protocol. */
export function createGpuWorker(): Worker {
  return new Worker(new URL('../../workers/gpu.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/** Worker for storage tests (OPFS). Same protocol. */
export function createStorageWorker(): Worker {
  return new Worker(new URL('../../workers/storage.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/** Counts visibility losses, so a kernel can tell whether the tab was hidden while it ran. */
export function watchVisibility(): { hiddenNow(): boolean; losses(): number; stop(): void } {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return { hiddenNow: () => false, losses: () => 0, stop: () => {} };
  let losses = 0;
  const onChange = () => {
    if (doc.hidden) losses++;
  };
  doc.addEventListener('visibilitychange', onChange);
  return {
    hiddenNow: () => doc.hidden,
    losses: () => losses,
    stop: () => doc.removeEventListener('visibilitychange', onChange),
  };
}

export function startRun(opts: RunOptions): Run {
  const worker = (opts.makeWorker ?? createWorker)();
  let pending: { resolve(m: FromWorker): void; reject(e: Error): void } | undefined;
  let cancelled = false;
  /** Set once the worker is gone; later sends reject with it instead of hanging. */
  let dead: Error | undefined;

  const fail = (err: Error) => {
    dead ??= err;
    worker.terminate();
    pending?.reject(err);
    pending = undefined;
  };
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const p = pending;
    pending = undefined;
    p?.resolve(e.data);
  };
  worker.onmessageerror = () => fail(new Error('worker reply could not be read'));
  worker.onerror = (e) => {
    e.preventDefault();
    fail(new Error(e.message || 'worker crashed'));
  };

  const send = (msg: InitRequest | RunRequest) =>
    new Promise<FromWorker>((resolve, reject) => {
      if (cancelled) return reject(new Cancelled());
      if (dead) return reject(dead);
      pending = { resolve, reject };
      worker.postMessage(msg);
    });

  const visibility = watchVisibility();
  const plan = SAMPLING[opts.mode];

  const done = (async () => {
    try {
      // GPU and storage runs need no wasm: skip fetching and posting it (SPEC 7).
      const module = opts.gpu || opts.storage ? undefined : await (opts.loadModule ?? loadKernelModule)();
      if (cancelled) throw new Cancelled();
      const ready = await send({
        type: 'init',
        ...(module ? { module } : {}),
        spinMs: opts.spinMs ?? SPIN_MS,
        ...(opts.gpu ? { gpu: opts.gpu } : {}),
        ...(opts.storage ? { storage: opts.storage } : {}),
      });
      if (ready.type === 'error') throw new Error(`worker init failed: ${ready.message}`);
      if (ready.type === 'ready') opts.onReady?.(ready.info ?? {});

      const outcomes: KernelOutcome[] = [];
      for (let i = 0; i < opts.kernels.length; i++) {
        const def = opts.kernels[i]!;
        await opts.beforeKernel?.(i, def);
        if (cancelled) throw new Cancelled();

        const size = def.sizes[opts.size];
        const lossesBefore = visibility.losses();
        const hiddenAtStart = visibility.hiddenNow();
        const reply = await send({
          type: 'run',
          id: i,
          kernel: def.id,
          seed: def.seed,
          size,
          ...plan,
          ...(def.spinBeforeMs ? { spinMs: def.spinBeforeMs } : {}),
          ...(def.targetMs && opts.size !== 'smoke' ? { targetMs: def.targetMs } : {}),
        });
        const hidden =
          hiddenAtStart || visibility.hiddenNow() || visibility.losses() !== lossesBefore;
        const outcome = toOutcome(def, size, opts.size, opts.mode, reply, i, hidden);
        outcomes.push(outcome);
        opts.afterKernel?.(i, outcome);
      }
      return outcomes;
    } finally {
      visibility.stop();
      worker.terminate();
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      fail(new Cancelled());
    },
  };
}

function failed(def: KernelDef, error: string, hidden = false): KernelOutcome {
  return { def, checksumOk: false, hidden, noisy: false, valid: false, error };
}

function toOutcome(
  def: KernelDef,
  size: number,
  sizeId: SizeId,
  mode: RunMode,
  reply: FromWorker,
  id: number,
  hidden: boolean,
): KernelOutcome {
  if (reply.type === 'error') return failed(def, reply.message, hidden);
  if (reply.type !== 'result' || reply.id !== id) {
    return failed(def, `unexpected reply: ${reply.type}`, hidden);
  }
  return resultToOutcome(def, size, sizeId, mode, reply, hidden);
}

export function resultToOutcome(
  def: KernelDef,
  size: number,
  sizeId: SizeId,
  mode: RunMode,
  r: RunResult,
  hidden = false,
): KernelOutcome {
  const stats = summarize(fastest(r.times, SAMPLING[mode].minSamples));
  const seconds = stats.median / 1000;
  const checksumOk = r.checksumConsistent && r.checksum === def.expected[sizeId] >>> 0;
  const valid = checksumOk && !hidden;
  const reps = r.reps ?? 1;
  const error = !checksumOk
    ? r.detail
      ? `output check failed: ${r.detail}`
      : 'checksum mismatch: result invalid'
    : hidden
      ? 'tab was hidden during this test: result discarded'
      : undefined;
  return {
    def,
    stats,
    throughput: seconds > 0 ? (def.work(size) * reps) / seconds : undefined,
    samples: r.times.length,
    checksumOk,
    hidden,
    noisy: stats.spread > NOISY_SPREAD || r.short === true,
    valid,
    ...(error ? { error } : {}),
  };
}
