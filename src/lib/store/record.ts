// Converts a finished run's outcomes into a RunRecord (scored), and a saved
// record back into the shapes the results views take.

import { cpuKernels } from '../bench/cpu/index.ts';
import { gpuKernels, type GpuPlan, type GpuTarget } from '../bench/gpu/index.ts';
import { latencyNs, memCopyMulti, memoryKernels } from '../bench/memory/index.ts';
import { storageKernels, type StoragePlan } from '../bench/storage/index.ts';
import { defKey, type ComponentId, type KernelDef, type SizeId } from '../bench/types.ts';
import type { MultiOutcome } from '../harness/multi.ts';
import type { KernelOutcome, RunMode } from '../harness/orchestrator.ts';
import type { SampleStats } from '../harness/stats.ts';
import { SCORE_VERSION } from '../scoring/constants.ts';
import { scoreComponent, scoreTotal } from '../scoring/score.ts';
import type { SystemInfo } from '../sysinfo/index.ts';
import { SCHEMA, type ComponentRecord, type KernelRecord, type RunRecord } from './schema.ts';

export interface GpuRun {
  target: GpuTarget;
  info: Record<string, string>;
  outcomes: KernelOutcome[];
}

/** Everything the results views show for one run (live or saved). */
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

function flags(o: { valid: boolean; noisy: boolean; hidden: boolean; error?: string }) {
  return { valid: o.valid, noisy: o.noisy, hidden: o.hidden, ...(o.error ? { error: o.error } : {}) };
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
    ...(o.single ? { singleSpread: r6(o.single.stats.spread) } : {}),
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
  const comps: Omit<ComponentRecord, 'points' | 'partial'>[] = [];
  for (const id of ran) {
    if (id === 'cpu-single') comps.push({ id, kernels: v.outcomes.map(kernelRecord) });
    else if (id === 'cpu-multi') comps.push({ id, kernels: v.multiOutcomes.map(multiRecord) });
    else if (id === 'memory') {
      comps.push({ id, kernels: [...v.memOutcomes.map(kernelRecord), ...v.memMulti.map(multiRecord)] });
    } else if (id === 'gpu') {
      const api = v.gpuPlan?.api;
      if (api === 'webgpu' || api === 'webgl2') {
        v.gpuRuns.forEach((g, i) =>
          comps.push({
            id,
            gpu: { preference: g.target.preference, label: g.target.label, api, info: { ...g.info } },
            kernels: g.outcomes.map(kernelRecord),
            ...(i === 0 && v.gpuPlan?.sameGpu ? { sameGpu: true } : {}),
          }),
        );
      } else comps.push({ id, kernels: [], error: 'This browser offers neither WebGPU nor WebGL2.' });
    } else if (id === 'storage') {
      const p = v.storagePlan;
      if (!p?.ok) comps.push({ id, kernels: [], error: p?.message ?? 'not run' });
      else {
        comps.push({
          id,
          kernels: v.storageOutcomes.map(kernelRecord),
          fileBytes: p.fileBytes,
          scaled: p.scaled,
          ...(v.storageError ? { error: v.storageError } : {}),
        });
      }
    }
  }
  const components: ComponentRecord[] = comps.map((c) => {
    const s = scoreComponent(c as ComponentRecord, size);
    return { ...c, points: s.points, partial: s.partial, ...(s.note ? { note: s.note } : {}) };
  });
  const gpus = v.gpuRuns.map((g) => g.target.label);
  return {
    schema: SCHEMA,
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    mode,
    size,
    scoreVersion: SCORE_VERSION,
    system: { ...system, ...(gpus.length ? { gpu: gpus } : {}) },
    components,
    ...scoreTotal(components),
  };
}

const REGISTRY: Record<ComponentId, readonly KernelDef[]> = {
  'cpu-single': cpuKernels,
  'cpu-multi': cpuKernels,
  memory: [...memoryKernels, memCopyMulti],
  gpu: gpuKernels,
  storage: storageKernels,
};

/** The current def for a saved key, or a minimal stand-in when this build no longer has it. */
function defFor(c: ComponentId, k: KernelRecord): KernelDef {
  const [id, variant] = k.key.split(':');
  return (
    REGISTRY[c].find((d) => defKey(d) === k.key) ??
    ({ id, variant, name: k.key, stresses: '', unit: k.unit } as KernelDef)
  );
}

/** A saved kernel as the views' outcome shape. One object serves both views (single- and all-cores). */
function back(c: ComponentId, k: KernelRecord): KernelOutcome & MultiOutcome {
  const stats = (spread = 0): SampleStats | undefined => (k.ms ? { ...k.ms, spread } : undefined);
  const group = (tp: number | null | undefined, spread?: number) =>
    k.ms ? { workers: k.workers, stats: stats(spread), samples: k.samples, throughput: tp ?? undefined } : undefined;
  const v = k.value ?? undefined;
  return {
    def: defFor(c, k),
    stats: stats(k.spread),
    throughput: v !== undefined && k.unit === 'ns' ? 1e9 / v : v,
    samples: k.samples,
    checksumOk: k.valid || k.hidden,
    hidden: k.hidden,
    noisy: k.noisy,
    valid: k.valid,
    error: k.error,
    workers: k.workers,
    all: group(k.value, k.spread),
    single: group(k.single, k.singleSpread),
    scaling: k.scaling ?? undefined,
    weakBaseline: k.weakBaseline,
  } as KernelOutcome & MultiOutcome;
}

/** The results-view shapes for a saved record. */
export function toView(r: RunRecord): RunView {
  const v: RunView = {
    outcomes: [],
    multiOutcomes: [],
    memOutcomes: [],
    memMulti: [],
    gpuPlan: undefined,
    gpuRuns: [],
    storagePlan: undefined,
    storageOutcomes: [],
    storageError: undefined,
  };
  for (const c of r.components) {
    const single = (ks: KernelRecord[]) => ks.map((k) => back(c.id, k));
    if (c.id === 'cpu-single') v.outcomes = single(c.kernels);
    else if (c.id === 'cpu-multi') v.multiOutcomes = single(c.kernels);
    else if (c.id === 'memory') {
      v.memOutcomes = single(c.kernels.filter((k) => k.workers === undefined));
      v.memMulti = single(c.kernels.filter((k) => k.workers !== undefined));
    } else if (c.id === 'gpu') {
      v.gpuPlan ??= { api: c.gpu?.api ?? 'none', targets: [], sameGpu: c.sameGpu ?? false };
      if (c.gpu) {
        const target = { preference: c.gpu.preference, label: c.gpu.label };
        v.gpuPlan.targets.push(target);
        v.gpuRuns.push({ target, info: c.gpu.info, outcomes: single(c.kernels) });
      }
    } else if (c.id === 'storage') {
      v.storagePlan =
        c.fileBytes === undefined
          ? { ok: false, message: c.error ?? 'not run' }
          : { ok: true, fileBytes: c.fileBytes, scaled: c.scaled ?? false };
      v.storageOutcomes = single(c.kernels);
      v.storageError = c.fileBytes === undefined ? undefined : c.error;
    }
  }
  return v;
}
