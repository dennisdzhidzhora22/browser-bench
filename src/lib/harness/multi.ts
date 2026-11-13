// All-cores CPU test (docs/SPEC.md, 3.2).
//
// One worker per core, each with its own wasm instance (D6). For each kernel:
//   1. Every worker prepares and warms up (untimed).
//   2. Baseline: worker 0 alone (after a short spin), same size and window.
//      This is the denominator of the scaling ratio.
//   3. All workers together, released by a shared barrier for every sample.
// Each worker runs `run` for a fixed-time window and counts its reps. A
// sample's score sums every worker's rate (see protocol.ts), so it measures
// the combined throughput of all cores rather than the slowest one.

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
import { CTRL, groupMsPerRep, SLOT, type FromWorker, type ToWorker } from './protocol.ts';
import { fastest, summarize, type SampleStats } from './stats.ts';

/** Timed window per sample, per mode. Short runs (`multi` sizes) fill it finely. */
export const WINDOW_MS: Record<RunMode, number> = { quick: 150, full: 300 };
/** Spin before each measurement, so the measuring threads sit on fast cores. */
export const MEASURE_SPIN_MS = 250;
/** The one-worker baseline converges fast once on a fast core; cap its extra sampling. */
export const BASELINE_MAX_MS = 1_000;
/** Highest worker count accepted, as a multiple of the reported logical cores. */
export const MAX_WORKERS_PER_CORE = 2;

export interface GroupResult {
  workers: number;
  /** Stats of the fastest `minSamples` samples, in combined ms per rep. */
  stats: SampleStats;
  samples: number;
  /** In `def.unit`, all workers in the group combined. */
  throughput: number | undefined;
}

export interface MultiOutcome {
  def: KernelDef;
  workers: number;
  /** All workers together. */
  all?: GroupResult;
  /** One worker alone, same size and window. */
  single?: GroupResult;
  /** all.throughput / single.throughput. Ideal = workers on identical cores. */
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
  /** Upper bound for `workers`. Default: hardwareConcurrency x MAX_WORKERS_PER_CORE. */
  maxWorkers?: number;
  beforeKernel?: (index: number, def: KernelDef) => Promise<void> | void;
  afterKernel?: (index: number, outcome: MultiOutcome) => void;
  makeWorker?: () => Worker;
  loadModule?: () => Promise<WebAssembly.Module>;
  /** Spin at worker init (default SPIN_MS). */
  spinMs?: number;
  /** Spin before each measurement (default MEASURE_SPIN_MS). */
  measureSpinMs?: number;
}

/** Size and expected checksum used by the all-cores test. */
export function multiSize(def: KernelDef, sizeId: SizeId): { size: number; expected: number } {
  if (sizeId === 'smoke') return { size: def.sizes.smoke, expected: def.expected.smoke };
  return def.multi ?? { size: def.sizes.standard, expected: def.expected.standard };
}

export function defaultMaxWorkers(): number {
  const cores = (globalThis as { navigator?: Navigator }).navigator?.hardwareConcurrency || 1;
  return Math.max(1, cores) * MAX_WORKERS_PER_CORE;
}

