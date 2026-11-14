// Saved result format (docs/SPEC.md, section 6, "How it works (M6)").
//
// One RunRecord per finished run. Compact: summary stats only, no per-sample
// arrays. `SCHEMA` versions this file format; `scoreVersion` versions the
// points (lib/scoring/constants.ts). They change independently.

import type { ComponentId, SizeId } from '../bench/types.ts';
import type { RunMode } from '../harness/orchestrator.ts';
import type { SystemInfo } from '../sysinfo/index.ts';

/** Version of the record and export-file format. Bump on any shape change. */
export const SCHEMA = 1;

export interface KernelRecord {
  /** defKey(def): id, plus `:variant` when defs share a kernel. */
  key: string;
  unit: string;
  /** Headline number in `unit` (memory latency: ns per access). Null when invalid or failed. */
  value: number | null;
  /** Sample time stats in ms over the fastest samples (all-cores: ms per combined rep). */
  ms?: { median: number; min: number; max: number };
  spread?: number;
  samples?: number;
  valid: boolean;
  noisy: boolean;
  hidden: boolean;
  error?: string;
  /** All-cores tests: worker count, 1-worker value, scaling ratio and flags. */
  workers?: number;
  single?: number | null;
  singleSpread?: number;
  scaling?: number | null;
  weakBaseline?: boolean;
}

export interface GpuTargetRecord {
  preference: 'high-performance' | 'low-power';
  label: string;
  api: 'webgpu' | 'webgl2';
  /** What the GPU worker reported (adapter info). */
  info: Record<string, string>;
}

export interface ComponentRecord {
  id: ComponentId;
  kernels: KernelRecord[];
  /** Null when the component earns no points (see `note`). */
  points: number | null;
  /** True when a kernel was invalid or missing. */
  partial: boolean;
  /** Why there are no points, or what limits comparison. */
  note?: string;
  /** Why the component could not run or stopped. */
  error?: string;
  /** GPU: one record per tested GPU. */
  gpu?: GpuTargetRecord;
  /** GPU: "both" was asked for and gave the same GPU. */
  sameGpu?: boolean;
  /** Storage: test file size used, and whether it was scaled below standard. */
  fileBytes?: number;
  scaled?: boolean;
}

export interface RunRecord {
  schema: number;
  id: string;
  /** ISO 8601, UTC. */
  time: string;
  mode: RunMode;
  size: SizeId;
  scoreVersion: number;
  system: SystemInfo;
  components: ComponentRecord[];
  /** Geomean of the component points that count. Null for smoke runs or no points. */
  total: number | null;
  partial: boolean;
}

/** Shape of an export file. */
export interface ExportFile {
  format: 'browser-bench';
  schema: number;
  runs: RunRecord[];
}

// Strict shape check. Each field: a type code, '?' suffix = optional.
// s string, n finite number, N number or null, b boolean, o object of strings.
type Shape = Record<string, string | ((x: unknown) => boolean)>;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const TYPES: Record<string, (x: unknown) => boolean> = {
  s: (x) => typeof x === 'string',
  n: (x) => typeof x === 'number' && Number.isFinite(x),
  N: (x) => x === null || TYPES['n']!(x),
  b: (x) => typeof x === 'boolean',
  o: (x) => isObj(x) && Object.values(x).every(TYPES['s']!),
};

function fits(x: unknown, shape: Shape): boolean {
  return (
    isObj(x) &&
    Object.entries(shape).every(([k, t]) => {
      const v = x[k];
      if (typeof t === 'function') return t(v);
      return (t.endsWith('?') && v === undefined) || TYPES[t[0]!]!(v);
    })
  );
}

const oneOf = (...xs: unknown[]) => (x: unknown) => xs.includes(x);
const listOf = (shape: Shape) => (x: unknown) => Array.isArray(x) && x.every((y) => fits(y, shape));

const KERNEL: Shape = {
  key: 's',
  unit: 's',
  value: 'N',
  ms: (m) => m === undefined || fits(m, { median: 'n', min: 'n', max: 'n' }),
  spread: 'n?',
  samples: 'n?',
  valid: 'b',
  noisy: 'b',
  hidden: 'b',
  error: 's?',
  workers: 'n?',
  single: 'N?',
  singleSpread: 'n?',
  scaling: 'N?',
  weakBaseline: 'b?',
};

const COMPONENT: Shape = {
  id: oneOf('cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'),
  kernels: listOf(KERNEL),
  points: 'N',
  partial: 'b',
  note: 's?',
  error: 's?',
  gpu: (g) =>
    g === undefined ||
    fits(g, {
      preference: oneOf('high-performance', 'low-power'),
      label: 's',
      api: oneOf('webgpu', 'webgl2'),
      info: 'o',
    }),
  sameGpu: 'b?',
  fileBytes: 'n?',
  scaled: 'b?',
};

const RECORD: Shape = {
  id: 's',
  time: (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)),
  mode: oneOf('quick', 'full'),
  size: oneOf('smoke', 'standard'),
  system: (x) =>
    fits(x, {
      browser: 's',
      version: 's',
      ua: 's',
      platform: 's?',
      cores: 'n',
      deviceMemory: 'n?',
      screen: 's',
      isolated: 'b',
      gpu: (g) => g === undefined || (Array.isArray(g) && g.every(TYPES['s']!)),
    }),
  components: listOf(COMPONENT),
  total: 'N',
  partial: 'b',
};

/**
 * Why `r` is not a valid RunRecord of this schema, or undefined when it is.
 * Any scoreVersion is accepted: other versions load but are never compared.
 */
export function checkRecord(r: unknown): string | undefined {
  if (!isObj(r)) return 'not an object';
  if (r['schema'] !== SCHEMA) return `unknown record format v${String(r['schema'])}`;
  const v = r['scoreVersion'];
  if (!(Number.isInteger(v) && (v as number) >= 1)) return 'bad scoreVersion';
  return fits(r, RECORD) ? undefined : 'fields missing or of the wrong type';
}
