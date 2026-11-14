// STUB - to be implemented by a Builder. Keep the export names.
import type { KernelDef } from '../types.ts';
import { notImplemented } from './stub.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuKernel } from './types.ts';

export const gpuFragmentGl: KernelDef = {
  id: 'gpu_fragment_gl',
  name: 'Ray-march (fragment, WebGL2 fallback)',
  stresses: 'pixel shading',
  unit: 'Mpixels/s',
  seed: 1,
  sizes: { smoke: 1, standard: 1 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: () => 0,
  targetMs: GPU_TARGET_MS,
};

export function createGpuFragmentGl(): GpuKernel {
  return notImplemented('gpu_fragment_gl');
}