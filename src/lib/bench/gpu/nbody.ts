// STUB - to be implemented by a Builder. Keep the export names.
import type { KernelDef } from '../types.ts';
import { notImplemented } from './stub.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuKernel } from './types.ts';

export const gpuNbody: KernelDef = {
  id: 'gpu_nbody',
  name: 'N-body (compute)',
  stresses: 'compute, shared memory',
  unit: 'G interactions/s',
  seed: 1,
  sizes: { smoke: 1, standard: 1 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: () => 0,
  targetMs: GPU_TARGET_MS,
};

export function createGpuNbody(): GpuKernel {
  return notImplemented('gpu_nbody');
}