// The components a user can select. Kernels are filled in per milestone.
import { cpuKernels } from './cpu/index.ts';
import type { ComponentId, KernelDef } from './types.ts';

export interface ComponentDef {
  id: ComponentId;
  name: string;
  /** Empty until the component's milestone lands; the UI shows it disabled. */
  kernels: readonly KernelDef[];
}

export const components: readonly ComponentDef[] = [
  { id: 'cpu-single', name: 'CPU — single core', kernels: cpuKernels },
  { id: 'cpu-multi', name: 'CPU — all cores', kernels: [] },
  { id: 'memory', name: 'Memory', kernels: [] },
  { id: 'gpu', name: 'GPU', kernels: [] },
  { id: 'storage', name: 'Storage', kernels: [] },
];
