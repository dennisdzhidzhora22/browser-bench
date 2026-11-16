// Converts outcomes into KernelRecords (the shape every results table shows,
// live or saved) and a finished run into a scored RunRecord.

import type { GpuPlan, GpuTarget } from '../bench/gpu/index.ts';
import { latencyNs } from '../bench/memory/index.ts';
import type { StoragePlan } from '../bench/storage/index.ts';
import { defKey, type ComponentId, type SizeId } from '../bench/types.ts';
import type { MultiOutcome } from '../harness/multi.ts';
import type { KernelOutcome, RunMode } from '../harness/orchestrator.ts';
import type { SampleStats } from '../harness/stats.ts';
import { SCORE_VERSION } from '../scoring/constants.ts';
import { rescore } from '../scoring/score.ts';
import type { SystemInfo } from '../sysinfo/index.ts';
import { dropOf } from '../harness/drop.ts';
import {
  SCHEMA,
  type ComponentRecord,
  type EndurancePart,
  type EnduranceRecord,
  type KernelRecord,
  type RunRecord,
} from './schema.ts';

export interface GpuRun {
  target: GpuTarget;
  info: Record<string, string>;
  outcomes: KernelOutcome[];
}

/** A finished run's outcomes, as the page collected them. */
export interface RunView {
  outcomes: KernelOutcome[];
  multiOutcomes: MultiOutcome[];
  memOutcomes: KernelOutcome[];
  memMulti: MultiOutcome[];
  gpuPlan: GpuPlan | undefined;
  gpuRuns: GpuRun[];
  storagePlan: StoragePlan | undefined;
  storageOutcomes: KernelOutcome[];
  storageError: string | undefined;
}

const LATENCY = 'mem_latency';
/** Six significant digits: plenty for timings, keeps records small. */
const r6 = (x: number) => Number(x.toPrecision(6));
const r6n = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : r6(x));

function stats(s: SampleStats | undefined) {
  return s
    ? { ms: { median: r6(s.median), min: r6(s.min), max: r6(s.max) }, spread: r6(s.spread) }
    : {};
}

function flags(o: { valid: boolean; noisy: boolean; hidden: boolean; checksumOk: boolean; error?: string }) {
  return {
    valid: o.valid,
    noisy: o.noisy,
    hidden: o.hidden,
    // Stored only when it fails: hidden + failed check must not read as ok.
    ...(o.checksumOk ? {} : { checksumOk: false }),
    ...(o.error ? { error: o.error } : {}),
  };
}

export function kernelRecord(o: KernelOutcome): KernelRecord {
  const lat = o.def.id === LATENCY;
  return {
    key: defKey(o.def),
    unit: lat ? 'ns' : o.def.unit,
    value: o.valid ? r6n(lat ? latencyNs(o.throughput) : o.throughput) : null,
    ...stats(o.stats),
    ...(o.samples !== undefined ? { samples: o.samples } : {}),
    ...flags(o),
  };
}

export function multiRecord(o: MultiOutcome): KernelRecord {
  return {
    key: defKey(o.def),
    unit: o.def.unit,
    value: o.valid ? r6n(o.all?.throughput) : null,
    ...stats(o.all?.stats),
    ...(o.all ? { samples: o.all.samples } : {}),
    ...flags(o),
    workers: o.workers,
    single: o.valid ? r6n(o.single?.throughput) : null,
    ...(o.single ? { singleSpread: r6(o.single.stats.spread), singleSamples: o.single.samples } : {}),
    scaling: o.valid ? r6n(o.scaling) : null,
    weakBaseline: o.weakBaseline,
  };
}

/** Builds and scores the record of a finished run. */
export function buildRecord(
  v: RunView,
  ran: readonly ComponentId[],
  mode: RunMode,
  size: SizeId,
  system: SystemInfo,
): RunRecord {
  const comps: ComponentRecord[] = [];
  // Scored by rescore() below.
  const unscored = { points: null, partial: false };
  for (const id of ran) {
    if (id === 'cpu-single') comps.push({ id, ...unscored, kernels: v.outcomes.map(kernelRecord) });
    else if (id === 'cpu-multi') comps.push({ id, ...unscored, kernels: v.multiOutcomes.map(multiRecord) });
    else if (id === 'memory') {
      comps.push({ id, ...unscored, kernels: [...v.memOutcomes.map(kernelRecord), ...v.memMulti.map(multiRecord)] });
    } else if (id === 'gpu') {
      const api = v.gpuPlan?.api;
      if (api === 'webgpu' || api === 'webgl2') {
        v.gpuRuns.forEach((g, i) =>
          comps.push({
            id,
            ...unscored,
            gpu: { preference: g.target.preference, label: g.target.label, api, info: { ...g.info } },
            kernels: g.outcomes.map(kernelRecord),
            ...(i === 0 && v.gpuPlan?.sameGpu ? { sameGpu: true } : {}),
          }),
        );
      } else comps.push({ id, ...unscored, kernels: [], error: 'This browser offers neither WebGPU nor WebGL2.' });
    } else if (id === 'storage') {
      const p = v.storagePlan;
      if (!p?.ok) comps.push({ id, ...unscored, kernels: [], error: p?.message ?? 'not run' });
      else {
        comps.push({
          id,
          ...unscored,
          kernels: v.storageOutcomes.map(kernelRecord),
          fileBytes: p.fileBytes,
          scaled: p.scaled,
          ...(v.storageError ? { error: v.storageError } : {}),
        });
      }
    }
  }
  const gpus = v.gpuRuns.map((g) => g.target.label);
  return rescore({
    schema: SCHEMA,
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    mode,
    size,
    scoreVersion: SCORE_VERSION,
    system: { ...system, ...(gpus.length ? { gpu: gpus } : {}) },
    components: comps,
    total: null,
    partial: false,
  });
}

/** Four significant digits: window series stay small for 60-minute runs (720 windows per part). */
const r4n = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(4)));

/** Builds the record of a finished Endurance run. No components, so no points. */
export function buildEnduranceRecord(
  endurance: Omit<EnduranceRecord, 'parts'> & {
    parts: (Omit<EndurancePart, 'drop' | 'values' | 'base'> & { values: (number | null)[]; base: (number | null)[] })[];
  },
  size: SizeId,
  system: SystemInfo,
): RunRecord {
  return rescore({
    schema: SCHEMA,
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    mode: 'endurance',
    endurance: {
      ...endurance,
      parts: endurance.parts.map((p) => ({
        ...p,
        base: p.base.map((b) => (b === null ? null : r6(b))),
        values: p.values.map(r4n),
        drop: dropOf(p.values.map(r4n)),
      })),
    },
    size,
    scoreVersion: SCORE_VERSION,
    system,
    components: [],
    total: null,
    partial: false,
  });
}
