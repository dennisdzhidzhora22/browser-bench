// Endurance and Stress runs (docs/SPEC.md, 4, "How it works (M7)").
//
// Every selected part (component) gets its own workers, and all parts run at
// the same time. Each worker loops its part's kernels for the whole run and
// writes two rates per kernel per 5 s window (mean, fastest rep) into shared
// Float64Arrays (protocol.ts, LoopRequest). The page reads those arrays at
// most once a second; nothing is posted per window.

import type { ComponentDef } from '../bench/components.ts';
import { fallbackKernels, planGpus, webgpuKernels, type GpuChoice } from '../bench/gpu/index.ts';
import { memCopyMulti } from '../bench/memory/index.ts';
import { defKey, type ComponentId, type KernelDef, type SizeId } from '../bench/types.ts';
import type { EnduranceRecord } from '../store/schema.ts';
import { figuresOf, WINDOW_MS } from './drop.ts';
import { loadKernelModule } from './module.ts';
import { Channel, multiSize } from './multi.ts';
import { Cancelled, createGpuWorker, createWorker } from './orchestrator.ts';
import { LOOP, type GpuInit, type LoopKernel } from './protocol.ts';

export { burstOf, chartBase, dropOf, MINUTE, noisyOf, WINDOW_MS } from './drop.ts';

/** Stress stops by itself after this long (bounds the preallocated arrays). */
export const STRESS_MAX_MS = 12 * 3_600_000;
/** Workers get this long after `ready` to prepare (GPU: calibrate) before window 0. */
export const START_DELAY_MS = 3_000;
/** Stop waits this long for workers to finish their slice (GPU: validate) before terminating them. */
export const STOP_GRACE_MS = 3_000;

export interface LoopPart {
  id: ComponentId;
  label: string;
  /** Kernels in slice order, with the size each runs at. */
  kernels: { def: KernelDef; size: number; expected: number }[];
  workers: number;
  /** GPU parts: which GPU and API. CPU parts get the kernel module. */
  gpu?: GpuInit;
}

export interface PartState {
  part: LoopPart;
  /** Per worker: mean rate per slice (LoopRequest.out). */
  outs: Float64Array[];
  /** Per worker: the fastest rep's rate per slice (LoopRequest.best). Absent: the series uses `outs`. */
  bests?: Float64Array[];
  controls: Int32Array[];
  info: Record<string, string>;
  error?: string;
  /** Live page only: windows already computed (see seriesOf). */
  cache?: SeriesCache;
}

/** Periods as [from, to] absolute ms (to = Infinity while still open). */
export type Periods = [number, number][];

export interface Loops {
  parts: PartState[];
  /** Absolute ms when window 0 starts; NaN until every worker is ready. */
  start(): number;
  /** Hidden-tab periods. */
  hidden: Periods;
  /**
   * Periods the window was not focused (another window in front). Windows 11
   * moves the threads of a background window to efficiency cores (EcoQoS)
   * while the page stays "visible", so these windows are invalid too. Only
   * recorded once the window has had focus since the start: before that
   * (automation, or a window that never had focus) focus is unknown.
   */
  unfocused: Periods;
  /** True once the window has had focus since the start. */
  focusKnown(): boolean;
  /** Reads document.hasFocus() now; backs up the focus and blur events (the page calls it each second). */
  checkFocus(): void;
  /** Resolves when every part has finished or failed. Rejects with Cancelled after cancel(). */
  done: Promise<void>;
  /** Ends the loops gracefully, then terminates every worker. */
  stop(): Promise<void>;
  /** Terminates every worker now. */
  cancel(): void;
}

/** The clock workers share (timeOrigin + now). */
export const absNow = () => performance.timeOrigin + performance.now();

