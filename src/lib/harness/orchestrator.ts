// Runs a list of kernels, one at a time, on one worker.
//
// Page work is kept out of measurements: the caller's `beforeKernel` hook runs
// (and may repaint) BEFORE each run request is posted, and nothing else
// happens on the page until the reply arrives.

import type { KernelDef, SizeId } from '../bench/types.ts';
import type { FromWorker, RunRequest, RunResult } from './protocol.ts';
import { summarize, type SampleStats } from './stats.ts';

export type RunMode = 'quick' | 'full';

/** Timed samples per kernel (docs/SPEC.md, section 5). */
export const SAMPLES: Record<RunMode, number> = { quick: 3, full: 7 };

export interface KernelOutcome {
  def: KernelDef;
  /** Undefined when the kernel failed; see `error`. */
  stats?: SampleStats;
  /** Headline number in `def.unit`, from the median sample. */
  throughput?: number;
  checksumOk: boolean;
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
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface Run {
  done: Promise<KernelOutcome[]>;
  cancel(): void;
}

export function createWorker(): Worker {
  return new Worker(new URL('../../workers/runner.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export function startRun(opts: RunOptions, makeWorker: () => Worker = createWorker): Run {
  const worker = makeWorker();
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

  const send = (msg: unknown) =>
    new Promise<FromWorker>((resolve, reject) => {
      if (cancelled) return reject(new Cancelled());
      if (dead) return reject(dead);
      pending = { resolve, reject };
      worker.postMessage(msg);
    });

  const done = (async () => {
    try {
      const ready = await send({ type: 'init' });
      if (ready.type === 'error') throw new Error(`worker init failed: ${ready.message}`);

      const outcomes: KernelOutcome[] = [];
      for (let i = 0; i < opts.kernels.length; i++) {
        const def = opts.kernels[i]!;
        await opts.beforeKernel?.(i, def);
        if (cancelled) throw new Cancelled();

        const size = def.sizes[opts.size];
        const req: RunRequest = {
          type: 'run',
          id: i,
          kernel: def.id,
          seed: def.seed,
          size,
          samples: SAMPLES[opts.mode],
        };
        const reply = await send(req);
        const outcome = toOutcome(def, size, opts.size, reply, i);
        outcomes.push(outcome);
        opts.afterKernel?.(i, outcome);
      }
      return outcomes;
    } finally {
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

function toOutcome(
  def: KernelDef,
  size: number,
  sizeId: SizeId,
  reply: FromWorker,
  id: number,
): KernelOutcome {
  if (reply.type === 'error') return { def, checksumOk: false, error: reply.message };
  if (reply.type !== 'result' || reply.id !== id) {
    return { def, checksumOk: false, error: `unexpected reply: ${reply.type}` };
  }
  return resultToOutcome(def, size, sizeId, reply);
}

export function resultToOutcome(
  def: KernelDef,
  size: number,
  sizeId: SizeId,
  r: RunResult,
): KernelOutcome {
  const stats = summarize(r.times);
  const seconds = stats.median / 1000;
  const checksumOk = r.checksumConsistent && r.checksum === def.expected[sizeId] >>> 0;
  return {
    def,
    stats,
    throughput: seconds > 0 ? def.work(size) / seconds : undefined,
    checksumOk,
    ...(checksumOk ? {} : { error: 'checksum mismatch: result invalid' }),
  };
}
