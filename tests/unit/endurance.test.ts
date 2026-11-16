// M7 (docs/SPEC.md, section 4, "How it works (M7)"): the window series, the focus tracker, the snapshot, the strict
// validation of the saved `endurance` block, the record built from a run, and the Wake Lock helper. (The figures are in
// drop.test.ts, the worker loop in loop-worker.test.ts.) Fake shared arrays, a fake window / document and a fake
// navigator.wakeLock; no real workers, no clocks. Nothing here asserts on speed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { defKey, type KernelDef } from '../../src/lib/bench/types.ts';
import { burstOf, dropOf, noisyOf, WINDOW_MS } from '../../src/lib/harness/drop.ts';
import {
  absNow,
  FOCUS_UNKNOWN_NOTE,
  missedOf,
  seriesOf,
  snapshot,
  startLoops,
  type LoopPart,
  type Loops,
  type LoopsView,
  type PartState,
  type SeriesCache,
} from '../../src/lib/harness/endurance.ts';
import { Cancelled } from '../../src/lib/harness/orchestrator.ts';
import { LOOP } from '../../src/lib/harness/protocol.ts';
import { holdWakeLock, type WakeState } from '../../src/lib/harness/wakelock.ts';
import { exportText } from '../../src/lib/store/export.ts';
import { loadHistory, HISTORY_KEY, saveHistory } from '../../src/lib/store/history.ts';
import { parseExport } from '../../src/lib/store/import.ts';
import { buildEnduranceRecord } from '../../src/lib/store/record.ts';
import { cleanRecord, MAX_WINDOWS, SCHEMA, type RunRecord } from '../../src/lib/store/schema.ts';
import { at, FakeStore, SYSTEM, tinyRecord } from './store-support.ts';

const nulls = (n: number) => Array<number | null>(n).fill(null);

// ---------------------------------------------------------------------------------------------------------------
// seriesOf with fake shared arrays

const def = (id: string): KernelDef => cpuKernels.find((d) => d.id === id)!;
const A = def('sha256');
const B = def('lz');

/** A part with `nw` workers, `nk` kernels (A, B) and `windows` windows; every slot starts as NaN. */
function part(nk: 1 | 2, nw: number, windows: number): PartState {
  const kernels = [A, B].slice(0, nk).map((d) => ({ def: d, size: d.sizes.smoke, expected: d.expected.smoke }));
  const lp: LoopPart = { id: 'cpu-multi', label: 'CPU — all cores', kernels, workers: nw };
  return {
    part: lp,
    outs: Array.from({ length: nw }, () => new Float64Array(new SharedArrayBuffer(windows * nk * 8)).fill(NaN)),
    controls: Array.from({ length: nw }, () => new Int32Array(new SharedArrayBuffer(LOOP.LENGTH * 4))),
    info: {},
  };
}
const done = (s: PartState, ...counts: number[]) => counts.forEach((n, w) => Atomics.store(s.controls[w]!, LOOP.DONE, n));
const START = 1_000_000;
const win = (w: number) => START + w * WINDOW_MS;

describe('seriesOf: one part, read from its shared arrays', () => {
  it('has no windows before any worker has finished one, or with no workers at all', () => {
    const s = part(1, 2, 4);
    expect(seriesOf(s, START, [])).toEqual({ values: [], base: [null], hidden: [], unfocused: [] });
    s.outs[0]!.fill(5);
    s.outs[1]!.fill(5);
    done(s, 3, 0); // the second worker has not finished window 0
    expect(seriesOf(s, START, []).values).toEqual([]);
    expect(seriesOf(part(1, 0, 4), START, []).values).toEqual([]); // a part whose workers never started
  });

  it('counts a window only once every worker has finished it (the slowest worker decides)', () => {
    const s = part(1, 2, 4);
    for (const o of s.outs) o.set([2, 2, 2, 2]);
    done(s, 4, 2);
    expect(seriesOf(s, START, []).values).toEqual([1, 1]);
    done(s, 1, 4);
    expect(seriesOf(s, START, []).values).toEqual([1]);
  });

  it('first valid window is 100%; the rest are relative to it; a kernel rate is the sum over workers', () => {
    const s = part(1, 2, 3);
    s.outs[0]!.set([1, 2, 0.5]);
    s.outs[1]!.set([3, 6, 1.5]); // sums: 4, 8, 2
    done(s, 3, 3);
    const r = seriesOf(s, START, []);
    expect(r.values).toEqual([1, 2, 0.5]);
    expect(r.hidden).toEqual([]);
  });

  it('base is the first window rate in units per second (reps/ms * work * 1000)', () => {
    const s = part(2, 1, 2);
    s.outs[0]!.set([0.5, 3, 0.25, 6]); // window 0: A 0.5, B 3
    done(s, 2);
    const k = s.part.kernels;
    const r = seriesOf(s, START, []);
    expect(r.base).toEqual([0.5 * A.work(k[0]!.size) * 1000, 3 * B.work(k[1]!.size) * 1000]);
  });

  it('a window missing a worker slice (NaN) is invalid, and so is one with a rate of 0', () => {
    const s = part(1, 2, 4);
    s.outs[0]!.set([1, 1, 1, 1]);
    s.outs[1]!.set([1, NaN, 0, 1]);
    done(s, 4, 4);
    expect(seriesOf(s, START, []).values).toEqual([1, null, 1 / 2, 1]);
    // One worker at 0 is fine (the sum counts); every worker at 0 is not.
    s.outs[0]!.set([0, 1, 0, 1]);
    s.outs[1]!.set([1, 1, 0, 1]);
    expect(seriesOf(s, START, []).values).toEqual([1, 2, null, 2]); // sums 1, 2, 0, 2
  });

  it('a window missing one kernel is invalid, even if the other kernel was measured', () => {
    const s = part(2, 1, 3);
    s.outs[0]!.set([1, 1, 1, NaN, 1, 1]);
    done(s, 3);
    expect(seriesOf(s, START, []).values).toEqual([1, null, 1]);
  });

  it('the base is the first window in which every kernel was measured', () => {
    const s = part(2, 1, 4);
    // w0: B missing. w1: A missing. w2: both (this is the base). w3: both, double.
    s.outs[0]!.set([1, NaN, NaN, 1, 2, 4, 4, 8]);
    done(s, 4);
    const r = seriesOf(s, START, []);
    expect(r.values).toEqual([null, null, 1, 2]);
    expect(r.base).toEqual([2 * A.work(s.part.kernels[0]!.size) * 1000, 4 * B.work(s.part.kernels[1]!.size) * 1000]);
  });

  it('a window overlapping a hidden period is invalid, listed in `hidden`, and never the base', () => {
    const s = part(1, 1, 4);
    s.outs[0]!.set([10, 5, 5, 20]);
    done(s, 4);
    const r = seriesOf(s, START, [[win(0) + 1_000, win(0) + 2_000]]); // inside window 0
    expect(r.hidden).toEqual([0]);
    expect(r.values).toEqual([null, 1, 1, 4]); // base = window 1 (5), not the hidden window 0 (10)
    expect(r.base[0]).toBe(5 * A.work(s.part.kernels[0]!.size) * 1000);
  });

  it('a hidden period spanning windows marks each of them; one still open (to = Infinity) marks the rest', () => {
    const s = part(1, 1, 6);
    s.outs[0]!.fill(1);
    done(s, 6);
    expect(seriesOf(s, START, [[win(1) + 10, win(3) + 10]]).hidden).toEqual([1, 2, 3]);
    expect(seriesOf(s, START, [[win(4) + 10, Infinity]]).hidden).toEqual([4, 5]);
    expect(seriesOf(s, START, [[win(1) + 10, win(1) + 20], [win(4) + 1, win(4) + 2]]).hidden).toEqual([1, 4]);
  });

  it('hidden periods touching a window only at its edge do not overlap it', () => {
    const s = part(1, 1, 3);
    s.outs[0]!.fill(1);
    done(s, 3);
    // Ends exactly where window 1 starts / starts exactly where window 1 ends.
    expect(seriesOf(s, START, [[win(0) + 5, win(1)]]).hidden).toEqual([0]);
    expect(seriesOf(s, START, [[win(2), win(2) + 7]]).hidden).toEqual([2]);
    // A period before the run's first window (the user hid the tab during the start delay) is not a window.
    expect(seriesOf(s, START, [[START - 2_000, START - 1_000]]).hidden).toEqual([]);
  });

  it('a hidden window also missing data is listed once and gives one null', () => {
    const s = part(1, 1, 3);
    s.outs[0]!.set([NaN, 1, 1]);
    done(s, 3);
    const r = seriesOf(s, START, [[win(0) + 1, win(0) + 2]]);
    expect(r.hidden).toEqual([0]);
    expect(r.values).toEqual([null, 1, 1]);
  });

  it('with nothing valid there is no base and nothing to plot', () => {
    const s = part(1, 1, 2);
    done(s, 2);
    const r = seriesOf(s, START, []);
    expect(r.values).toEqual([null, null]);
    expect(r.base).toEqual([null]);
    expect(dropOf(r.values)).toBeNull();
  });

  it('the window value is the geomean over kernels of rate / base', () => {
    const s = part(2, 1, 3);
    // window 0 (base): A 2, B 8. window 1: A 4 (x2), B 2 (x1/4). window 2: A 8 (x4), B 32 (x4).
    s.outs[0]!.set([2, 8, 4, 2, 8, 32]);
    done(s, 3);
    const v = seriesOf(s, START, []).values;
    expect(v[0]).toBe(1);
    expect(v[1]).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(v[2]).toBeCloseTo(4, 12);
  });

  it('the geomean weighs kernels equally: a kernel 10x faster and one 10x slower cancel out', () => {
    const s = part(2, 1, 2);
    s.outs[0]!.set([1, 1, 10, 0.1]);
    done(s, 2);
    expect(seriesOf(s, START, []).values[1]).toBeCloseTo(1, 12);
  });

  it('reads at most the finished windows even when the arrays are longer', () => {
    const s = part(1, 1, 10);
    s.outs[0]!.fill(1);
    done(s, 3);
    expect(seriesOf(s, START, []).values).toHaveLength(3);
  });
});

