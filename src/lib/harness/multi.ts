// All-cores CPU test (docs/SPEC.md, 3.2).
//
// One worker per core, each with its own wasm instance (D6). For each kernel:
//   1. Every worker prepares and warms up (untimed).
//   2. Baseline: worker 0 alone, same size, same window. This is the
//      denominator of the scaling ratio, measured under identical conditions.
//   3. All workers together, released by a shared barrier for every sample.
// A sample's time is its wall time: first start to last finish across the
// group. Throughput = workers x reps x work(size) / wall seconds.

import type { KernelDef, SizeId } from '../bench/types.ts';
import { loadKernelModule } from './module.ts';
import {
  Cancelled,
  createWorker,
  NOISY_SPREAD,
  SAMPLING,
  SPIN_MS,
  watchVisibility,
  type Run,
  type RunMode,
} from './orchestrator.ts';
import { CTRL, type FromWorker, type ToWorker } from './protocol.ts';
import { fastest, summarize, type SampleStats } from './stats.ts';

/** Target length of one timed window. `run` is repeated to fill it. */
export const WINDOW_MS = 300;
/** Upper bound on repeats, so a broken timing reading cannot stall a run. */
export const MAX_REPS = 10_000;

export interface GroupResult {
  workers: number;
  /** Stats of the fastest `minSamples` window wall times (ms). */
  stats: SampleStats;
  samples: number;
  /** In `def.unit`, all workers combined. */
  throughput: number | undefined;
}

export interface MultiOutcome {
  def: KernelDef;
  workers: number;
  /** All workers together. */
  all?: GroupResult;
  /** One worker alone, same size and window. */
  single?: GroupResult;
  /** all.throughput / single.throughput. Ideal = workers. */
  scaling?: number;
  checksumOk: boolean;
  hidden: boolean;
  noisy: boolean;
  valid: boolean;
  error?: string;
}

export interface MultiOptions {
  kernels: readonly KernelDef[];
  size: SizeId;
  mode: RunMode;
  workers: number;
  beforeKernel?: (index: number, def: KernelDef) => Promise<void> | void;
  afterKernel?: (index: number, outcome: MultiOutcome) => void;
  makeWorker?: () => Worker;
  loadModule?: () => Promise<WebAssembly.Module>;
  spinMs?: number;
}

/** Size and expected checksum used by the all-cores test. */
export function multiSize(def: KernelDef, sizeId: SizeId): { size: number; expected: number } {
  if (sizeId === 'smoke') return { size: def.sizes.smoke, expected: def.expected.smoke };
  return def.multi ?? { size: def.sizes.standard, expected: def.expected.standard };
}

/** `run` calls per window, from one post-warm-up `run` time. */
export function repsFor(runMs: number, windowMs: number): number {
  if (windowMs <= 0) return 1;
  if (!(runMs > 0)) return MAX_REPS;
  return Math.min(MAX_REPS, Math.max(1, Math.ceil(windowMs / runMs)));
}

/** One worker with one request in flight at a time. */
class Channel {
  private pending: { resolve(m: FromWorker): void; reject(e: Error): void } | undefined;
  dead: Error | undefined;

  constructor(readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const p = this.pending;
      this.pending = undefined;
      p?.resolve(e.data);
    };
    worker.onmessageerror = () => this.fail(new Error('worker reply could not be read'));
    worker.onerror = (e) => {
      e.preventDefault();
      this.fail(new Error(e.message || 'worker crashed'));
    };
  }

  send(msg: ToWorker): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      this.pending = { resolve, reject };
      this.worker.postMessage(msg);
    });
  }

  fail(err: Error): void {
    this.dead ??= err;
    this.worker.terminate();
    this.pending?.reject(err);
    this.pending = undefined;
  }
}

class KernelFailed extends Error {}
/** Workers could not start at all: fatal for the whole run. */
class InitFailed extends Error {}

function expectType<T extends FromWorker['type']>(
  m: FromWorker,
  type: T,
): Extract<FromWorker, { type: T }> {
  if (m.type === 'error') throw new KernelFailed(m.message);
  if (m.type !== type) throw new KernelFailed(`unexpected reply: ${m.type}`);
  return m as Extract<FromWorker, { type: T }>;
}

