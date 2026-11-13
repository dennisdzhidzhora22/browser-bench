// CPU single-core kernel list, in run order.
import { mix } from '../mix.ts';
import type { KernelDef } from '../types.ts';

export const cpuKernels: readonly KernelDef[] = [mix];