/** Gives a part its fastest-rep arrays (LoopRequest.best), one row per worker; slots not given stay NaN. */
function withBests(s: PartState, ...rows: number[][]): PartState {
  s.bests = s.outs.map((o, w) => {
    const b = new Float64Array(new SharedArrayBuffer(o.length * 8)).fill(NaN);
    b.set(rows[w] ?? []);
    return b;
  });
  return s;
}

describe('seriesOf: the fastest rep, not the mean', () => {
  it('the window rate is the fastest-rep rate (`bests`); the mean rate (`outs`) is not used for the series', () => {
    const s = part(1, 1, 3);
    s.outs[0]!.set([1, 1, 1]); // the mean says "flat" (a thread moved between cores)
    withBests(s, [2, 4, 1]);
    done(s, 3);
    expect(seriesOf(s, START, []).values).toEqual([1, 2, 0.5]);
  });

  it("a kernel's rate is the sum over workers of each worker's fastest rep", () => {
    const s = part(1, 2, 2);
    s.outs[0]!.set([9, 9]);
    s.outs[1]!.set([9, 9]);
    withBests(s, [1, 3], [3, 5]); // sums: 4, 8
    done(s, 2, 2);
    expect(seriesOf(s, START, []).values).toEqual([1, 2]);
  });

  it('"at the start" (base) is the MEAN rate of the first valid window, in units per second: the work really done', () => {
    const s = part(2, 1, 2);
    s.outs[0]!.set([0.5, 3, 0.25, 6]);
    withBests(s, [1, 6, 0.5, 12]); // fastest reps are 2x the means
    done(s, 2);
    const k = s.part.kernels;
    const r = seriesOf(s, START, []);
    expect(r.base).toEqual([0.5 * A.work(k[0]!.size) * 1000, 3 * B.work(k[1]!.size) * 1000]);
    expect(r.values).toEqual([1, 1]); // A halves, B doubles: the geomean stays 1
  });

  it('with no `bests` the series falls back to the mean rates (a part that predates the arrays)', () => {
    const s = part(1, 1, 2);
    s.outs[0]!.set([2, 1]);
    expect(s.bests).toBeUndefined();
    done(s, 2);
    expect(seriesOf(s, START, []).values).toEqual([1, 0.5]);
  });

  it('when the fastest rep reads 0 ms the worker stores the mean in its place (best = mean): the series equals the mean series', () => {
    const s = part(1, 2, 3);
    s.outs[0]!.set([2, 1, 4]);
    s.outs[1]!.set([2, 3, 4]);
    withBests(s, [2, 1, 4], [2, 3, 4]); // best == mean everywhere
    done(s, 3, 3);
    const fast = seriesOf(s, START, []);
    s.bests = undefined;
    expect(seriesOf(s, START, [])).toEqual(fast);
    expect(fast.values).toEqual([1, 1, 2]);
  });

  it('a slice a worker missed (NaN in both arrays) makes the window invalid, even if its peers measured it', () => {
    const s = part(1, 2, 3);
    s.outs[0]!.set([1, 1, 1]);
    s.outs[1]!.set([1, NaN, 1]);
    withBests(s, [1, 1, 1], [1, NaN, 1]);
    done(s, 3, 3);
    // the NaN poisons the sum, so the window is invalid: a missed slice is never read as "slower"
    expect(seriesOf(s, START, []).values).toEqual([1, null, 1]);
  });

  it('a window with a fastest rate of 0 (every worker) is invalid; the base is the first positive window', () => {
    const s = part(1, 1, 3);
    s.outs[0]!.set([1, 1, 1]);
    withBests(s, [0, 2, 4]);
    done(s, 3);
    expect(seriesOf(s, START, []).values).toEqual([null, 1, 2]);
  });
});

describe('seriesOf: unfocused periods', () => {
  it('a window overlapping an unfocused period is invalid, listed in `unfocused` (not in `hidden`), and never the base', () => {
    const s = part(1, 1, 4);
    s.outs[0]!.set([10, 5, 5, 20]);
    done(s, 4);
    const r = seriesOf(s, START, [], [[win(0) + 1_000, win(0) + 2_000]]);
    expect(r.unfocused).toEqual([0]);
    expect(r.hidden).toEqual([]);
    expect(r.values).toEqual([null, 1, 1, 4]); // base = window 1 (5)
    expect(r.base[0]).toBe(5 * A.work(s.part.kernels[0]!.size) * 1000);
  });

  it('a period spanning windows marks each; one still open (to = Infinity) marks the rest', () => {
    const s = part(1, 1, 6);
    s.outs[0]!.fill(1);
    done(s, 6);
    expect(seriesOf(s, START, [], [[win(1) + 10, win(3) + 10]]).unfocused).toEqual([1, 2, 3]);
    expect(seriesOf(s, START, [], [[win(4) + 10, Infinity]]).unfocused).toEqual([4, 5]);
    expect(seriesOf(s, START, [], [[win(1) + 10, win(1) + 20], [win(4) + 1, win(4) + 2]]).unfocused).toEqual([1, 4]);
  });

  it('periods touching a window only at its edge do not overlap it; one before the first window is not a window', () => {
    const s = part(1, 1, 3);
    s.outs[0]!.fill(1);
    done(s, 3);
    expect(seriesOf(s, START, [], [[win(0) + 5, win(1)]]).unfocused).toEqual([0]);
    expect(seriesOf(s, START, [], [[win(2), win(2) + 7]]).unfocused).toEqual([2]);
    expect(seriesOf(s, START, [], [[START - 2_000, START - 1_000]]).unfocused).toEqual([]);
  });

  it("hidden and unfocused over the same window: listed in both, one null, and neither list loses the other's windows", () => {
    const s = part(1, 1, 4);
    s.outs[0]!.fill(1);
    done(s, 4);
    const r = seriesOf(s, START, [[win(1) + 1, win(1) + 2]], [[win(1) + 3, win(2) + 1]]);
    expect(r.hidden).toEqual([1]);
    expect(r.unfocused).toEqual([1, 2]);
    expect(r.values).toEqual([1, null, null, 1]);
  });

  it('no unfocused periods given (older callers): nothing is unfocused', () => {
    const s = part(1, 1, 2);
    s.outs[0]!.fill(1);
    done(s, 2);
    expect(seriesOf(s, START, []).unfocused).toEqual([]);
  });
});

