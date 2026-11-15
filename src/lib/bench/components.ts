// The components a user can select. Kernels are filled in per milestone.
import { cpuKernels } from './cpu/index.ts';
import { gpuKernels } from './gpu/index.ts';
import { memCopyMulti, memoryKernels } from './memory/index.ts';
import { storageKernels } from './storage/index.ts';
import { defKey, type ComponentId, type KernelDef } from './types.ts';

export interface ComponentDef {
  id: ComponentId;
  name: string;
  /** Empty until the component's milestone lands; the UI shows it disabled. */
  kernels: readonly KernelDef[];
}

export const components: readonly ComponentDef[] = [
  { id: 'cpu-single', name: 'CPU — single core', kernels: cpuKernels },
  { id: 'cpu-multi', name: 'CPU — all cores', kernels: cpuKernels },
  { id: 'memory', name: 'Memory', kernels: memoryKernels },
  // The page runs either the WebGPU tests or the WebGL2 fallback, never both.
  { id: 'gpu', name: 'GPU', kernels: gpuKernels },
  // The page scales the file size to the quota before a run (storageDefsFor).
  { id: 'storage', name: 'Storage', kernels: storageKernels },
];

const allDefs: readonly KernelDef[] = [...cpuKernels, ...memoryKernels, memCopyMulti, ...gpuKernels, ...storageKernels];

/** Display name and "stresses" text for a saved key; the key itself when this build no longer has it. */
export function describe(key: string): { name: string; stresses: string } {
  const d = allDefs.find((x) => defKey(x) === key);
  return d ? { name: d.name, stresses: d.stresses } : { name: key, stresses: '' };
}
