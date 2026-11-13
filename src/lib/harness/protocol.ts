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
}

export type ToWorker = InitRequest | RunRequest;

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

export type FromWorker = Ready | RunResult | WorkerError;