describe('seriesOf: the live cache keeps windows that can no longer change', () => {
  const fresh = (): SeriesCache => ({ values: [], hidden: [], unfocused: [] });

  it('a window is cached once it ended more than 2 s ago; the one still settling is recomputed', () => {
    const s = part(1, 1, 4);
    s.outs[0]!.set([1, 2, 4, 8]);
    done(s, 3);
    const cache = fresh();
    seriesOf(s, START, [], [], cache, win(0) + 1); // window 0 has not even ended
    expect(cache.values).toEqual([]);
    seriesOf(s, START, [], [], cache, win(0) + WINDOW_MS + 1_999); // ended 1.999 s ago
    expect(cache.values).toEqual([]);
    seriesOf(s, START, [], [], cache, win(0) + WINDOW_MS + 2_000);
    expect(cache.values).toEqual([1]);
    expect(cache.base).toBeDefined();
    seriesOf(s, START, [], [], cache, win(2) + WINDOW_MS + 2_000); // windows 0..2 are all old now
    expect(cache.values).toEqual([1, 2, 4]);
  });

  it('a cached window is not read again; a window still settling follows a period that arrives late', () => {
    const s = part(1, 1, 4);
    s.outs[0]!.set([1, 1, 1, 1]);
    done(s, 3);
    const cache = fresh();
    const now = win(0) + WINDOW_MS + 2_000; // only window 0 is settled
    const first = seriesOf(s, START, [], [], cache, now);
    expect(first.values).toEqual([1, 1, 1]);
    s.outs[0]!.set([99, 1, 1, 1]); // would change window 0 and the base if it were read again
    const late: [number, number][] = [[win(1) + 1, win(1) + 2]]; // an unfocused period reported late, for window 1
    const second = seriesOf(s, START, [], late, cache, now);
    expect(second.values).toEqual([1, null, 1]);
    expect(second.unfocused).toEqual([1]);
  });

  it('with a cache the result equals the one without, at every step of a growing run', () => {
    const s = part(2, 2, 8);
    for (const o of s.outs) o.set([1, 2, 1.5, 2.5, 0.8, 1.6, NaN, 2, 1, 2, 1, 2, 0.5, 1, 1, 2]);
    const cache = fresh();
    const periods: [number, number][] = [[win(2) + 100, win(2) + 200]];
    for (let w = 1; w <= 8; w++) {
      done(s, w, w);
      const now = win(w) + 10_000;
      expect(seriesOf(s, START, [], periods, cache, now)).toEqual(seriesOf(s, START, [], periods, undefined, now));
    }
  });
});

describe('missedOf: slices each worker skipped', () => {
  it("reads each worker's MISSED slot", () => {
    const s = part(1, 3, 2);
    Atomics.store(s.controls[0]!, LOOP.MISSED, 0);
    Atomics.store(s.controls[1]!, LOOP.MISSED, 4);
    Atomics.store(s.controls[2]!, LOOP.MISSED, 1);
    expect(missedOf(s)).toEqual([0, 4, 1]);
  });

  it('zeros, one per worker, for a part whose workers never started looping', () => {
    const s = part(1, 3, 2);
    s.controls = [];
    expect(missedOf(s)).toEqual([0, 0, 0]);
  });
});

