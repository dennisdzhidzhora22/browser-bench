// Saved result format (docs/SPEC.md, section 6, "How it works (M6)").
//
// One RunRecord per finished run. Compact: summary stats only, no per-sample
// arrays. `SCHEMA` versions this file format; `scoreVersion` versions the
// points (lib/scoring/constants.ts). They change independently.

import type { ComponentId, SizeId } from '../bench/types.ts';
import { dropOf } from '../harness/drop.ts';
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
  /** False when the output check failed (absent = passed; older records lack it). */
  checksumOk?: boolean;
  error?: string;
  /** All-cores tests: worker count, 1-worker value, scaling ratio and flags. */
  workers?: number;
  single?: number | null;
  singleSpread?: number;
  /** Samples taken in the 1-worker baseline. */
  singleSamples?: number;
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

/** One Endurance part (component): its window series, rounded (4 significant digits). */
export interface EndurancePart {
  id: ComponentId;
  /** e.g. "CPU — all cores", "GPU (Fast: …)". */
  label: string;
  workers: number;
  /** defKey of each kernel looped, in slice order, with its unit and first-window throughput. */
  keys: string[];
  units: string[];
  base: (number | null)[];
  /** Throughput per 5 s window relative to the first valid window; null = invalid (hidden, missed). */
  values: (number | null)[];
  /** 1 - mean(last minute) / mean(first minute). Recomputed on load, never trusted. */
  drop: number | null;
  error?: string;
}

export interface EnduranceRecord {
  /** Planned length. */
  durationMs: number;
  windowMs: number;
  /** Window indexes that overlapped a hidden-tab period. */
  hidden: number[];
  parts: EndurancePart[];
}

/** Windows a saved series may hold: 60 min of 5 s windows, with room. */
export const MAX_WINDOWS = 1_000;

export interface RunRecord {
  schema: number;
  id: string;
  /** ISO 8601, UTC. */
  time: string;
  /** Endurance runs have no components (no points) and an `endurance` block. */
  mode: RunMode | 'endurance';
  endurance?: EnduranceRecord;
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

// Strict shape check that also rebuilds: each parser returns a fresh copy
// holding only the known keys, or BAD. Unknown keys (junk, an own
// `__proto__`) are dropped, so they are neither stored nor re-exported.
const BAD = Symbol('bad');
type Parse = (x: unknown) => unknown;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const is =
  (ok: (x: unknown) => boolean): Parse =>
  (x) =>
    ok(x) ? x : BAD;
const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const str = is((x) => typeof x === 'string');
const num = is(finite);
const numOrNull = is((x) => x === null || finite(x));
const bool = is((x) => typeof x === 'boolean');
/** Integer >= 1 (core and worker counts). */
const count = is((x) => Number.isInteger(x) && (x as number) >= 1);
/** Integer >= 0 (sample counts). */
const whole = is((x) => Number.isInteger(x) && (x as number) >= 0);
const oneOf = (...xs: unknown[]) => is((x) => xs.includes(x));
const opt =
  (p: Parse): Parse =>
  (x) =>
    x === undefined ? undefined : p(x);
/** An object of strings (GPU adapter info), copied. */
const strings: Parse = (x) =>
  isObj(x) && Object.values(x).every((v) => typeof v === 'string') ? Object.fromEntries(Object.entries(x)) : BAD;
const listOf =
  (p: Parse): Parse =>
  (x) => {
    if (!Array.isArray(x)) return BAD;
    const out: unknown[] = [];
    for (const y of x) {
      const c = p(y);
      if (c === BAD) return BAD;
      out.push(c);
    }
    return out;
  };
const shape =
  (fields: Record<string, Parse>, ok: (o: Record<string, unknown>) => boolean = () => true): Parse =>
  (x) => {
    if (!isObj(x)) return BAD;
    const known = new Map<string, unknown>();
    for (const [k, p] of Object.entries(fields)) {
      const c = p(Object.hasOwn(x, k) ? x[k] : undefined);
      if (c === BAD) return BAD;
      if (c !== undefined) known.set(k, c);
    }
    // Known keys only, in the input's order.
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x)) if (known.has(k)) out[k] = known.get(k);
    return ok(out) ? out : BAD;
  };

const COMPONENT_ID = oneOf('cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage');

