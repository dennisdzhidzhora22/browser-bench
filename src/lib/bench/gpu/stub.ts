// Placeholder used until a GPU test is implemented. Throws a clear error.
import type { GpuKernel } from './types.ts';

export function notImplemented(name: string): GpuKernel {
  const fail = () => Promise.reject(new Error(`${name}: not implemented yet`));
  return { prepare: fail, runBatch: fail, validate: fail, dispose: () => {} };
}