describe('snapshot: the record shape the chart and the saved record are built from', () => {
  const loops = (parts: PartState[], hidden: [number, number][] = [], extra: Partial<LoopsView> = {}): LoopsView => ({
    parts,
    start: () => START,
    hidden,
    ...extra,
  });

  it("carries the plan, each part's keys, units, base, values, missed and figures, and the longest hidden list", () => {
    const a = part(2, 1, 5);
    a.outs[0]!.set([1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5]);
    done(a, 5);
    const b = part(1, 1, 5);
    b.part.id = 'memory';
    b.part.label = 'Memory — all-cores copy';
    b.part.workers = 4;
    b.outs[0]!.fill(2);
    done(b, 5);
    const rec = snapshot(loops([a, b], [[win(1) + 1, win(2) + 1]]), 25_000);
    expect(rec.durationMs).toBe(25_000);
    expect(rec.windowMs).toBe(WINDOW_MS);
    expect(rec.hidden).toEqual([1, 2]);
    expect(rec.unfocused).toEqual([]);
    expect(rec.notes).toBeUndefined();
    expect(rec.parts.map((p) => p.id)).toEqual(['cpu-multi', 'memory']);
    expect(rec.parts[0]!.keys).toEqual([defKey(A), defKey(B)]);
    expect(rec.parts[0]!.units).toEqual([A.unit, B.unit]);
    expect(rec.parts[1]!.workers).toBe(4);
    expect(rec.parts[0]!.values).toEqual([1, null, null, 0.5, 0.5]);
    // 5 windows: m = 1. minute 1 = [1], minute 2 = [null] (nothing valid), last = [0.5]
    expect(rec.parts[0]!.drop).toBeNull();
    expect(rec.parts[0]!.burst).toBeNull();
    expect(rec.parts[0]!.noisy).toBe(true); // minute 2 has no valid window
    // the hidden period is the tab's, so it blanks the same windows in every part
    expect(rec.parts[1]!.values).toEqual([1, null, null, 1, 1]);
    expect(rec.parts[1]).toMatchObject({ drop: null, burst: null, noisy: true });
    expect(rec.parts.map((p) => p.missed)).toEqual([[0], [0]]);
  });

  it('burst, drop and noisy are the figures of the series (drop.ts)', () => {
    const a = part(1, 1, 6);
    a.outs[0]!.set([1, 1, 0.8, 0.8, 0.5, 0.5]);
    done(a, 6);
    const p = snapshot(loops([a]), 30_000).parts[0]!;
    expect(p.values).toEqual([1, 1, 0.8, 0.8, 0.5, 0.5]);
    expect(p.burst).toBeCloseTo(0.2, 12);
    expect(p.drop).toBeCloseTo(1 - 0.5 / 0.8, 12);
    expect(p.noisy).toBe(false);
    expect({ burst: p.burst, drop: p.drop, noisy: p.noisy }).toEqual({
      burst: burstOf(p.values),
      drop: dropOf(p.values),
      noisy: noisyOf(p.values),
    });
  });

  it('missed slices: one entry per worker, read from the control slots', () => {
    const a = part(1, 3, 2);
    for (const o of a.outs) o.fill(1);
    done(a, 2, 2, 2);
    Atomics.store(a.controls[1]!, LOOP.MISSED, 7);
    expect(snapshot(loops([a]), 10_000).parts[0]!.missed).toEqual([0, 7, 0]);
  });

  it('a part that failed carries its error and NO figures (null, noisy false); a part with no windows has none either', () => {
    const a = part(1, 1, 6);
    a.outs[0]!.set([1, 1, 0.8, 0.8, 0.5, 0.5]);
    done(a, 6);
    a.error = 'worker init failed: nope';
    const rec = snapshot(loops([a]), 30_000);
    expect(rec.parts[0]).toMatchObject({ drop: null, burst: null, noisy: false, error: 'worker init failed: nope' });
    expect(rec.parts[0]!.values).toHaveLength(6); // the series itself is still reported
    const b = part(1, 1, 3);
    b.error = 'checksum mismatch in sha256: result invalid';
    const rb = snapshot(loops([b]), 15_000);
    expect(rb.parts[0]).toMatchObject({ values: [], drop: null, burst: null, noisy: false, error: b.error });
    expect(rb.hidden).toEqual([]);
    expect(rb.parts[0]!.missed).toEqual([0]);
  });

  it('unfocused windows: the longest list, each window null in the series', () => {
    const a = part(1, 1, 5);
    a.outs[0]!.fill(1);
    done(a, 5);
    const rec = snapshot(loops([a], [], { unfocused: [[win(2) + 5, win(3) + 5]], focusKnown: () => true }), 25_000);
    expect(rec.unfocused).toEqual([2, 3]);
    expect(rec.hidden).toEqual([]);
    expect(rec.parts[0]!.values).toEqual([1, 1, null, null, 1]);
    expect(rec.notes).toBeUndefined();
  });

  it('notes the page passes (e.g. a GPU that could not loop) are kept in order', () => {
    const a = part(1, 1, 2);
    const note = 'GPU: not looped, this browser offers neither WebGPU nor WebGL2.';
    expect(snapshot(loops([a]), 10_000, [note]).notes).toEqual([note]);
    expect(snapshot(loops([a]), 10_000, ['one', 'two']).notes).toEqual(['one', 'two']);
    expect(snapshot(loops([a]), 10_000, []).notes).toBeUndefined();
  });

  it('focus unknown (the window never had focus): nothing is invalidated and one note says so, after the page\'s notes', () => {
    const a = part(1, 1, 3);
    a.outs[0]!.fill(1);
    done(a, 3);
    const rec = snapshot(loops([a], [], { unfocused: [], focusKnown: () => false }), 15_000, ['GPU: not looped, x']);
    expect(rec.notes).toEqual(['GPU: not looped, x', FOCUS_UNKNOWN_NOTE]);
    expect(FOCUS_UNKNOWN_NOTE).toMatch(/focus unknown/i);
    expect(rec.unfocused).toEqual([]);
    expect(rec.parts[0]!.values).toEqual([1, 1, 1]);
    // focus known: no note
    expect(snapshot(loops([a], [], { focusKnown: () => true }), 15_000).notes).toBeUndefined();
    // focus tracking absent altogether (a view without it): no note either
    expect(snapshot(loops([a]), 15_000).notes).toBeUndefined();
  });

  it('a full Loops satisfies the view; live snapshots keep a cache on each part and agree with the final one', () => {
    const a = part(1, 1, 4);
    a.outs[0]!.set([1, 2, 3, 4]);
    done(a, 4);
    const l: Loops = {
      parts: [a],
      start: () => START,
      hidden: [],
      unfocused: [],
      focusKnown: () => true,
      checkFocus: () => {},
      done: Promise.resolve(),
      stop: async () => {},
      cancel: () => {},
    };
    const live = snapshot(l, 20_000, [], true);
    expect(a.cache).toBeDefined();
    expect(live).toEqual(snapshot(l, 20_000));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The focus tracker (startLoops): window blur / focus events, document.hasFocus() polling

/** A fake window / document: only what startLoops touches. */
function fakeFocus(initial: { focused: boolean; hidden?: boolean }) {
  const handlers = new Map<string, Set<() => void>>();
  const win = {
    addEventListener: vi.fn((t: string, f: () => void) => void (handlers.get(t) ?? handlers.set(t, new Set()).get(t)!).add(f)),
    removeEventListener: vi.fn((t: string, f: () => void) => void handlers.get(t)?.delete(f)),
  };
  const state = { focused: initial.focused };
  const doc = {
    hidden: initial.hidden ?? false,
    hasFocus: () => state.focused,
    defaultView: win,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('document', doc);
  return {
    state,
    win,
    doc,
    listeners: (t: string) => handlers.get(t)?.size ?? 0,
    /** The window loses or gains focus: the browser sets hasFocus() and fires the event. */
    set(focused: boolean) {
      state.focused = focused;
      for (const f of [...(handlers.get(focused ? 'focus' : 'blur') ?? [])]) f();
    },
  };
}

/** startLoops with one fake worker that never answers: the run stays "starting" until cancelled. */
function trackerRun() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onmessageerror: null, onerror: null };
  let release!: () => void;
  const gate = new Promise<WebAssembly.Module>((r) => (release = () => r({} as WebAssembly.Module)));
  const lp: LoopPart = { id: 'cpu-single', label: 'CPU — single core', kernels: [{ def: A, size: A.sizes.smoke, expected: A.expected.smoke }], workers: 1 };
  const l = startLoops({ parts: [lp], windows: 6, makeWorker: () => worker as never, loadModule: () => gate });
  l.done.catch(() => {});
  return { l, release, worker };
}

describe('focus tracking in startLoops', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('with focus at the start: a blur opens a period, a second blur does not stack another, a focus closes it', () => {
    const f = fakeFocus({ focused: true });
    const { l } = trackerRun();
    expect(l.focusKnown()).toBe(true);
    expect(l.unfocused).toEqual([]);
    const t0 = absNow();
    f.set(false);
    expect(l.unfocused).toHaveLength(1);
    expect(l.unfocused[0]![0]).toBeGreaterThanOrEqual(t0);
    expect(l.unfocused[0]![1]).toBe(Infinity);
    f.set(false); // blur again while still unfocused (the polling does this every second)
    expect(l.unfocused).toHaveLength(1);
    f.set(true);
    expect(l.unfocused).toHaveLength(1);
    expect(l.unfocused[0]![1]).toBeLessThanOrEqual(absNow());
    expect(l.unfocused[0]![1]).toBeGreaterThanOrEqual(l.unfocused[0]![0]);
    // a second loss is a second period
    f.set(false);
    expect(l.unfocused).toHaveLength(2);
    expect(l.unfocused[1]![1]).toBe(Infinity);
    l.cancel();
  });

  it('a focus event without a period open changes nothing', () => {
    const f = fakeFocus({ focused: true });
    const { l } = trackerRun();
    f.set(true);
    f.set(true);
    expect(l.unfocused).toEqual([]);
    l.cancel();
  });

  it('checkFocus() polls document.hasFocus(): a loss with no event (a missed blur) is found, and so is the return', () => {
    const f = fakeFocus({ focused: true });
    const { l } = trackerRun();
    l.checkFocus();
    expect(l.unfocused).toEqual([]);
    f.state.focused = false; // no blur event fired
    l.checkFocus();
    expect(l.unfocused).toHaveLength(1);
    expect(l.unfocused[0]![1]).toBe(Infinity);
    l.checkFocus(); // still unfocused: no second period
    expect(l.unfocused).toHaveLength(1);
    f.state.focused = true; // no focus event fired
    l.checkFocus();
    expect(l.unfocused).toHaveLength(1);
    expect(Number.isFinite(l.unfocused[0]![1])).toBe(true);
    l.cancel();
  });

  it('focus unknown: a window that never had focus invalidates nothing, blur events and polling included', () => {
    const f = fakeFocus({ focused: false });
    const { l } = trackerRun();
    expect(l.focusKnown()).toBe(false);
    f.set(false);
    l.checkFocus();
    l.checkFocus();
    expect(l.unfocused).toEqual([]);
    expect(l.focusKnown()).toBe(false);
    l.cancel();
  });

  it('focus unknown turns known at the first focus (event or poll); only the periods after it count', () => {
    const f = fakeFocus({ focused: false });
    const { l } = trackerRun();
    f.set(false);
    expect(l.unfocused).toEqual([]);
    f.set(true);
    expect(l.focusKnown()).toBe(true);
    f.set(false);
    expect(l.unfocused).toHaveLength(1);
    l.cancel();
    // by polling alone
    const g = fakeFocus({ focused: false });
    const r2 = trackerRun();
    g.state.focused = true;
    r2.l.checkFocus();
    expect(r2.l.focusKnown()).toBe(true);
    g.state.focused = false;
    r2.l.checkFocus();
    expect(r2.l.unfocused).toHaveLength(1);
    r2.l.cancel();
  });

  it('no document at all (a non-browser caller): no tracking, checkFocus() is harmless, focus is not known', () => {
    vi.stubGlobal('document', undefined);
    const { l } = trackerRun();
    expect(() => l.checkFocus()).not.toThrow();
    expect(l.unfocused).toEqual([]);
    expect(l.focusKnown()).toBe(false);
    l.cancel();
  });

  it('a document without hasFocus(): checkFocus() does nothing', () => {
    const f = fakeFocus({ focused: true });
    (f.doc as { hasFocus?: unknown }).hasFocus = undefined;
    const { l } = trackerRun();
    expect(() => l.checkFocus()).not.toThrow();
    expect(l.unfocused).toEqual([]);
    l.cancel();
  });

  it('listens on the window once for blur and focus, and stops listening when the run ends', async () => {
    const f = fakeFocus({ focused: true });
    const { l, release } = trackerRun();
    expect(f.listeners('blur')).toBe(1);
    expect(f.listeners('focus')).toBe(1);
    l.cancel(); // sets `cancelled`; the run notices once its module has loaded
    release();
    await expect(l.done).rejects.toBeInstanceOf(Cancelled);
    expect(f.listeners('blur')).toBe(0);
    expect(f.listeners('focus')).toBe(0);
    // events after the end are not recorded
    f.set(false);
    expect(l.unfocused).toEqual([]);
  });

  it('feeds the series: a period recorded by the tracker invalidates the windows it overlaps, and the snapshot has no focus note', () => {
    const f = fakeFocus({ focused: true });
    const { l } = trackerRun();
    const s = l.parts[0]!;
    s.outs = [new Float64Array(5).fill(1)];
    s.controls = [new Int32Array(new SharedArrayBuffer(LOOP.LENGTH * 4))];
    Atomics.store(s.controls[0]!, LOOP.DONE, 5);
    const start = absNow() - 5 * WINDOW_MS;
    f.set(false);
    l.unfocused[0]![0] = start + 2 * WINDOW_MS + 1; // the loss happened in window 2 ...
    f.set(true);
    l.unfocused[0]![1] = start + 3 * WINDOW_MS + 1; // ... and ended in window 3
    const rec = snapshot({ parts: l.parts, start: () => start, hidden: l.hidden, unfocused: l.unfocused, focusKnown: l.focusKnown }, 25_000);
    expect(rec.unfocused).toEqual([2, 3]);
    expect(rec.parts[0]!.values).toEqual([1, 1, null, null, 1]);
    expect(rec.notes).toBeUndefined();
    l.cancel();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The saved endurance block

const KEY_A = defKey(A);
const GPU_NOTE = 'GPU: not looped, this browser offers neither WebGPU nor WebGL2.';
/** A valid record body as JSON, with `edit` applied to the record's JSON. 12 windows (60 s); window 2 hidden, 7 unfocused. */
function enduranceJson(edit: (r: any) => void = () => {}): any {
  const r = JSON.parse(
    JSON.stringify(
      buildEnduranceRecord(
        {
          durationMs: 60_000,
          windowMs: 5_000,
          hidden: [2],
          unfocused: [7],
          notes: [GPU_NOTE],
          parts: [
            {
              id: 'cpu-single',
              label: 'CPU — single core',
              workers: 1,
              keys: [KEY_A, defKey(B)],
              units: [A.unit, B.unit],
              base: [123.456789, 98.7654321],
              values: [1, 1.0004, null, 0.98, 0.95, 0.9, 0.8, null, 0.7, 0.6, 0.55, 0.5],
              missed: [0],
            },
          ],
        },
        'smoke',
        SYSTEM,
      ),
    ),
  );
  edit(r);
  return r;
}
const file = (runs: unknown[]) => JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs });
const parse = (r: unknown) => parseExport(file([r]));
const ok = (r: unknown): RunRecord => {
  const p = parse(r);
  if ('error' in p) throw new Error(`expected a record, got: ${p.error}`);
  return p.runs[0]!;
};
const bad = (r: unknown): string => {
  const p = parse(r);
  if (!('error' in p)) throw new Error('expected an error');
  return p.error;
};
const NOT_VALID = /^Run 1 in the file is not valid/;
const series = (n: number) => Array.from({ length: n }, () => 1);
const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
/** The edit that gives the fixture room for `n` windows (a run of `n` x 5 s). */
const room = (n: number) => (r: any) => {
  r.endurance.durationMs = n * 5_000;
  r.endurance.parts[0].values = series(n);
};

describe('buildEnduranceRecord', () => {
  const build = (values: (number | null)[], base: (number | null)[] = [123456.789], extra: Record<string, unknown> = {}) =>
    buildEnduranceRecord(
      {
        durationMs: 30_000,
        windowMs: 5_000,
        hidden: [],
        parts: [{ id: 'cpu-single', label: 'CPU', workers: 1, keys: [KEY_A], units: [A.unit], base, values, ...extra }],
      },
      'smoke',
      SYSTEM,
    );

  it('is an Endurance record: mode "endurance", no components, no points, schema 1, never partial', () => {
    const r = build([1, 1, 0.9, 0.9, 0.8, 0.6]);
    expect(r).toMatchObject({ schema: 1, mode: 'endurance', size: 'smoke', components: [], total: null, partial: false });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.time).toISOString()).toBe(r.time);
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(1 - 0.7 / 0.9, 12); // sustained drop: minute 2 [.9, .9], last [.8, .6]
    expect(r.endurance!.parts[0]!.burst).toBeCloseTo(0.1, 12); // 1 - .9 / 1
    expect(r.endurance!.parts[0]!.noisy).toBe(true); // the last minute [.8, .6]: IQR 0.1 over median 0.7
  });

  it('a record with only 2 windows has no figures (fewer than 3 windows)', () => {
    const r = build([1, 0.9]);
    expect(r.endurance!.parts[0]).toMatchObject({ drop: null, burst: null, noisy: false });
    expect(r.partial).toBe(false);
  });

  it('rounds values to 4 and base to 6 significant digits, and maps non-finite numbers to null', () => {
    const r = build([1, 0.123456789, 1.00004, NaN, Infinity, null], [123456.789, null]);
    expect(r.endurance!.parts[0]!.values).toEqual([1, 0.1235, 1, null, null, null]);
    expect(r.endurance!.parts[0]!.base).toEqual([123457, null]);
  });

  it('computes every figure from the rounded series, never from figures passed in', () => {
    const r = build([1, 1, 0.8, 0.8, 0.5, 0.5]);
    const p = r.endurance!.parts[0]!;
    expect(p.drop).toBeCloseTo(1 - 0.5 / 0.8, 12);
    expect(p.burst).toBeCloseTo(0.2, 12);
    expect(p.noisy).toBe(false);
    const again = buildEnduranceRecord(
      { ...r.endurance!, parts: [{ ...p, drop: 0.99, burst: 0.99, noisy: true } as never] },
      'smoke',
      SYSTEM,
    );
    expect(again.endurance!.parts[0]).toMatchObject({ drop: p.drop, burst: p.burst, noisy: false });
  });

  it('a record with no valid windows has null figures, is noisy, and still validates', () => {
    const r = build(nulls(4));
    expect(r.endurance!.parts[0]).toMatchObject({ drop: null, burst: null, noisy: true });
    expect(cleanRecord(JSON.parse(JSON.stringify(r)))).toMatchObject({ mode: 'endurance' });
  });

  it('a part with an error has null figures and noisy false, however good its series was', () => {
    const r = build([1, 1, 0.8, 0.8, 0.5, 0.5], [1], { error: 'checksum mismatch in sha256: result invalid' });
    expect(r.endurance!.parts[0]).toMatchObject({ drop: null, burst: null, noisy: false, error: 'checksum mismatch in sha256: result invalid' });
    expect(cleanRecord(JSON.parse(JSON.stringify(r)))).toMatchObject({ mode: 'endurance' });
  });

  it('keeps unfocused indexes, notes and missed counts as given', () => {
    const r = buildEnduranceRecord(
      {
        durationMs: 30_000,
        windowMs: 5_000,
        hidden: [1],
        unfocused: [2, 3],
        notes: ['a', 'b'],
        parts: [{ id: 'cpu-multi', label: 'CPU', workers: 2, keys: [KEY_A], units: [A.unit], base: [1], values: [1, null, null, null, 1, 1], missed: [0, 3] }],
      },
      'smoke',
      SYSTEM,
    );
    expect(r.endurance).toMatchObject({ hidden: [1], unfocused: [2, 3], notes: ['a', 'b'] });
    expect(r.endurance!.parts[0]!.missed).toEqual([0, 3]);
  });
});

describe('an Endurance record survives export and import unchanged', () => {
  it('export -> import gives an equal record; exporting that again is byte-identical', () => {
    const r = ok(enduranceJson());
    const text = exportText([r]);
    const p = parseExport(text);
    expect('runs' in p && p.runs).toEqual([r]);
    expect(exportText((p as { runs: RunRecord[] }).runs)).toBe(text);
  });

  it("keeps the block's fields: plan, hidden and unfocused indexes, notes, keys, units, base, series, missed and figures", () => {
    const r = ok(enduranceJson());
    expect(r).toMatchObject({ mode: 'endurance', components: [], total: null, partial: false });
    const e = r.endurance!;
    expect(e).toMatchObject({ durationMs: 60_000, windowMs: 5_000, hidden: [2], unfocused: [7], notes: [GPU_NOTE] });
    expect(e.parts[0]).toMatchObject({ id: 'cpu-single', label: 'CPU — single core', workers: 1, keys: [KEY_A, defKey(B)], missed: [0] });
    expect(e.parts[0]!.base).toEqual([123.457, 98.7654]);
    expect(e.parts[0]!.values[2]).toBeNull();
    expect(e.parts[0]!.values[7]).toBeNull();
    expect(e.parts[0]!.values).toHaveLength(12);
    // m = 4: minute 2 = [.95, .9, .8, null] (median .9), last = [.7, .6, .55, .5] (median .575), first window 1
    expect(e.parts[0]!.burst).toBeCloseTo(0.1, 12);
    expect(e.parts[0]!.drop).toBeCloseTo(1 - 0.575 / 0.9, 12);
    expect(e.parts[0]!.noisy).toBe(true);
    expect(e.parts[0]!.drop).toBeCloseTo(dropOf(e.parts[0]!.values)!, 12);
  });

  it('reaches the saved history and back: save -> load', () => {
    const store = new FakeStore();
    const r = ok(enduranceJson());
    expect(saveHistory([r], store as never)).toBeUndefined();
    const loaded = loadHistory(store as never);
    expect(loaded.error).toBeUndefined();
    expect(loaded.runs).toEqual([r]);
  });

  it('older records without the block still load, and Endurance records sort and merge like any other', () => {
    const old = tinyRecord('old', at(0));
    expect(ok(old)).toMatchObject({ id: 'old', mode: 'quick' });
    expect(ok(old).endurance).toBeUndefined();
    const both = parseExport(file([old, enduranceJson((r) => ((r.id = 'e1'), (r.time = at(5))))]));
    expect('runs' in both && both.runs.map((x) => x.id)).toEqual(['old', 'e1']);
  });

  it('an M7 round-1 record (no unfocused, notes, missed, burst, noisy) still loads, and gets its figures filled in', () => {
    const r = ok(
      enduranceJson((x) => {
        delete x.endurance.unfocused;
        delete x.endurance.notes;
        delete x.endurance.parts[0].missed;
        delete x.endurance.parts[0].burst;
        delete x.endurance.parts[0].noisy;
        x.endurance.parts[0].drop = 0.99;
        x.endurance.hidden = [2];
      }),
    );
    const e = r.endurance!;
    expect(e.unfocused).toBeUndefined();
    expect(e.notes).toBeUndefined();
    expect(e.parts[0]!.missed).toBeUndefined();
    expect(e.parts[0]!.burst).toBeCloseTo(0.1, 12);
    expect(e.parts[0]!.noisy).toBe(true);
    expect(e.parts[0]!.drop).not.toBeCloseTo(0.99, 3);
  });

  it('an Endurance record is never partial and has no total, however it was saved', () => {
    const r = ok(enduranceJson((x) => ((x.partial = true), (x.total = 5))));
    expect(r.partial).toBe(false);
    expect(r.total).toBeNull();
    const store = new FakeStore();
    store.setItem(HISTORY_KEY, JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs: [enduranceJson((x) => ((x.partial = true), (x.total = 5)))] }));
    const loaded = loadHistory(store as never);
    expect(loaded.runs[0]).toMatchObject({ partial: false, total: null });
  });
});

