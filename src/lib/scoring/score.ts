// Points (docs/SPEC.md, section 6). Raw numbers stay the headline; points are
// a derived summary.

import type { ComponentId, SizeId } from '../bench/types.ts';
import type { ComponentRecord } from '../store/schema.ts';
import { CONSTANTS, LOWER_IS_BETTER, SCORE_VERSION } from './constants.ts';
import referenceData from './references.json';

export const SCORED: readonly ComponentId[] = ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'];

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

/**
 * Why `c` earns no points and is not compared with references, or undefined
 * when it may. WebGL2 fallback and a scaled-down storage file are not
 * comparable with the standard tests.
 */
export function excluded(c: ComponentRecord, size: SizeId): string | undefined {
  if (size === 'smoke') return 'smoke: no points';
  if (c.gpu?.api === 'webgl2') return 'fallback: no points, not comparable with WebGPU';
  if (c.scaled) return 'smaller test file: no points, not comparable';
  return undefined;
}

/**
 * 1000 x geomean(result / constant) over the component's valid kernels
 * (constant / result for lower-is-better units). Partial when a kernel that
 * has a constant is invalid or missing.
 */
export function scoreComponent(
  c: ComponentRecord,
  size: SizeId,
): { points: number | null; partial: boolean; note?: string } {
  const prefix = `${c.id}/`;
  const ratios: number[] = [];
  let partial = false;
  for (const key of Object.keys(CONSTANTS)) {
    if (!key.startsWith(prefix)) continue;
    const k = c.kernels.find((x) => prefix + x.key === key);
    const v = k?.valid ? k.value : null;
    if (v === null || !(v > 0)) {
      partial = true;
      continue;
    }
    const ref = CONSTANTS[key]!;
    ratios.push(LOWER_IS_BETTER.has(k!.unit) ? ref / v : v / ref);
  }
  const note = excluded(c, size) ?? (ratios.length === 0 ? 'no valid results' : undefined);
  if (note) return { points: null, partial, note };
  return { points: Math.round(1000 * geomean(ratios)), partial };
}

/**
 * The component record that counts toward the total for `id`. For GPU
 * "Both", the high-performance GPU counts; the other gets its own points only.
 */
export function counted(components: readonly ComponentRecord[], id: ComponentId): ComponentRecord | undefined {
  const all = components.filter((c) => c.id === id);
  return all.find((c) => c.gpu?.preference === 'high-performance') ?? all[0];
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