export function startMultiRun(opts: MultiOptions): Run<MultiOutcome> {
  const makeWorker = opts.makeWorker ?? createWorker;
  const plan = SAMPLING[opts.mode];
  const visibility = watchVisibility();
  let pool: Channel[] | undefined;
  let cancelled = false;
  let cancelError: Cancelled | undefined;

  const killPool = (err: Error) => {
    for (const c of pool ?? []) c.fail(err);
    pool = undefined;
  };

  const checkCancel = () => {
    if (cancelled) throw (cancelError ??= new Cancelled());
  };

  async function getPool(module: WebAssembly.Module): Promise<Channel[]> {
    if (pool) return pool;
    const p = Array.from({ length: opts.workers }, () => new Channel(makeWorker()));
    pool = p;
    const replies = await Promise.all(
      p.map((c) => c.send({ type: 'init', module, spinMs: opts.spinMs ?? SPIN_MS })),
    );
    for (const r of replies) {
      if (r.type === 'error') throw new InitFailed(`worker init failed: ${r.message}`);
    }
    return p;
  }

  async function measure(
    group: Channel[],
    id: number,
    reps: number,
    def: KernelDef,
    size: number,
  ): Promise<{ result: GroupResult; consistent: boolean }> {
    const count = group.length;
    const control = new Int32Array(new SharedArrayBuffer(CTRL.LENGTH * 4));
    const times = new Float64Array(new SharedArrayBuffer(plan.maxSamples * count * 2 * 8));
    const replies = await Promise.all(
      group.map((c, index) =>
        c.send({ type: 'measure', id, group: { control, times, index, count }, reps, ...plan }),
      ),
    );
    let consistent = true;
    for (const r of replies) consistent &&= expectType(r, 'measured').checksumConsistent;

    const n = Atomics.load(control, CTRL.SAMPLES);
    if (n < 1) throw new KernelFailed('no samples recorded');
    const walls = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      let start = Infinity;
      let end = -Infinity;
      for (let w = 0; w < count; w++) {
        const k = (s * count + w) * 2;
        start = Math.min(start, times[k]!);
        end = Math.max(end, times[k + 1]!);
      }
      walls[s] = end - start;
    }
    const stats = summarize(fastest(walls, plan.minSamples));
    const seconds = stats.median / 1000;
    return {
      consistent,
      result: {
        workers: count,
        stats,
        samples: n,
        throughput: seconds > 0 ? (count * reps * def.work(size)) / seconds : undefined,
      },
    };
  }

  async function runKernel(
    module: WebAssembly.Module,
    i: number,
    def: KernelDef,
  ): Promise<MultiOutcome> {
    const { size, expected } = multiSize(def, opts.size);
    const p = await getPool(module);
    checkCancel();

    const prep = await Promise.all(
      p.map((c) => c.send({ type: 'prepare', id: i, kernel: def.id, seed: def.seed, size })),
    );
    const prepared = prep.map((r) => expectType(r, 'prepared'));
    const checksumMatches = prepared.every((r) => r.checksum === expected >>> 0);
    const reps = repsFor(prepared[0]!.runMs, opts.size === 'smoke' ? 0 : WINDOW_MS);
    checkCancel();

    const lossesBefore = visibility.losses();
    const hiddenAtStart = visibility.hiddenNow();
    const single = await measure([p[0]!], i, reps, def, size);
    checkCancel();
    const all = await measure(p, i, reps, def, size);
    const hidden = hiddenAtStart || visibility.hiddenNow() || visibility.losses() !== lossesBefore;

    const checksumOk = checksumMatches && single.consistent && all.consistent;
    const valid = checksumOk && !hidden;
    const scaling =
      all.result.throughput !== undefined && single.result.throughput
        ? all.result.throughput / single.result.throughput
        : undefined;
    const error = !checksumOk
      ? 'checksum mismatch: result invalid'
      : hidden
        ? 'tab was hidden during this test: result discarded'
        : undefined;
    return {
      def,
      workers: p.length,
      all: all.result,
      single: single.result,
      ...(scaling !== undefined ? { scaling } : {}),
      checksumOk,
      hidden,
      noisy: all.result.stats.spread > NOISY_SPREAD || single.result.stats.spread > NOISY_SPREAD,
      valid,
      ...(error ? { error } : {}),
    };
  }

  const done = (async () => {
    try {
      if (!(opts.workers >= 1)) throw new Error('worker count must be at least 1');
      const module = await (opts.loadModule ?? loadKernelModule)();
      checkCancel();
      const outcomes: MultiOutcome[] = [];
      for (let i = 0; i < opts.kernels.length; i++) {
        const def = opts.kernels[i]!;
        await opts.beforeKernel?.(i, def);
        checkCancel();
        let outcome: MultiOutcome;
        try {
          outcome = await runKernel(module, i, def);
        } catch (err) {
          checkCancel();
          if (err instanceof InitFailed) throw err;
          // A kernel error or a worker crash. Other workers may be stuck at the
          // barrier, so replace the whole pool before the next kernel.
          killPool(err instanceof Error ? err : new Error(String(err)));
          outcome = {
            def,
            workers: opts.workers,
            checksumOk: false,
            hidden: false,
            noisy: false,
            valid: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        outcomes.push(outcome);
        opts.afterKernel?.(i, outcome);
      }
      return outcomes;
    } finally {
      visibility.stop();
      killPool(new Error('run finished'));
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      cancelError ??= new Cancelled();
      killPool(cancelError);
    },
  };
}