describe('strict validation of the endurance block', () => {
  it('mode "endurance" if and only if the block is present', () => {
    expect(bad(enduranceJson((r) => delete r.endurance))).toMatch(NOT_VALID);
    expect(bad(enduranceJson((r) => (r.mode = 'quick')))).toMatch(NOT_VALID);
    expect(bad(enduranceJson((r) => (r.mode = 'full')))).toMatch(NOT_VALID);
    // A benchmark record with a block added.
    const quick: any = JSON.parse(JSON.stringify(tinyRecord('q', at(1))));
    quick.endurance = enduranceJson().endurance;
    expect(bad(quick)).toMatch(NOT_VALID);
  });

  it('an Endurance record has no components', () => {
    const q = JSON.parse(JSON.stringify(tinyRecord('q', at(1)))).components;
    expect(bad(enduranceJson((r) => (r.components = q)))).toMatch(/^Run 1/);
  });

  it.each([
    ['units shorter than keys', (p: any) => p.units.pop()],
    ['units longer than keys', (p: any) => p.units.push('x')],
    ['base shorter than keys', (p: any) => p.base.pop()],
    ['base longer than keys', (p: any) => p.base.push(1)],
    ['keys longer than units and base', (p: any) => p.keys.push('extra')],
    ['keys empty, units and base not', (p: any) => (p.keys = [])],
  ])('unequal list lengths are refused: %s', (_n, edit) => {
    expect(bad(enduranceJson((r) => edit(r.endurance.parts[0])))).toMatch(NOT_VALID);
  });

  it('a part with no kernels at all (all three lists empty) is fine', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance.parts[0], { keys: [], units: [], base: [] })));
    expect(r.endurance!.parts[0]!.keys).toEqual([]);
  });

  describe('windowMs is 5000', () => {
    it('5000 is accepted', () => expect(ok(enduranceJson()).endurance!.windowMs).toBe(5_000));
    it.each([0, 1_000, 4_999, 5_001, 10_000, -5_000, 5_000.5, '5000', null, true])('%j is refused', (w) => {
      expect(bad(enduranceJson((r) => (r.endurance.windowMs = w)))).toMatch(NOT_VALID);
    });
    it('a missing windowMs is refused', () => {
      expect(bad(enduranceJson((r) => delete r.endurance.windowMs))).toMatch(NOT_VALID);
    });
  });

  describe('a series holds at most ceil(durationMs / 5000) values, and at most 1000', () => {
    it('exactly as many values as windows is accepted; one more is refused', () => {
      expect(ok(enduranceJson()).endurance!.parts[0]!.values).toHaveLength(12);
      expect(bad(enduranceJson((r) => r.endurance.parts[0].values.push(1)))).toMatch(NOT_VALID);
    });

    it('a run that is not a whole number of windows rounds up: 56 s has 12 windows, 55 s has 11', () => {
      expect(ok(enduranceJson((r) => (r.endurance.durationMs = 56_000))).endurance!.parts[0]!.values).toHaveLength(12);
      expect(ok(enduranceJson((r) => (r.endurance.durationMs = 55_001))).endurance!.parts[0]!.values).toHaveLength(12);
      expect(bad(enduranceJson((r) => (r.endurance.durationMs = 55_000)))).toMatch(NOT_VALID);
      expect(bad(enduranceJson((r) => (r.endurance.durationMs = 5_000)))).toMatch(NOT_VALID);
    });

    it(`${MAX_WINDOWS} is accepted (a 60-minute run has 720), ${MAX_WINDOWS + 1} is refused, 50,000 is refused`, () => {
      expect(ok(enduranceJson(room(MAX_WINDOWS))).endurance!.parts[0]!.values).toHaveLength(MAX_WINDOWS);
      expect(bad(enduranceJson(room(MAX_WINDOWS + 1)))).toMatch(/^Run 1/);
      expect(bad(enduranceJson(room(50_000)))).toMatch(/^Run 1/);
    });

    it('a duration of more than 1000 windows is refused even with a short series', () => {
      expect(ok(enduranceJson((r) => (r.endurance.durationMs = 5_000_000))).endurance!.durationMs).toBe(5_000_000);
      expect(bad(enduranceJson((r) => (r.endurance.durationMs = 5_000_001)))).toMatch(NOT_VALID);
      expect(bad(enduranceJson((r) => (r.endurance.durationMs = 43_200_000)))).toMatch(NOT_VALID); // a 12 h Stress cap
    });

    it('the limit is per part: the longest series sets the bound, a shorter part is fine', () => {
      const r = ok(
        enduranceJson((x) => {
          const second = JSON.parse(JSON.stringify(x.endurance.parts[0]));
          Object.assign(second, { id: 'memory', values: [1, 1, 1], missed: [0] });
          x.endurance.parts.push(second);
        }),
      );
      expect(r.endurance!.parts.map((p) => p.values.length)).toEqual([12, 3]);
    });
  });

  describe('hidden and unfocused indexes: whole numbers, unique, below the longest series', () => {
    it.each(['hidden', 'unfocused'] as const)('%s: every window of the series may be listed; an index past the end is refused', (k) => {
      expect(ok(enduranceJson((r) => (r.endurance[k] = idx(12)))).endurance![k]).toEqual(idx(12));
      expect(bad(enduranceJson((r) => (r.endurance[k] = [12])))).toMatch(NOT_VALID);
      expect(bad(enduranceJson((r) => (r.endurance[k] = [0, 1, 999])))).toMatch(NOT_VALID);
    });

    it.each(['hidden', 'unfocused'] as const)('%s: a duplicate index is refused', (k) => {
      expect(bad(enduranceJson((r) => (r.endurance[k] = [3, 3])))).toMatch(NOT_VALID);
      expect(bad(enduranceJson((r) => (r.endurance[k] = [1, 2, 1])))).toMatch(NOT_VALID);
      expect(ok(enduranceJson((r) => (r.endurance[k] = [3, 4]))).endurance![k]).toEqual([3, 4]);
    });

    it.each(['hidden', 'unfocused'] as const)('%s: negative, fractional and non-numeric indexes, or not a list, are refused', (k) => {
      for (const bad_ of [[-1], [1.5], ['1'], [null], 3, 'abc', {}]) {
        expect(bad(enduranceJson((r) => (r.endurance[k] = bad_))), JSON.stringify(bad_)).toMatch(NOT_VALID);
      }
    });

    it.each(['hidden', 'unfocused'] as const)('%s: bounded by the longest series of any part, not by the first', (k) => {
      const two = (x: any) => {
        x.endurance.parts[0].values = [1, 1, 1];
        const second = JSON.parse(JSON.stringify(x.endurance.parts[0]));
        Object.assign(second, { id: 'memory', values: [1, 1, 1, 1, 1, 1, 1], missed: [0] });
        x.endurance.parts.push(second);
        x.endurance.hidden = [];
        x.endurance.unfocused = [];
      };
      expect(ok(enduranceJson((x) => (two(x), (x.endurance[k] = [6])))).endurance![k]).toEqual([6]);
      expect(bad(enduranceJson((x) => (two(x), (x.endurance[k] = [7]))))).toMatch(NOT_VALID);
    });

    it(`${MAX_WINDOWS} of each are accepted on a ${MAX_WINDOWS}-window series, ${MAX_WINDOWS + 1} are refused`, () => {
      const full = (r: any) => (room(MAX_WINDOWS)(r), (r.endurance.hidden = idx(MAX_WINDOWS)), (r.endurance.unfocused = idx(MAX_WINDOWS)));
      const r = ok(enduranceJson(full));
      expect(r.endurance!.hidden).toHaveLength(MAX_WINDOWS);
      expect(r.endurance!.unfocused).toHaveLength(MAX_WINDOWS);
      expect(bad(enduranceJson((x) => (full(x), (x.endurance.hidden = idx(MAX_WINDOWS + 1)))))).toMatch(/^Run 1/);
      expect(bad(enduranceJson((x) => (full(x), (x.endurance.unfocused = idx(MAX_WINDOWS + 1)))))).toMatch(/^Run 1/);
    });

    it('unfocused may be absent (older records), hidden may not', () => {
      expect(ok(enduranceJson((r) => delete r.endurance.unfocused)).endurance!.unfocused).toBeUndefined();
      expect(bad(enduranceJson((r) => delete r.endurance.hidden))).toMatch(NOT_VALID);
    });
  });

  describe('missed: one entry per worker', () => {
    const withWorkers = (workers: number, missed: unknown) => (r: any) => Object.assign(r.endurance.parts[0], { workers, missed });

    it('as many entries as workers is accepted', () => {
      expect(ok(enduranceJson(withWorkers(1, [0]))).endurance!.parts[0]!.missed).toEqual([0]);
      expect(ok(enduranceJson(withWorkers(3, [0, 12, 1]))).endurance!.parts[0]!.missed).toEqual([0, 12, 1]);
    });

    it.each([
      ['fewer entries than workers', 3, [0, 1]],
      ['more entries than workers', 1, [0, 1]],
      ['an empty list', 1, []],
      ['a negative count', 1, [-1]],
      ['a fractional count', 1, [1.5]],
      ['a string count', 1, ['2']],
      ['null', 1, [null]],
      ['not a list', 1, 0],
    ])('refused: %s', (_n, workers, missed) => {
      expect(bad(enduranceJson(withWorkers(workers, missed)))).toMatch(NOT_VALID);
    });

    it('may be absent (records saved before it existed)', () => {
      expect(ok(enduranceJson((r) => delete r.endurance.parts[0].missed)).endurance!.parts[0]!.missed).toBeUndefined();
    });
  });

  describe('notes: a list of strings, at most 20', () => {
    it('20 are accepted (an empty list and none at all too); 21 are refused', () => {
      const n = (k: number) => Array.from({ length: k }, (_, i) => `note ${i}`);
      expect(ok(enduranceJson((r) => (r.endurance.notes = n(20)))).endurance!.notes).toHaveLength(20);
      expect(bad(enduranceJson((r) => (r.endurance.notes = n(21))))).toMatch(NOT_VALID);
      expect(ok(enduranceJson((r) => (r.endurance.notes = []))).endurance!.notes).toEqual([]);
      expect(ok(enduranceJson((r) => delete r.endurance.notes)).endurance!.notes).toBeUndefined();
    });

    it.each([[[1]], [[null]], ['a note'], [{}], [[['x']]]])('%j is refused', (v) => {
      expect(bad(enduranceJson((r) => (r.endurance.notes = v)))).toMatch(NOT_VALID);
    });
  });

  describe('part ids are unique', () => {
    it('two parts with the same id are refused; two different parts are fine', () => {
      const copy = (id: string) => (x: any) => {
        const second = JSON.parse(JSON.stringify(x.endurance.parts[0]));
        second.id = id;
        x.endurance.parts.push(second);
      };
      expect(bad(enduranceJson(copy('cpu-single')))).toMatch(NOT_VALID);
      expect(ok(enduranceJson(copy('cpu-multi'))).endurance!.parts.map((p) => p.id)).toEqual(['cpu-single', 'cpu-multi']);
    });
  });

  it.each([
    ['a negative value', (p: any) => (p.values[3] = -0.01)],
    ['a negative base', (p: any) => (p.base[0] = -1)],
    ['a string value', (p: any) => (p.values[3] = '0.9')],
    ['a boolean value', (p: any) => (p.values[3] = true)],
    ['an object value', (p: any) => (p.values[3] = {})],
    ['a string base', (p: any) => (p.base[1] = '1')],
    ['a non-array series', (p: any) => (p.values = 'abc')],
    ['a missing series', (p: any) => delete p.values],
    ['a missing base', (p: any) => delete p.base],
    ['a missing keys list', (p: any) => delete p.keys],
    ['a non-string key', (p: any) => (p.keys[0] = 3)],
    ['a missing label', (p: any) => delete p.label],
    ['an unknown component id', (p: any) => (p.id = 'fridge')],
    ['zero workers', (p: any) => (p.workers = 0)],
    ['fractional workers', (p: any) => (p.workers = 1.5)],
    ['a string drop', (p: any) => (p.drop = '0.1')],
    ['a string burst', (p: any) => (p.burst = '0.1')],
    ['a non-boolean noisy', (p: any) => (p.noisy = 1)],
    ['a non-string error', (p: any) => (p.error = 5)],
  ])('a part with %s is refused', (_n, edit) => {
    expect(bad(enduranceJson((r) => edit(r.endurance.parts[0])))).toMatch(NOT_VALID);
  });

  it('values of 0 and null are accepted (0 = not faster than nothing, null = invalid window)', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance, { hidden: [2], unfocused: [], parts: [Object.assign(x.endurance.parts[0], { values: [1, 0, null, 0.5] })] })));
    expect(r.endurance!.parts[0]!.values).toEqual([1, 0, null, 0.5]);
  });

  it.each([
    ['durationMs 0', (e: any) => (e.durationMs = 0)],
    ['durationMs negative', (e: any) => (e.durationMs = -5)],
    ['durationMs fractional', (e: any) => (e.durationMs = 1.5)],
    ['durationMs a string', (e: any) => (e.durationMs = '60000')],
    ['parts not a list', (e: any) => (e.parts = {})],
    ['parts missing', (e: any) => delete e.parts],
    ['the block is null', (_e: any) => {}],
  ])('a block with %s is refused', (n, edit) => {
    const run = enduranceJson((r) => (n === 'the block is null' ? (r.endurance = null) : edit(r.endurance)));
    expect(bad(run)).toMatch(NOT_VALID);
  });

  it('an empty list of parts is accepted when there is nothing to index (a run with nothing to show is still a valid file)', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance, { parts: [], hidden: [], unfocused: [] })));
    expect(r.endurance!.parts).toEqual([]);
    // ... but an index into a series that does not exist is not
    expect(bad(enduranceJson((x) => Object.assign(x.endurance, { parts: [], hidden: [2], unfocused: [] })))).toMatch(NOT_VALID);
  });

  it('one bad Endurance record refuses the whole file, and says which run', () => {
    const good = enduranceJson((r) => ((r.id = 'good'), (r.time = at(1))));
    const broken = enduranceJson((r) => ((r.id = 'broken'), (r.endurance.parts[0].values[0] = -1)));
    const p = parseExport(file([good, broken]));
    expect('error' in p && p.error).toMatch(/^Run 2 in the file is not valid/);
  });
});

