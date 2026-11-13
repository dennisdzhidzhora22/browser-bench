// Messages between the page and benchmark workers.
// One request in, one reply out per kernel. Nothing is posted while a timed
// region is open (docs/SPEC.md, section 5).

export type KernelId = 'mix';

export interface RunRequest {
  type: 'run';
  kernel: KernelId;
  seed: number;
  size: number;
  samples: number;
}

export interface RunResult {
  type: 'result';
  kernel: KernelId;
  checksum: number;
  /** True when the warm-up and every sample returned the same checksum. */
  checksumConsistent: boolean;
  /** Milliseconds per sample, measured inside the worker. Transferred, not copied. */
  times: Float64Array;
}

export interface RunError {
  type: 'error';
  message: string;
}

export type ToWorker = RunRequest;
export type FromWorker = RunResult | RunError;
