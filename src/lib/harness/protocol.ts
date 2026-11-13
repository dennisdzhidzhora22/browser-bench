// Messages between the page and a benchmark worker.
//
//   page                      worker
//   init            ───────▶  compile + instantiate wasm, check ABI
//                   ◀───────  ready | error
//   run {id, ...}   ───────▶  prepare (untimed), warm-up, timed samples
//                   ◀───────  result {id} | error {id}
//
// Cancel = Worker.terminate(). Nothing is posted while a timed region is
// open (docs/SPEC.md, section 5).

export interface InitRequest {
  type: 'init';
}

export interface RunRequest {
  type: 'run';
  /** Echoed back so replies can be matched to requests. */
  id: number;
  kernel: string;
  seed: number;
  size: number;
  samples: number;
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
  /** Milliseconds per sample, measured inside the worker. Transferred, not copied. */
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
