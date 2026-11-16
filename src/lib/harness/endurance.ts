// Endurance and Stress runs (docs/SPEC.md, 4, "How it works (M7)").
//
// Every selected part (component) gets its own workers, and all parts run at
// the same time. Each worker loops its part's kernels for the whole run and
// writes one rate per kernel per 5 s window into a shared Float64Array
// (protocol.ts, LoopRequest). The page reads those arrays at most once a
// second; nothing is posted per window.

import type { ComponentDef } from '../bench/components.ts';
import { fallbackKernels, planGpus, webgpuKernels, type GpuChoice } from '../bench/gpu/index.ts';
import { memCopyMulti } from '../bench/memory/index.ts';
import { defKey, type ComponentId, type KernelDef, type SizeId } from '../bench/types.ts';
import type { EnduranceRecord } from '../store/schema.ts';
import { dropOf, WINDOW_MS } from './drop.ts';
import { loadKernelModule } from './module.ts';
import { Channel, multiSize } from './multi.ts';
import { Cancelled, createGpuWorker, createWorker } from './orchestrator.ts';
import { LOOP, type GpuInit, type LoopKernel } from './protocol.ts';

export { dropOf, MINUTE, WINDOW_MS } from './drop.ts';

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
  outs: Float64Array[];
  controls: Int32Array[];
  info: Record<string, string>;
  error?: string;
}

export interface Loops {
  parts: PartState[];
  /** Absolute ms when window 0 starts; NaN until every worker is ready. */
  start(): number;
  /** Hidden-tab periods as [from, to] absolute ms (to = Infinity while hidden). */
  hidden: [number, number][];
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
  const hidden: [number, number][] = [];
  const doc = (globalThis as { document?: Document }).document;
  const onVis = () => {
    const last = hidden[hidden.length - 1];
    if (doc?.hidden) hidden.push([absNow(), Infinity]);
    else if (last && last[1] === Infinity) last[1] = absNow();
  };
  doc?.addEventListener('visibilitychange', onVis);
  if (doc?.hidden) onVis();

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
          s.outs = g.map(() => new Float64Array(new SharedArrayBuffer(n * kernels.length * 8)).fill(NaN));
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
                  })
                  .then((m) => {
                    if (m.type === 'looped') return;
                    // Peers of a failed worker stop too: the part's total would be wrong.
                    stopPart();
                    throw new Error(m.type === 'error' ? m.message : `unexpected reply: ${m.type}`);
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
      killAll();
    }
  })();

  return {
    parts: states,
    start: () => start,
    hidden,
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
  /** Throughput relative to the first fully valid window (1 = start); null = invalid. */
  values: (number | null)[];
  /** First valid window's throughput per kernel, in each def's unit; null until known. */
  base: (number | null)[];
  /** Window indexes that overlap a hidden-tab period. */
  hidden: number[];
}

/**
 * One part's series from its shared arrays. Window w counts once every worker
 * has finished it. A kernel's window rate is the sum over workers; the
 * window's value is the geomean over kernels of rate / base rate, where the
 * base is that kernel's rate in the first window in which every kernel was
 * measured and the tab was visible. Windows overlapping a hidden period,
 * or missing any kernel, are null.
 */
export function seriesOf(s: PartState, start: number, hidden: readonly [number, number][]): Series {
  const nk = s.part.kernels.length;
  let complete = Infinity;
  for (const c of s.controls) complete = Math.min(complete, Atomics.load(c, LOOP.DONE));
  if (!Number.isFinite(complete)) complete = 0;
  const values: (number | null)[] = [];
  const hiddenW: number[] = [];
  const rates = new Float64Array(nk);
  let base: Float64Array | undefined;
  for (let w = 0; w < complete; w++) {
    const a = start + w * WINDOW_MS;
    const isHidden = hidden.some(([from, to]) => from < a + WINDOW_MS && to > a);
    if (isHidden) hiddenW.push(w);
    let ok = !isHidden;
    for (let k = 0; k < nk && ok; k++) {
      let sum = 0;
      for (const out of s.outs) sum += out[w * nk + k]!;
      rates[k] = sum;
      ok = sum > 0; // NaN (missed) fails too
    }
    if (!ok) {
      values.push(null);
      continue;
    }
    base ??= Float64Array.from(rates);
    let logs = 0;
    for (let k = 0; k < nk; k++) logs += Math.log(rates[k]! / base[k]!);
    values.push(Math.exp(logs / nk));
  }
  return {
    values,
    // reps per ms -> units per second
    base: s.part.kernels.map((k, i) => (base ? base[i]! * k.def.work(k.size) * 1000 : null)),
    hidden: hiddenW,
  };
}

/** Page-side helpers for App.svelte, here so they load only with this chunk. */

/** The parts for the chosen components (storage is never looped). */
export async function planParts(
  chosen: readonly ComponentDef[],
  size: SizeId,
  workers: number,
  gpuChoice: GpuChoice,
): Promise<{ parts: LoopPart[]; notes: string[] }> {
  const cpu = (defs: readonly KernelDef[]) => defs.map((def) => ({ def, ...multiSize(def, size) }));
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
      if (!t || plan.api === 'none') notes.push('GPU: this browser offers neither WebGPU nor WebGL2.');
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

/** What the chart and the saved record show, read from the shared arrays now. */
export function snapshot(l: Loops, durationMs: number): EnduranceRecord {
  const series = l.parts.map((s) => seriesOf(s, l.start(), l.hidden));
  return {
    durationMs,
    windowMs: WINDOW_MS,
    hidden: series.reduce((a, s) => (s.hidden.length > a.length ? s.hidden : a), [] as number[]),
    parts: l.parts.map((s, i) => ({
      id: s.part.id,
      label: s.part.label,
      workers: s.part.workers,
      keys: s.part.kernels.map((k) => defKey(k.def)),
      units: s.part.kernels.map((k) => k.def.unit),
      base: series[i]!.base,
      values: series[i]!.values,
      drop: dropOf(series[i]!.values),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

/** m:ss */
export const clock = (t: number) => `${Math.floor(t / 60_000)}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}`;