describe('saved figures are never trusted', () => {
  const values = () => enduranceJson().endurance.parts[0].values as (number | null)[];

  it.each([0.99, -4, 0, null, 1e9])('a saved drop of %j is recomputed on import', (d) => {
    const r = ok(enduranceJson((x) => (x.endurance.parts[0].drop = d)));
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(dropOf(values())!, 12);
  });

  it.each([0.99, -4, 0, null, 1e9])('a saved burst of %j is recomputed on import', (b) => {
    const r = ok(enduranceJson((x) => (x.endurance.parts[0].burst = b)));
    expect(r.endurance!.parts[0]!.burst).toBeCloseTo(burstOf(values())!, 12);
  });

  it.each([true, false])('a saved noisy of %j is recomputed on import', (n) => {
    const r = ok(enduranceJson((x) => (x.endurance.parts[0].noisy = n)));
    expect(r.endurance!.parts[0]!.noisy).toBe(noisyOf(values()));
  });

  it('missing figures are filled in', () => {
    const r = ok(
      enduranceJson((x) => {
        delete x.endurance.parts[0].drop;
        delete x.endurance.parts[0].burst;
        delete x.endurance.parts[0].noisy;
      }),
    );
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(dropOf(values())!, 12);
    expect(r.endurance!.parts[0]!.burst).not.toBeNull();
    expect(r.endurance!.parts[0]!.noisy).toBe(true);
  });

  it('a part with an error has null figures on import, whatever was saved', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance.parts[0], { error: 'worker init failed: nope', drop: 0.5, burst: 0.4, noisy: true })));
    expect(r.endurance!.parts[0]).toMatchObject({ drop: null, burst: null, noisy: false, error: 'worker init failed: nope' });
  });

  it('a series with nothing valid in minute 2 gives null figures even if forged ones were saved', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance, { unfocused: [], parts: [Object.assign(x.endurance.parts[0], { values: [1, null, null], drop: 0.5, burst: 0.5 })] })));
    expect(r.endurance!.parts[0]).toMatchObject({ drop: null, burst: null });
  });

  it('is recomputed when the saved history is loaded', () => {
    const forged = enduranceJson((x) => Object.assign(x.endurance.parts[0], { drop: 0.99, burst: 0.99, noisy: false }));
    const store = new FakeStore();
    store.setItem(HISTORY_KEY, JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs: [forged] }));
    const loaded = loadHistory(store as never);
    expect(loaded.error).toBeUndefined();
    const p = loaded.runs[0]!.endurance!.parts[0]!;
    expect(p.drop).toBeCloseTo(dropOf(values())!, 12);
    expect(p.drop).not.toBeCloseTo(0.99, 3);
    expect(p.burst).toBeCloseTo(0.1, 12);
    expect(p.noisy).toBe(true);
  });

  it('every part gets its own recomputed figures', () => {
    const r = ok(
      enduranceJson((x) => {
        const second = JSON.parse(JSON.stringify(x.endurance.parts[0]));
        Object.assign(second, { id: 'memory', values: [1, 1, 1, 1], drop: 0.7 });
        x.endurance.parts.push(second);
      }),
    );
    expect(r.endurance!.parts[1]).toMatchObject({ drop: 0, burst: 0, noisy: false });
    expect(r.endurance!.parts[0]!.drop).not.toBe(0);
  });
});

