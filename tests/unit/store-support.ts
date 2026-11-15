// Fixtures for the store tests: finished-run outcomes, a built record, a Map-backed localStorage.
// Every number is made up; nothing asserts on speed.
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import type { GpuPlan } from '../../src/lib/bench/gpu/index.ts';
import { webgpuKernels } from '../../src/lib/bench/gpu/index.ts';
import { memCopyMulti, memoryKernels } from '../../src/lib/bench/memory/index.ts';
import { storageKernels } from '../../src/lib/bench/storage/index.ts';
import { defKey, type ComponentId, type KernelDef, type SizeId } from '../../src/lib/bench/types.ts';
import type { MultiOutcome } from '../../src/lib/harness/multi.ts';
import type { KernelOutcome, RunMode } from '../../src/lib/harness/orchestrator.ts';
import { CONSTANTS } from '../../src/lib/scoring/constants.ts';
import { buildRecord, type RunView } from '../../src/lib/store/record.ts';
import type { RunRecord } from '../../src/lib/store/schema.ts';
import type { SystemInfo } from '../../src/lib/sysinfo/index.ts';

export const SYSTEM: SystemInfo = {
  browser: 'Google Chrome',
  version: '157.0.7444.60',
  ua: 'Mozilla/5.0 (test) Chrome/157.0.0.0',
  platform: 'Windows',
  cores: 16,
  deviceMemory: 8,
  screen: '2560x1440@1.5',
  isolated: true,
};

/** Not round on purpose: records keep six significant digits. */
export const STATS = { median: 12.3456789, min: 12.1, max: 12.9, spread: 0.0647 };

export function outcome(def: KernelDef, throughput: number | undefined, over: Partial<KernelOutcome> = {}): KernelOutcome {
  return {
    def,
    stats: STATS,
    throughput,
    samples: 5,
    checksumOk: true,
    hidden: false,
    noisy: false,
    valid: true,
    ...over,
  };
}

export function multiOutcome(def: KernelDef, throughput: number | undefined, over: Partial<MultiOutcome> = {}): MultiOutcome {
  return {
    def,
    workers: 16,
    all: { workers: 16, stats: STATS, samples: 5, throughput, bestWorker: throughput },
    single: { workers: 1, stats: { ...STATS, spread: 0.02 }, samples: 5, throughput: throughput && throughput / 8, bestWorker: undefined },
    scaling: 8,
    checksumOk: true,
    hidden: false,
    noisy: false,
    weakBaseline: false,
    valid: true,
    ...over,
  };
}

/** The throughput (record unit) that scores `scale` times the constant of `<component>/<defKey>`. */
export function tp(component: ComponentId, def: KernelDef, scale = 1): number {
  const c = CONSTANTS[`${component}/${defKey(def)}`]!;
  // The record stores latency as ns per access; the outcome carries hops/s = 1e9 / ns.
  return def.id === 'mem_latency' ? 1e9 / (c / scale) : c * scale;
}

export const FAST = { preference: 'high-performance', label: 'Fast GPU · xe' } as const;
export const SLOW = { preference: 'low-power', label: 'Slow GPU · uhd' } as const;

export function emptyView(): RunView {
  return {
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
}

/** A complete run of all five components (GPU: both targets) scoring `scale` times every constant. */
export function completeView(scale = 1): RunView {
  const plan: GpuPlan = { api: 'webgpu', targets: [{ ...FAST }, { ...SLOW }], sameGpu: false };
  return {
    outcomes: cpuKernels.map((d) => outcome(d, tp('cpu-single', d, scale))),
    multiOutcomes: cpuKernels.map((d) => multiOutcome(d, tp('cpu-multi', d, scale))),
    memOutcomes: memoryKernels.map((d) => outcome(d, tp('memory', d, scale))),
    memMulti: [multiOutcome(memCopyMulti, tp('memory', memCopyMulti, scale))],
    gpuPlan: plan,
    gpuRuns: plan.targets.map((target, i) => ({
      target,
      info: { vendor: i === 0 ? 'intel' : 'nvidia', architecture: 'xe', description: 'a "quoted" é name' },
      outcomes: webgpuKernels.map((d) => outcome(d, tp('gpu', d, scale))),
    })),
    storagePlan: { ok: true, fileBytes: 256 * 1024 * 1024, scaled: false },
    storageOutcomes: storageKernels.map((d) => outcome(d, tp('storage', d, scale))),
    storageError: undefined,
  };
}

export const ALL: readonly ComponentId[] = ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'];

export function completeRecord(over: { mode?: RunMode; size?: SizeId; scale?: number } = {}): RunRecord {
  return buildRecord(completeView(over.scale), ALL, over.mode ?? 'quick', over.size ?? 'standard', SYSTEM);
}

/** A small valid record with a chosen id and time (history tests need dozens of them). */
export function tinyRecord(id: string, time: string, over: Partial<RunRecord> = {}): RunRecord {
  const view = emptyView();
  view.outcomes = [outcome(cpuKernels[0]!, 300)];
  const r = buildRecord(view, ['cpu-single'], 'quick', 'standard', SYSTEM);
  return { ...r, id, time, ...over };
}

/** Time `n` minutes after a fixed start, ISO UTC. */
export const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + n * 60_000).toISOString();

/** A localStorage stand-in that can fail on demand. */
export class FakeStore {
  readonly data = new Map<string, string>();
  getItem = (k: string): string | null => this.data.get(k) ?? null;
  setItem = (k: string, v: string): void => void this.data.set(k, v);
  removeItem = (k: string): void => void this.data.delete(k);
}

export const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