/** Whole number in [1, max], or undefined when `n` is not a usable count. */
export function clampWorkers(n: number, max: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  const t = Math.trunc(n);
  return t >= 1 ? Math.min(t, Math.max(1, Math.trunc(max))) : undefined;
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

/** Sends to every channel; rejects on the FIRST error reply or crash, not after all settle. */
function sendAll<T extends FromWorker['type']>(
  group: Channel[],
  type: T,
  msg: (c: Channel, index: number) => ToWorker,
): Promise<Extract<FromWorker, { type: T }>[]> {
  return Promise.all(group.map((c, i) => c.send(msg(c, i)).then((r) => expectType(r, type))));
}

export function startMultiRun(opts: MultiOptions): Run<MultiOutcome> {
  const makeWorker = opts.makeWorker ?? createWorker;
  const plan = SAMPLING[opts.mode];
  const windowMs = opts.size === 'smoke' ? 0 : WINDOW_MS[opts.mode];
  const measureSpinMs = opts.measureSpinMs ?? MEASURE_SPIN_MS;
  const workerCount = clampWorkers(opts.workers, opts.maxWorkers ?? defaultMaxWorkers());
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

  async function getPool(module: WebAssembly.Module, count: number): Promise<Channel[]> {
    if (pool) return pool;
    const p = Array.from({ length: count }, () => new Channel(makeWorker()));
    pool = p;
    try {
      await sendAll(p, 'ready', () => ({
        type: 'init',
        module,
        spinMs: opts.spinMs ?? SPIN_MS,
      }));
    } catch (err) {
      checkCancel();
      throw new InitFailed(`worker init failed: ${err instanceof Error ? err.message : err}`);
    }
    return p;
  }

  async function measure(
    group: Channel[],
    id: number,
    def: KernelDef,
    size: number,
    maxMs: number,
  ): Promise<{ result: GroupResult; consistent: boolean }> {
    const count = group.length;
    const control = new Int32Array(new SharedArrayBuffer(CTRL.LENGTH * 4));
    const times = new Float64Array(new SharedArrayBuffer(plan.maxSamples * count * SLOT * 8));
    const replies = await sendAll(group, 'measured', (_c, index) => ({
      type: 'measure',
      id,
      group: { control, times, index, count },
      windowMs,
      spinMs: measureSpinMs,
      ...plan,
      maxMs,
    }));
    const consistent = replies.every((r) => r.checksumConsistent);

    const n = Atomics.load(control, CTRL.SAMPLES);
    if (n < 1) throw new KernelFailed('no samples recorded');
    const perRep = new Float64Array(n);
    for (let s = 0; s < n; s++) perRep[s] = groupMsPerRep(times, s, count);
    const stats = summarize(fastest(perRep, plan.minSamples));
    const seconds = stats.median / 1000;
    return {
      consistent,
      result: {
        workers: count,
        stats,
        samples: n,
        throughput: seconds > 0 ? def.work(size) / seconds : undefined,
      },
    };
  }

  async function runKernel(
    module: WebAssembly.Module,
    count: number,
    i: number,
    def: KernelDef,
  ): Promise<MultiOutcome> {
    const { size, expected } = multiSize(def, opts.size);
    const p = await getPool(module, count);
    checkCancel();

    const prepared = await sendAll(p, 'prepared', () => ({
      type: 'prepare',
      id: i,
      kernel: def.id,
      seed: def.seed,
      size,
    }));
    const checksumMatches = prepared.every((r) => r.checksum === expected >>> 0);
    checkCancel();

    const lossesBefore = visibility.losses();
    const hiddenAtStart = visibility.hiddenNow();
    const single = await measure([p[0]!], i, def, size, Math.min(plan.maxMs, BASELINE_MAX_MS));
    checkCancel();
    const all = await measure(p, i, def, size, plan.maxMs);
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
      workers: count,
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
      if (workerCount === undefined) throw new Error('worker count must be at least 1');
      const module = await (opts.loadModule ?? loadKernelModule)();
      checkCancel();
      const outcomes: MultiOutcome[] = [];
      for (let i = 0; i < opts.kernels.length; i++) {
        const def = opts.kernels[i]!;
        await opts.beforeKernel?.(i, def);
        checkCancel();
        let outcome: MultiOutcome;
        try {
          outcome = await runKernel(module, workerCount, i, def);
        } catch (err) {
          checkCancel();
          if (err instanceof InitFailed) throw err;
          // A kernel error or a worker crash. Other workers may be stuck at the
          // barrier, so replace the whole pool before the next kernel.
          killPool(err instanceof Error ? err : new Error(String(err)));
          outcome = {
            def,
            workers: workerCount,
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