export function startLoops(o: {
  parts: LoopPart[];
  windows: number;
  makeWorker?: (p: LoopPart) => Worker;
  loadModule?: () => Promise<WebAssembly.Module>;
}): Loops {
  const states: PartState[] = o.parts.map((part) => ({
    part,
    outs: [],
    controls: [],
    info: {},
  }));
  const channels: Channel[] = [];
  let start = NaN;
  let cancelled = false;
  /** Set by stop(): the terminations that follow are not part failures. */
  let stopping = false;
  const hidden: Periods = [];
  const unfocused: Periods = [];
  const doc = (globalThis as { document?: Document }).document;
  const win = doc?.defaultView ?? undefined;
  const onVis = () => {
    const last = hidden[hidden.length - 1];
    if (doc?.hidden) hidden.push([absNow(), Infinity]);
    else if (last && last[1] === Infinity) last[1] = absNow();
  };
  doc?.addEventListener('visibilitychange', onVis);
  if (doc?.hidden) onVis();
  // Focus is known whenever the page can ask (document.hasFocus). A window
  // that is already in the background when the loops start (the user clicked
  // Run, then switched away) is unfocused from the start: that is exactly the
  // case Windows slows down (EcoQoS). "Unknown" is only for pages without hasFocus.
  const focusSeen = typeof doc?.hasFocus === 'function';
  const onBlur = () => {
    const last = unfocused[unfocused.length - 1];
    if (focusSeen && !(last && last[1] === Infinity)) unfocused.push([absNow(), Infinity]);
  };
  const onFocus = () => {
    const last = unfocused[unfocused.length - 1];
    if (last && last[1] === Infinity) last[1] = absNow();
  };
  win?.addEventListener('blur', onBlur);
  win?.addEventListener('focus', onFocus);
  if (focusSeen && !doc!.hasFocus()) onBlur();

  const killAll = () => {
    // STOP first: a worker deep in its loop exits at its next check even if
    // the browser is slow to tear down a busy thread after terminate().
    for (const s of states) for (const c of s.controls) Atomics.store(c, LOOP.STOP, 1);
    for (const c of channels) c.fail(new Cancelled());
  };

  const done = (async () => {
    try {
      const module = o.parts.some((p) => !p.gpu) ? await (o.loadModule ?? loadKernelModule)() : undefined;
      if (cancelled) throw new Cancelled();
      // Start every part's workers; a part that cannot start is marked failed.
      const groups = await Promise.all(
        states.map(async (s) => {
          const g = Array.from({ length: s.part.workers }, () => {
            const c = new Channel((o.makeWorker ?? ((p) => (p.gpu ? createGpuWorker() : createWorker())))(s.part));
            channels.push(c);
            return c;
          });
          try {
            const r = await Promise.all(
              g.map((c) => c.send({ type: 'init', spinMs: 0, ...(s.part.gpu ? { gpu: s.part.gpu } : { module }) })),
            );
            for (const m of r) {
              if (m.type === 'error') throw new Error(`worker init failed: ${m.message}`);
              if (m.type === 'ready' && m.info) s.info = m.info;
            }
            return g;
          } catch (err) {
            s.error = message(err);
            for (const c of g) c.fail(new Error('part failed'));
            return [];
          }
        }),
      );
      if (cancelled) throw new Cancelled();
      if (stopping) return;
      start = absNow() + START_DELAY_MS;
      const n = o.windows;
      await Promise.all(
        states.map(async (s, i) => {
          const g = groups[i]!;
          if (g.length === 0) return;
          const kernels: LoopKernel[] = s.part.kernels.map((k) => ({
            kernel: k.def.id,
            seed: k.def.seed,
            size: k.size,
            expected: k.expected,
            ...(k.def.targetMs && s.part.gpu && k.size !== k.def.sizes.smoke ? { targetMs: k.def.targetMs } : {}),
          }));
          const f64 = () => new Float64Array(new SharedArrayBuffer(n * kernels.length * 8)).fill(NaN);
          s.outs = g.map(f64);
          const bests = g.map(f64);
          s.bests = bests;
          s.controls = g.map(() => new Int32Array(new SharedArrayBuffer(LOOP.LENGTH * 4)));
          const stopPart = () => {
            for (const c of s.controls) Atomics.store(c, LOOP.STOP, 1);
          };
          try {
            await Promise.all(
              g.map((c, w) =>
                c
                  .send({
                    type: 'loop',
                    id: i,
                    kernels,
                    start,
                    windowMs: WINDOW_MS,
                    windows: n,
                    control: s.controls[w]!,
                    out: s.outs[w]!,
                    best: bests[w]!,
                  })
                  .then((m) => {
                    if (m.type === 'looped') return;
                    // A worker's own failure (checksum, GPU validation) counts even after
                    // Stop: only the rejections of terminated workers are not failures.
                    const why = m.type === 'error' ? m.message : `unexpected reply: ${m.type}`;
                    s.error ??= why;
                    // Peers of a failed worker stop too: the part's total would be wrong.
                    stopPart();
                    throw new Error(why);
                  }),
              ),
            );
          } catch (err) {
            if (cancelled || stopping) return;
            s.error ??= message(err);
            stopPart();
          } finally {
            for (const c of g) c.fail(new Error('part finished'));
          }
        }),
      );
      if (cancelled) throw new Cancelled();
    } finally {
      doc?.removeEventListener('visibilitychange', onVis);
      win?.removeEventListener('blur', onBlur);
      win?.removeEventListener('focus', onFocus);
      killAll();
    }
  })();

  return {
    parts: states,
    start: () => start,
    hidden,
    unfocused,
    focusKnown: () => focusSeen,
    checkFocus() {
      if (!doc?.hasFocus) return;
      if (doc.hasFocus()) onFocus();
      else onBlur();
    },
    done,
    async stop() {
      stopping = true;
      for (const s of states) for (const c of s.controls) Atomics.store(c, LOOP.STOP, 1);
      await Promise.race([done.catch(() => {}), new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
      killAll();
    },
    cancel() {
      cancelled = true;
      killAll();
    },
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface Series {
  /** Throughput relative to the first fully valid window (1 = that window); null = invalid. */
  values: (number | null)[];
  /** First valid window's throughput per kernel (mean rate), in each def's unit; null until known. */
  base: (number | null)[];
  /** Window indexes that overlap a hidden-tab period. */
  hidden: number[];
  /** Window indexes that overlap a period the window was not focused. */
  unfocused: number[];
}

/** Windows of a live series that can no longer change, kept between page updates. */
export interface SeriesCache {
  values: (number | null)[];
  hidden: number[];
  unfocused: number[];
  /** Fastest-rep rate per kernel of the first valid window (the series' 1). */
  base?: Float64Array;
  /** Mean rate per kernel of that window. */
  baseMean?: Float64Array;
}

/** A finished window is kept this long after its end before it is cached: later events cannot touch it. */
const SETTLE_MS = 2_000;

const overlaps = (periods: readonly (readonly [number, number])[], a: number) =>
  periods.some(([from, to]) => from < a + WINDOW_MS && to > a);

/**
 * One part's series from its shared arrays. Window w counts once every worker
 * has finished it. A kernel's window rate is the sum over workers of the rate
 * of each worker's fastest rep in that slice (`bests`: on hybrid CPUs the
 * mean rate mostly shows which core the thread sat on). The window's value
 * is the geomean over kernels of rate / base rate, where the base is that
 * kernel's rate in the first window in which every kernel was measured and
 * which was valid. Windows overlapping a hidden or unfocused period, or
 * missing any kernel, are null.
 *
 * With `cache` (the live page), windows that ended more than SETTLE_MS before
 * `now` are computed once and kept; only newer ones are recomputed.
 */
export function seriesOf(
  s: PartState,
  start: number,
  hidden: readonly (readonly [number, number])[],
  unfocused: readonly (readonly [number, number])[] = [],
  cache?: SeriesCache,
  now = absNow(),
): Series {
  const nk = s.part.kernels.length;
  const src = s.bests ?? s.outs;
  let complete = Infinity;
  for (const c of s.controls) complete = Math.min(complete, Atomics.load(c, LOOP.DONE));
  if (!Number.isFinite(complete)) complete = 0;
  // Cached windows are reused only while DONE has not gone back (it never does with real workers).
  const from = cache && cache.values.length <= complete ? cache.values.length : 0;
  const values = from ? cache!.values.slice() : [];
  const hiddenW = from ? cache!.hidden.slice() : [];
  const unfocusedW = from ? cache!.unfocused.slice() : [];
  let base = from ? cache!.base : undefined;
  let baseMean = from ? cache!.baseMean : undefined;
  const rates = new Float64Array(nk);
  let keep = from; // windows below this are fixed and go into the cache
  for (let w = from; w < complete; w++) {
    const a = start + w * WINDOW_MS;
    const isHidden = overlaps(hidden, a);
    const isUnfocused = overlaps(unfocused, a);
    if (isHidden) hiddenW.push(w);
    if (isUnfocused) unfocusedW.push(w);
    let ok = !isHidden && !isUnfocused;
    for (let k = 0; k < nk && ok; k++) {
      let sum = 0;
      for (const out of src) sum += out[w * nk + k]!;
      rates[k] = sum;
      ok = sum > 0; // NaN (missed) fails too
    }
    let v: number | null = null;
    if (ok) {
      if (!base) {
        base = Float64Array.from(rates);
        const m = new Float64Array(nk);
        for (let k = 0; k < nk; k++) for (const out of s.outs) m[k] = m[k]! + out[w * nk + k]!;
        baseMean = m;
      }
      let logs = 0;
      for (let k = 0; k < nk; k++) logs += Math.log(rates[k]! / base[k]!);
      v = Math.exp(logs / nk);
    }
    values.push(v);
    if (keep === w && a + WINDOW_MS + SETTLE_MS <= now) keep = w + 1;
  }
  if (cache) {
    cache.values = values.slice(0, keep);
    cache.hidden = hiddenW.filter((w) => w < keep);
    cache.unfocused = unfocusedW.filter((w) => w < keep);
    // The base is cached only once the window it came from is.
    const fixed = cache.values.some((v) => v !== null);
    cache.base = fixed ? base : undefined;
    cache.baseMean = fixed ? baseMean : undefined;
  }
  return {
    values,
    // reps per ms -> units per second
    base: s.part.kernels.map((k, i) => (baseMean ? baseMean[i]! * k.def.work(k.size) * 1000 : null)),
    hidden: hiddenW,
    unfocused: unfocusedW,
  };
}

/** Slices each worker of a part skipped (LOOP.MISSED); zeros for a part whose workers never looped. */
export const missedOf = (s: PartState): number[] =>
  s.controls.length ? s.controls.map((c) => Atomics.load(c, LOOP.MISSED)) : Array<number>(s.part.workers).fill(0);

/** Page-side helpers for App.svelte, here so they load only with this chunk. */

/** Loop size of a CPU kernel (KernelDef.loop, else its all-cores size). */
export function loopSize(def: KernelDef, size: SizeId): { size: number; expected: number } {
  if (size === 'smoke') return { size: def.sizes.smoke, expected: def.expected.smoke };
  return def.loop ?? multiSize(def, size);
}

/** The parts for the chosen components (storage is never looped). */
export async function planParts(
  chosen: readonly ComponentDef[],
  size: SizeId,
  workers: number,
  gpuChoice: GpuChoice,
): Promise<{ parts: LoopPart[]; notes: string[] }> {
  const cpu = (defs: readonly KernelDef[]) => defs.map((def) => ({ def, ...loopSize(def, size) }));
  const parts: LoopPart[] = [];
  const notes: string[] = [];
  for (const c of chosen) {
    if (c.id === 'cpu-single') parts.push({ id: c.id, label: c.name, kernels: cpu(c.kernels), workers: 1 });
    else if (c.id === 'cpu-multi') parts.push({ id: c.id, label: c.name, kernels: cpu(c.kernels), workers });
    else if (c.id === 'memory') {
      parts.push({ id: c.id, label: 'Memory — all-cores copy', kernels: cpu([memCopyMulti]), workers });
    } else if (c.id === 'gpu') {
      const plan = await planGpus(gpuChoice);
      const t = plan.targets[0]; // with "Both", the Fast GPU only
      if (!t || plan.api === 'none') notes.push('GPU: not looped, this browser offers neither WebGPU nor WebGL2.');
      else {
        const defs = plan.api === 'webgpu' ? webgpuKernels : fallbackKernels;
        parts.push({
          id: c.id,
          label: `GPU (${t.label})`,
          kernels: defs.map((def) => ({ def, size: def.sizes[size], expected: def.expected[size] })),
          workers: 1,
          gpu: { preference: t.preference, api: plan.api },
        });
      }
    }
  }
  return { parts, notes };
}

/** Saved with the run when focus could not be tracked. */
export const FOCUS_UNKNOWN_NOTE =
  'Window focus unknown: this browser cannot report window focus, so periods with another window in front could not be marked.';

/**
 * What the chart and the saved record show, read from the shared arrays now.
 * `live` (the page's 1 s update): finished windows are kept between calls;
 * the final snapshot computes everything afresh.
 */
/** What snapshot reads from a run: focus tracking is optional (absent = no unfocused periods, focus known). */
export type LoopsView = Pick<Loops, 'parts' | 'start' | 'hidden'> & Partial<Pick<Loops, 'unfocused' | 'focusKnown'>>;

export function snapshot(l: LoopsView, durationMs: number, notes: readonly string[] = [], live = false): EnduranceRecord {
  const now = absNow();
  const series = l.parts.map((s) => {
    if (live) s.cache ??= { values: [], hidden: [], unfocused: [] };
    return seriesOf(s, l.start(), l.hidden, l.unfocused ?? [], live ? s.cache : undefined, now);
  });
  const longest = (pick: (x: Series) => number[]) =>
    series.reduce((a, x) => (pick(x).length > a.length ? pick(x) : a), [] as number[]);
  const allNotes = [...notes, ...(l.focusKnown && !l.focusKnown() ? [FOCUS_UNKNOWN_NOTE] : [])];
  return {
    durationMs,
    windowMs: WINDOW_MS,
    hidden: longest((x) => x.hidden),
    unfocused: longest((x) => x.unfocused),
    ...(allNotes.length ? { notes: allNotes } : {}),
    parts: l.parts.map((s, i) => ({
      id: s.part.id,
      label: s.part.label,
      workers: s.part.workers,
      keys: s.part.kernels.map((k) => defKey(k.def)),
      units: s.part.kernels.map((k) => k.def.unit),
      base: series[i]!.base,
      values: series[i]!.values,
      missed: missedOf(s),
      ...figuresOf(series[i]!.values, s.error),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

/** m:ss */
export const clock = (t: number) => `${Math.floor(t / 60_000)}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}`;