const KERNEL = shape(
  {
    key: str,
    unit: str,
    value: numOrNull,
    ms: opt(shape({ median: num, min: num, max: num })),
    spread: opt(num),
    samples: opt(whole),
    valid: bool,
    noisy: bool,
    hidden: bool,
    checksumOk: opt(bool),
    error: opt(str),
    workers: opt(count),
    single: opt(numOrNull),
    singleSpread: opt(num),
    singleSamples: opt(whole),
    scaling: opt(numOrNull),
    weakBaseline: opt(bool),
  },
  // A result measured while the tab was hidden, or with a failed check, is never valid.
  (k) => !(k['valid'] && (k['hidden'] || k['checksumOk'] === false)),
);

/** True when `key(x)` is distinct for every item (keyed lists in the UI need it). */
const unique = (xs: unknown, key: (x: Record<string, unknown>) => unknown) => {
  const list = xs as Record<string, unknown>[];
  return new Set(list.map(key)).size === list.length;
};

const COMPONENT = shape(
  {
  id: COMPONENT_ID,
  kernels: listOf(KERNEL),
  points: numOrNull,
  partial: bool,
  note: opt(str),
  error: opt(str),
  gpu: opt(
    shape({
      preference: oneOf('high-performance', 'low-power'),
      label: str,
      api: oneOf('webgpu', 'webgl2'),
      info: strings,
    }),
  ),
  sameGpu: opt(bool),
  fileBytes: opt(num),
  scaled: opt(bool),
  },
  (c) => unique(c['kernels'], (k) => k['key']),
);

const nonNeg = is((x) => x === null || (finite(x) && (x as number) >= 0));
const len = (x: unknown) => (x as unknown[]).length;

const ENDURANCE = shape(
  {
    durationMs: count,
    windowMs: count,
    hidden: listOf(whole),
    parts: listOf(
      shape(
        {
          id: COMPONENT_ID,
          label: str,
          workers: count,
          keys: listOf(str),
          units: listOf(str),
          base: listOf(nonNeg),
          values: listOf(nonNeg),
          drop: opt(numOrNull),
          error: opt(str),
        },
        (p) => {
          if (len(p['units']) !== len(p['keys']) || len(p['base']) !== len(p['keys'])) return false;
          if (len(p['values']) > MAX_WINDOWS) return false;
          p['drop'] = dropOf(p['values'] as (number | null)[]);
          return true;
        },
      ),
    ),
  },
  (e) => len(e['hidden']) <= MAX_WINDOWS,
);

/** ISO 8601 UTC, as `Date.toISOString()` writes it: these sort as strings. */
const ISO_UTC = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;

const RECORD = shape(
  {
  schema: oneOf(SCHEMA),
  id: str,
  time: is((t) => typeof t === 'string' && ISO_UTC.test(t) && !Number.isNaN(Date.parse(t))),
  mode: oneOf('quick', 'full', 'endurance'),
  endurance: opt(ENDURANCE),
  size: oneOf('smoke', 'standard'),
  scoreVersion: count,
  system: shape({
    browser: str,
    version: str,
    ua: str,
    platform: opt(str),
    cores: count,
    deviceMemory: opt(num),
    screen: str,
    isolated: bool,
    gpu: opt(listOf(str)),
  }),
  components: listOf(COMPONENT),
  total: numOrNull,
  partial: bool,
  },
  // One component per id; GPU: one per preference. Endurance: a series block and no components.
  (r) =>
    (r['mode'] === 'endurance'
      ? r['endurance'] !== undefined && len(r['components']) === 0
      : r['endurance'] === undefined) &&
    unique(r['components'], (c) => `${String(c['id'])}:${String((c['gpu'] as Record<string, unknown> | undefined)?.['preference'] ?? '')}`),
);

/**
 * A fresh copy of `r` holding only the known fields, or why `r` is not a
 * valid RunRecord of this schema. Any scoreVersion is accepted: other
 * versions load but are never compared.
 */
export function cleanRecord(r: unknown): RunRecord | string {
  if (!isObj(r)) return 'not an object';
  if (r['schema'] !== SCHEMA) return `unknown record format v${String(r['schema'])}`;
  const v = r['scoreVersion'];
  if (!(Number.isInteger(v) && (v as number) >= 1)) return 'bad scoreVersion';
  const c = RECORD(r);
  return c === BAD ? 'fields missing or of the wrong type' : (c as RunRecord);
}

/** Why `r` is not a valid RunRecord of this schema, or undefined when it is. */
export function checkRecord(r: unknown): string | undefined {
  const c = cleanRecord(r);
  return typeof c === 'string' ? c : undefined;
}
