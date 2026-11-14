// GPU tests registry (docs/SPEC.md, 3.4).
import type { KernelDef } from '../types.ts';
import { createGpuDraws, gpuDraws } from './draws.ts';
import { createGpuFragment, gpuFragment } from './fragment.ts';
import { createGpuFragmentGl, gpuFragmentGl } from './fragment-gl.ts';
import { createGpuMatmul, gpuMatmul } from './matmul.ts';
import { createGpuNbody, gpuNbody } from './nbody.ts';
import type { GpuKernelFactory } from './types.ts';

/** Run when WebGPU is available, in this order. */
export const webgpuKernels: readonly KernelDef[] = [gpuNbody, gpuMatmul, gpuDraws, gpuFragment];

/** Run only when WebGPU is not available. Results are labelled "fallback". */
export const fallbackKernels: readonly KernelDef[] = [gpuFragmentGl];

/** All GPU defs (for listing; the page picks one of the two lists at run time). */
export const gpuKernels: readonly KernelDef[] = [...webgpuKernels, ...fallbackKernels];

/** Factories by KernelDef.id, used by the GPU worker. */
export const gpuFactories: Readonly<Record<string, GpuKernelFactory>> = {
  gpu_nbody: createGpuNbody,
  gpu_matmul: createGpuMatmul,
  gpu_draws: createGpuDraws,
  gpu_fragment: createGpuFragment,
  gpu_fragment_gl: createGpuFragmentGl,
};

export function isFallback(def: KernelDef): boolean {
  return fallbackKernels.includes(def);
}

export type GpuApi = 'webgpu' | 'webgl2' | 'none';

/**
 * Which GPU API this browser offers. Runs on the page before a run starts
 * (never during a measurement).
 */
export async function detectGpuApi(): Promise<GpuApi> {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) return 'webgpu';
  } catch {
    // fall through to WebGL2
  }
  try {
    if (new OffscreenCanvas(1, 1).getContext('webgl2')) return 'webgl2';
  } catch {
    // none
  }
  return 'none';
}
