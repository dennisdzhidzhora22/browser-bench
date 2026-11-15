// GPU tests registry (docs/SPEC.md, 3.4).
import type { GpuPreference } from '../../harness/protocol.ts';
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

/** By def or saved key, not identity: defs held in Svelte $state are proxies. */
export function isFallback(def: KernelDef | string): boolean {
  const id = typeof def === 'string' ? def : def.id;
  return fallbackKernels.some((k) => k.id === id);
}

export type GpuApi = 'webgpu' | 'webgl2' | 'none';

/** Which GPU(s) the user asked to test. Browsers expose only these two hints, not a GPU list. */
export type GpuChoice = 'high-performance' | 'low-power' | 'both';

export interface GpuTarget {
  preference: GpuPreference;
  /** What the browser reports for the GPU this preference gets. */
  label: string;
}

export interface GpuPlan {
  api: GpuApi;
  /** One entry per distinct GPU to test, in run order. Empty when api is 'none'. */
  targets: GpuTarget[];
  /** True when 'both' was asked for but the two preferences gave the same GPU. */
  sameGpu: boolean;
}

function webgpuLabel(a: GPUAdapter): string {
  const i = a.info;
  const label =
    [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') || 'GPU';
  return isSoftware(a) ? `${label} (software)` : label;
}

/** True for CPU-emulated adapters (SwiftShader, WARP). Field moved between Chrome versions. */
export function isSoftware(a: GPUAdapter): boolean {
  const x = a as GPUAdapter & { isFallbackAdapter?: boolean; info: { isFallbackAdapter?: boolean } };
  return Boolean(x.info.isFallbackAdapter || x.isFallbackAdapter);
}

function webglLabel(pref: GpuPreference): string | undefined {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { powerPreference: pref });
  if (!gl) return undefined;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const label = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return label;
}

/**
 * Which API to use and which distinct GPUs `choice` maps to. Runs on the page
 * before a run starts (never during a measurement). With 'both', the two
 * preferences are compared by what the browser reports and deduplicated.
 */
export async function planGpus(choice: GpuChoice): Promise<GpuPlan> {
  const prefs: GpuPreference[] =
    choice === 'both' ? ['high-performance', 'low-power'] : [choice];
  const dedupe = (all: GpuTarget[]): GpuPlan['targets'] =>
    all.filter((t, i) => all.findIndex((u) => u.label === t.label) === i);
  // Same GPU only when every asked-for preference found an adapter and they matched.
  const same = (found: GpuTarget[], targets: GpuTarget[]) =>
    prefs.length > 1 && found.length === prefs.length && targets.length === 1;

  try {
    if (navigator.gpu) {
      const found: GpuTarget[] = [];
      for (const preference of prefs) {
        const a = await navigator.gpu.requestAdapter({ powerPreference: preference });
        if (a) found.push({ preference, label: webgpuLabel(a) });
      }
      if (found.length > 0) {
        const targets = dedupe(found);
        return { api: 'webgpu', targets, sameGpu: same(found, targets) };
      }
    }
  } catch {
    // fall through to WebGL2
  }
  try {
    const found: GpuTarget[] = [];
    for (const preference of prefs) {
      const label = webglLabel(preference);
      if (label !== undefined) found.push({ preference, label });
    }
    if (found.length > 0) {
      const targets = dedupe(found);
      return { api: 'webgl2', targets, sameGpu: same(found, targets) };
    }
  } catch {
    // none
  }
  return { api: 'none', targets: [], sameGpu: false };
}