describe('unknown keys are dropped from the endurance block', () => {
  it('in the block, in each part, and in the record', () => {
    const r = ok(
      enduranceJson((x) => {
        x.endurance.junk = 1;
        x.endurance.parts[0].extra = { a: 1 };
        x.junkTop = 'x';
      }),
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain('junk');
    expect(text).not.toContain('extra');
    expect(Object.keys(r.endurance!)).toEqual(['durationMs', 'windowMs', 'hidden', 'unfocused', 'notes', 'parts']);
  });

  it('an own "__proto__" key in the block or a part is neither kept nor applied', () => {
    const text = JSON.stringify(enduranceJson()).replace(
      '"endurance":{',
      '"endurance":{"__proto__":{"polluted":true},',
    );
    const p = parseExport(file([]).replace('"runs":[]', `"runs":[${text}]`));
    const r = 'runs' in p ? p.runs[0]! : undefined;
    expect(r).toBeDefined();
    expect(Object.hasOwn(r!.endurance!, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('polluted');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wake Lock

interface Sentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}
/** A fake `document` (hidden flag + visibilitychange listeners) and a fake `navigator.wakeLock`. */
function fakes(opts: { supported?: boolean; hidden?: boolean; deny?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: opts.hidden ?? false,
    addEventListener: vi.fn((t: string, f: () => void) => t === 'visibilitychange' && listeners.add(f)),
    removeEventListener: vi.fn((t: string, f: () => void) => t === 'visibilitychange' && listeners.delete(f)),
  };
  const sentinels: Sentinel[] = [];
  const request = vi.fn(async (type: string) => {
    expect(type).toBe('screen');
    if (opts.deny) throw new DOMException('denied', 'NotAllowedError');
    const s: Sentinel = {
      released: false,
      release: vi.fn(async () => {
        s.released = true;
      }),
    };
    sentinels.push(s);
    return s;
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', opts.supported === false ? {} : { wakeLock: { request } });
  return {
    doc,
    sentinels,
    request,
    listeners,
    /** The tab changes visibility and the browser tells the page. */
    setHidden(h: boolean) {
      doc.hidden = h;
      for (const f of [...listeners]) f();
    },
  };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const states = () => {
  const seen: WakeState[] = [];
  return { seen, on: (s: WakeState) => void seen.push(s) };
};

describe('holdWakeLock', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('unsupported: says so at once, the run goes on, and releasing is harmless', () => {
    const f = fakes({ supported: false });
    const s = states();
    const release = holdWakeLock(s.on);
    expect(s.seen).toEqual(['unsupported']);
    expect(f.doc.addEventListener).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  it('requests a screen lock at the start and reports "on"', async () => {
    const f = fakes();
    const s = states();
    holdWakeLock(s.on);
    expect(f.request).toHaveBeenCalledTimes(1);
    await flush();
    expect(s.seen).toEqual(['on']);
    expect(f.sentinels).toHaveLength(1);
  });

  it('release: releases the lock and stops listening', async () => {
    const f = fakes();
    const s = states();
    const release = holdWakeLock(s.on);
    await flush();
    release();
    expect(f.sentinels[0]!.release).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    // Visibility changes after the end request nothing.
    f.sentinels[0]!.released = true;
    f.setHidden(true);
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(s.seen).toEqual(['on']);
  });

  it('re-acquires when the tab becomes visible again after the browser released the lock', async () => {
    const f = fakes();
    const s = states();
    holdWakeLock(s.on);
    await flush();
    // The browser releases the lock when the tab is hidden.
    f.setHidden(true);
    f.sentinels[0]!.released = true;
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1); // not while hidden
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.sentinels).toHaveLength(2);
    expect(s.seen).toEqual(['on', 'on']);
  });

  it('does not request again while it still holds a lock', async () => {
    const f = fakes();
    holdWakeLock(() => {});
    await flush();
    f.setHidden(true);
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('starting hidden: no request until the tab is visible', async () => {
    const f = fakes({ hidden: true });
    const s = states();
    holdWakeLock(s.on);
    await flush();
    expect(f.request).not.toHaveBeenCalled();
    expect(s.seen).toEqual([]);
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(s.seen).toEqual(['on']);
  });

  it('refused: reports "refused", does not throw, and tries again when the tab returns', async () => {
    const f = fakes({ deny: true });
    const s = states();
    const release = holdWakeLock(s.on);
    await flush();
    expect(s.seen).toEqual(['refused']);
    f.setHidden(true);
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(s.seen).toEqual(['refused', 'refused']);
    expect(() => release()).not.toThrow();
  });

  it('released before the request resolves: the late lock is released at once and "on" is never reported', async () => {
    const f = fakes();
    const s = states();
    const release = holdWakeLock(s.on);
    release(); // the request is still pending
    await flush();
    expect(f.sentinels).toHaveLength(1);
    expect(f.sentinels[0]!.release).toHaveBeenCalledTimes(1);
    expect(s.seen).toEqual([]);
  });

  it('release() twice is harmless', async () => {
    const f = fakes();
    const release = holdWakeLock(() => {});
    await flush();
    release();
    expect(() => release()).not.toThrow();
    expect(f.sentinels[0]!.release.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('a lock that fails to release does not surface as an error', async () => {
    const f = fakes();
    const unhandled: unknown[] = [];
    const on = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const release = holdWakeLock(() => {});
      await flush();
      f.sentinels[0]!.release.mockRejectedValueOnce(new DOMException('gone', 'InvalidStateError'));
      release();
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', on);
    }
    expect(unhandled).toEqual([]);
  });

  // The two former `it.fails` (bugs fixed in round 1): the in-flight guard and the catch on the late release.
  it('a request still in flight when the tab turns visible again does not take a second lock (the in-flight guard)', async () => {
    const f = fakes();
    const release = holdWakeLock(() => {});
    expect(f.request).toHaveBeenCalledTimes(1);
    f.setHidden(false); // visibilitychange before the first request resolved
    f.setHidden(false);
    expect(f.request).toHaveBeenCalledTimes(1); // still one request in flight
    await flush();
    expect(f.sentinels).toHaveLength(1);
    release();
    await flush();
    expect(f.sentinels.filter((s) => !s.released)).toEqual([]); // nothing left holding the screen
  });

  it('after the in-flight request settles, a later visibility change may request again', async () => {
    const f = fakes();
    holdWakeLock(() => {});
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.sentinels[0]!.released = true; // the browser took it back
    f.setHidden(true);
    f.setHidden(false);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('a refused request frees the in-flight guard too (the next visibility change asks again)', async () => {
    const f = fakes({ deny: true });
    const s = states();
    holdWakeLock(s.on);
    f.setHidden(false); // in flight: ignored
    expect(f.request).toHaveBeenCalledTimes(1);
    await flush();
    f.setHidden(false);
    expect(f.request).toHaveBeenCalledTimes(2);
    await flush();
    expect(s.seen).toEqual(['refused', 'refused']);
  });

  it('a late lock whose release() rejects does not cause an unhandled rejection', async () => {
    const f = fakes();
    const unhandled: unknown[] = [];
    const on = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', on);
    f.request.mockImplementationOnce(async () => ({ released: false, release: () => Promise.reject(new Error('gone')) }) as never);
    try {
      holdWakeLock(() => {})(); // released before the request resolves
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', on);
    }
    expect(unhandled).toEqual([]);
  });
});
