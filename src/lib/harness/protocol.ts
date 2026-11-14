// Messages between the page and a benchmark worker.
//
//   page                        worker
//   init {module, spinMs} ───▶  instantiate wasm, check ABI, busy-spin
//                         ◀───  ready | error
//   run {id, ...}         ───▶  prepare (untimed), warm-up, timed samples
//                         ◀───  result {id} | error {id}
//
// The page compiles the wasm module once and sends it to every worker.
// Cancel = Worker.terminate(). Nothing is posted while a timed region is
// open (docs/SPEC.md, section 5).

export interface InitRequest {
  type: 'init';
  module: WebAssembly.Module;
  /**
   * Busy-spin this long before replying `ready`, so the OS moves the thread
   * to a fast core and raises its clock before the first measurement.
   */
  spinMs: number;
}

export interface RunRequest {
  type: 'run';
  /** Echoed back so replies can be matched to requests. */
  id: number;
  kernel: string;
  seed: number;
  size: number;
  /** Always take at least this many timed samples. */
  minSamples: number;
  /** Never take more than this many. */
  maxSamples: number;
  /**
   * Stop early once the `minSamples` fastest samples agree within this
   * fraction: (max - min) / median of those samples.
   */
  targetSpread: number;
  /** Stop adding samples past `minSamples` once this much time has passed. */
  maxMs: number;
  /** Busy-spin after prepare, before warm-up. Optional; default 0. */
  spinMs?: number;
}

// ── All-cores test (docs/SPEC.md, 3.2) ─────────────────────────────────────
//
//   page                         every worker
//   prepare {id, ...}    ───▶    prepare + warm-up (untimed)
//                        ◀───    prepared {runMs, checksum}
//   measure {id, group}  ───▶    barrier loop below
//                        ◀───    measured {checksumConsistent}
//
// Barrier loop, shared through `group.control` (Int32Array) and
// `group.times` (Float64Array of [sample][worker][t0, t1, reps], t in absolute ms):
//   - Each worker spins `spinMs`, then adds 1 to READY; the last one bumps GEN
//     to 1 and wakes all.
//   - Sample s starts when GEN > s. Each worker reads t0 and calls run() until
//     `windowMs` has passed (at least once); it then adds 1 to PASSED once and
//     KEEPS calling run() until every worker has passed. So no worker runs
//     alone at the end of a window, with less contention than the others.
//     Then it reads t1, stores t0, t1 and its rep count, and adds 1 to ARRIVED.
//   - The last to arrive resets ARRIVED and PASSED, records the sample count, decides
//     whether to stop (same adaptive rule as single-core, applied to
//     `groupMsPerRep`), then bumps GEN and wakes all.
//   - A worker that fails sets STOP, bumps GEN by ERROR_GEN and wakes all, so
//     nobody waits forever. Waits also give up after BARRIER_TIMEOUT_MS.
// Only run() and timer reads happen between t0 and t1.
//
// Score per sample: rate = sum over workers of reps / (t1 - t0) (reps per ms,
// summed), so every core's work counts and a slow core does not hold the
// others back. groupMsPerRep = 1 / rate; throughput = work(size) / seconds.

/** Indexes into the Int32 control array. */
export const CTRL = {
  GEN: 0,
  ARRIVED: 1,
  STOP: 2,
  READY: 3,
  SAMPLES: 4,
  PASSED: 5,
  LENGTH: 8,
} as const;
/** Entries per worker per sample in `times`: t0, t1, reps. */
export const SLOT = 3;
/** Added to GEN by a failing worker: larger than any sample count. */
export const ERROR_GEN = 1 << 20;
/** A barrier wait with no progress for this long fails the kernel. */
export const BARRIER_TIMEOUT_MS = 30_000;

/** Combined ms per rep for sample `s`; see the score note above. */
export function groupMsPerRep(times: Float64Array, s: number, count: number): number {
  let rate = 0;
  for (let w = 0; w < count; w++) {
    const k = (s * count + w) * SLOT;
    const dt = times[k + 1]! - times[k]!;
    if (dt > 0) rate += times[k + 2]! / dt;
  }
  return rate > 0 ? 1 / rate : 0;
}

export interface PrepareRequest {
  type: 'prepare';
  id: number;
  kernel: string;
  seed: number;
  size: number;
}

export interface Prepared {
  type: 'prepared';
  id: number;
  checksum: number;
  /** Time of the first (warm-up) `run` call, for information only. */
  runMs: number;
}

export interface MeasureGroup {
  /** Int32Array over a SharedArrayBuffer, CTRL.LENGTH entries. */
  control: Int32Array;
  /** Float64Array over a SharedArrayBuffer, maxSamples * count * SLOT entries. */
  times: Float64Array;
  /** This worker's index in the group. */
  index: number;
  /** Workers in the group. */
  count: number;
}

export interface MeasureRequest {
  type: 'measure';
  id: number;
  group: MeasureGroup;
  /** Each worker runs `run` until this much time has passed in a sample (min 1 call). */
  windowMs: number;
  /** Busy-spin before joining the start barrier (moves the thread to a fast core). */
  spinMs: number;
  minSamples: number;
  maxSamples: number;
  targetSpread: number;
  maxMs: number;
}

export interface Measured {
  type: 'measured';
  id: number;
  /** True when every timed call returned the prepared checksum. */
  checksumConsistent: boolean;
}

export type ToWorker = InitRequest | RunRequest | PrepareRequest | MeasureRequest;

export interface Ready {
  type: 'ready';
  abi: number;
}

export interface RunResult {
  type: 'result';
  id: number;
  kernel: string;
  /** Checksum from the warm-up call. */
  checksum: number;
  /** True when every timed sample returned the warm-up checksum. */
  checksumConsistent: boolean;
  /** Milliseconds spent in `prepare` (untimed work, reported for info). */
  prepareMs: number;
  /** Milliseconds per sample, in the order taken. Transferred, not copied. */
  times: Float64Array;
}

export interface WorkerError {
  type: 'error';
  /** Absent when the error is not tied to a run (e.g. init failed). */
  id?: number;
  kernel?: string;
  message: string;
}

export type FromWorker = Ready | RunResult | Prepared | Measured | WorkerError;
