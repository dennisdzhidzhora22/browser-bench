// Points (docs/SPEC.md, section 6). Raw numbers stay the headline; points are
// a derived summary.

import { cpuKernels } from '../bench/cpu/index.ts';
import { webgpuKernels } from '../bench/gpu/index.ts';
import { memCopyMulti, memoryKernels } from '../bench/memory/index.ts';
import { storageKernels } from '../bench/storage/index.ts';
import { defKey, type ComponentId, type KernelDef, type SizeId } from '../bench/types.ts';
import type { ComponentRecord, KernelRecord, RunRecord } from '../store/schema.ts';
import { CONSTANTS, LOWER_IS_BETTER, SCORE_VERSION } from './constants.ts';
import referenceData from './references.json';

export const SCORED: readonly ComponentId[] = ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'];

/** The kernels each component is scored over. A def without a constant makes the component partial. */
const SCORED_DEFS: Record<ComponentId, readonly KernelDef[]> = {
  'cpu-single': cpuKernels,
  'cpu-multi': cpuKernels,
  memory: [...memoryKernels, memCopyMulti],
  gpu: webgpuKernels,
  storage: storageKernels,
};

export interface Reference {
  name: string;
  scoreVersion: number;
  /** By `<component>/<defKey>`, in the record unit. */
  results: Record<string, number>;
  /** By component id, plus `total`. */
  points: Record<string, number>;
}

export const references = referenceData as unknown as Reference[];

/** Reference entries comparable with results of `scoreVersion` (none for other versions). */
export function refsFor(scoreVersion: number): Reference[] {
  return scoreVersion === SCORE_VERSION ? references.filter((r) => r.scoreVersion === scoreVersion) : [];
}

export function geomean(xs: readonly number[]): number {
  return Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
}

/** An all-cores kernel run on a worker count other than the core count: not comparable. */
export function offCores(k: KernelRecord, cores: number | undefined): boolean {
  return cores !== undefined && k.workers !== undefined && k.workers !== cores;
}

/**
 * Why `c` earns no points and is not compared with references, or undefined
 * when it may. The WebGL2 fallback, a software GPU, a scaled-down storage file
 * and all-cores CPU on a worker count other than `cores` are not comparable
 * with the standard tests. (Memory only drops its all-cores copy for the
 * worker count; see scoreComponent.)
 */
export function excluded(c: ComponentRecord, size: SizeId, cores?: number): string | undefined {
  if (size === 'smoke') return 'smoke: no points';
  if (c.gpu?.api === 'webgl2') return 'fallback: no points, not comparable with WebGPU';
  if (c.gpu?.info['software']) return 'software adapter: no points';
  if (c.scaled) return 'smaller test file: no points, not comparable';
  if (c.id === 'cpu-multi') {
    const k = c.kernels.find((x) => offCores(x, cores));
    if (k) return `${k.workers} workers, not ${cores} (the core count): no points`;
  }
  return undefined;
}

/**
 * 1000 x geomean of the kernel ratios (result / constant; constant / result
 * for lower-is-better units). Variants of one kernel (the 17 latency sizes)
 * first combine into one sub-score by their own geomean, so memory points are
 * 1000 x geomean{fill, copy, copy_mt, latency}. Partial when a scored kernel
 * is invalid, missing or has no constant.
 */
export function scoreComponent(
  c: ComponentRecord,
  size: SizeId,
  cores?: number,
): { points: number | null; partial: boolean; note?: string } {
  const groups = new Map<string, number[]>();
  let partial = false;
  let note: string | undefined;
  for (const def of SCORED_DEFS[c.id]) {
    const key = defKey(def);
    const k = c.kernels.find((x) => x.key === key);
    if (k && offCores(k, cores)) {
      partial = true;
      note = `${k.workers} workers, not ${cores}: all-cores copy not scored`;
      continue;
    }
    const constant = CONSTANTS[`${c.id}/${key}`];
    const v = k?.valid ? k.value : null;
    if (!k || constant === undefined || v === null || !(v > 0)) {
      partial = true;
      continue;
    }
    const ratio = LOWER_IS_BETTER.has(k.unit) ? constant / v : v / constant;
    groups.set(def.id, [...(groups.get(def.id) ?? []), ratio]);
  }
  const subs = [...groups.values()].map(geomean);
  const why = excluded(c, size, cores) ?? (subs.length === 0 ? 'no valid results' : undefined);
  if (why) return { points: null, partial, note: why };
  return { points: Math.round(1000 * geomean(subs)), partial, ...(note ? { note } : {}) };
}

/** The component record that counts toward the total for `id`. For GPU, only the Fast (high-performance) GPU. */
export function counted(components: readonly ComponentRecord[], id: ComponentId): ComponentRecord | undefined {
  const all = components.filter((c) => c.id === id);
  return id === 'gpu' ? all.find((c) => !c.gpu || c.gpu.preference === 'high-performance') : all[0];
}

/** Geomean of the counted component points. Partial unless all five ran complete. */
export function scoreTotal(components: readonly ComponentRecord[]): { total: number | null; partial: boolean } {
  const pts: number[] = [];
  let partial = false;
  for (const id of SCORED) {
    const c = counted(components, id);
    if (c?.points == null) partial = true;
    else {
      pts.push(c.points);
      partial ||= c.partial;
    }
  }
  return { total: pts.length ? Math.round(geomean(pts)) : null, partial };
}

/**
 * `r` with points, partial flags, notes and total recomputed from its kernels
 * (saved or imported values are ignored). Records of another scoreVersion
 * come back unchanged: shown as saved, never compared.
 */
export function rescore(r: RunRecord): RunRecord {
  if (r.scoreVersion !== SCORE_VERSION) return r;
  const components = r.components.map((c): ComponentRecord => {
    const { points: _points, partial: _partial, note: _note, ...rest } = c;
    const s = scoreComponent(c, r.size, r.system.cores);
    return { ...rest, points: s.points, partial: s.partial, ...(s.note ? { note: s.note } : {}) };
  });
  return { ...r, components, ...scoreTotal(components) };
}
