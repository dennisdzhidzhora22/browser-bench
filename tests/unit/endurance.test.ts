// M7 (docs/SPEC.md, section 4, "How it works (M7)"): the drop formula, the window series, the strict validation of
// the saved `endurance` block, the record built from a run, and the Wake Lock helper. Fake shared arrays and a fake
// navigator.wakeLock; no workers, no clocks. Nothing here asserts on speed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { defKey, type KernelDef } from '../../src/lib/bench/types.ts';
import { dropOf, MINUTE, WINDOW_MS } from '../../src/lib/harness/drop.ts';
import { seriesOf, snapshot, type LoopPart, type Loops, type PartState } from '../../src/lib/harness/endurance.ts';
import { LOOP } from '../../src/lib/harness/protocol.ts';
import { holdWakeLock, type WakeState } from '../../src/lib/harness/wakelock.ts';
import { exportText } from '../../src/lib/store/export.ts';
import { loadHistory, HISTORY_KEY, saveHistory } from '../../src/lib/store/history.ts';
import { parseExport } from '../../src/lib/store/import.ts';
import { buildEnduranceRecord } from '../../src/lib/store/record.ts';
import { cleanRecord, MAX_WINDOWS, SCHEMA, type RunRecord } from '../../src/lib/store/schema.ts';
import { at, FakeStore, SYSTEM, tinyRecord } from './store-support.ts';

const nulls = (n: number) => Array<number | null>(n).fill(null);

describe('dropOf: 1 - mean(last n valid) / mean(first n valid), n = min(12, floor(valid / 2))', () => {
  it('is 12 windows, one minute', () => expect(MINUTE).toBe(12));

  it('has no drop with 0 or 1 valid windows', () => {
    expect(dropOf([])).toBeNull();
    expect(dropOf([1])).toBeNull();
    expect(dropOf([null])).toBeNull();
    expect(dropOf([null, 0.7, null])).toBeNull();
  });

  it('has no drop when every window is invalid, however many there are', () => {
    expect(dropOf(nulls(5))).toBeNull();
    expect(dropOf(nulls(MAX_WINDOWS))).toBeNull();
  });

  it('compares first with last at 2 valid windows', () => {
    expect(dropOf([1, 0.5])).toBeCloseTo(0.5, 12);
    expect(dropOf([1, 1.25])).toBeCloseTo(-0.25, 12); // faster at the end: negative
  });

  it('skips invalid windows: they do not count toward n and are never averaged in', () => {
    expect(dropOf([null, 1, null, null, 0.8, null])).toBeCloseTo(0.2, 12);
    expect(dropOf([1, null, null, null, null, 0.5])).toBeCloseTo(0.5, 12);
  });

  it('3 valid windows: n = 1, the middle one is ignored', () => {
    expect(dropOf([1, 0.01, 0.9])).toBeCloseTo(0.1, 12);
    expect(dropOf([1, 99, 0.9])).toBeCloseTo(0.1, 12);
  });

  it('short runs compare halves: first n and last n never overlap', () => {
    expect(dropOf([1, 1, 0.5, 0.5])).toBeCloseTo(0.5, 12); // n = 2
    expect(dropOf([1, 1, 7, 0.5, 0.5])).toBeCloseTo(0.5, 12); // 5 valid: n = 2, the middle one ignored
    expect(dropOf([1, 1, 1, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 12); // n = 3
    expect(dropOf([4, 2, 2, 1])).toBeCloseTo(1 - 1.5 / 3, 12); // means (4+2)/2 = 3 and (2+1)/2 = 1.5
  });

  it('uses at most 12 windows from each end (n caps at one minute)', () => {
    // 24 valid windows: n = 12 = halves exactly.
    const v24 = [...Array(12).fill(1), ...Array(12).fill(0.5)] as number[];
    expect(dropOf(v24)).toBeCloseTo(0.5, 12);
    // 23 valid: n = 11.
    expect(dropOf([...Array(11).fill(1), 9, ...Array(11).fill(0.5)] as number[])).toBeCloseTo(0.5, 12);
    // 30 valid: n stays 12, so the 6 windows in the middle are ignored.
    const v30 = [...Array(12).fill(1), ...Array(6).fill(1000), ...Array(12).fill(0.8)] as number[];
    expect(dropOf(v30)).toBeCloseTo(0.2, 12);
    // 720 windows (60 min): the first and last minute only.
    const v = [...Array(12).fill(1), ...Array(696).fill(0.3), ...Array(12).fill(0.9)] as number[];
    expect(dropOf(v)).toBeCloseTo(0.1, 12);
  });

  it('a flat series has drop 0, whatever its level and length', () => {
    expect(dropOf([1, 1])).toBe(0);
    expect(dropOf(Array(7).fill(0.73) as number[])).toBe(0);
    expect(dropOf(Array(60).fill(1.2345) as number[])).toBe(0);
    expect(dropOf([1, null, 1, null, null, 1, 1])).toBe(0);
  });

  it('is scale-free: multiplying the series by a constant changes nothing', () => {
    const v = [1, 0.97, 0.9, 0.85, 0.8, 0.78, 0.7];
    expect(dropOf(v.map((x) => x * 37))).toBeCloseTo(dropOf(v)!, 12);
  });

  it('does not change its input', () => {
    const v = [1, null, 0.5, 0.4];
    const copy = [...v];
    dropOf(v);
    expect(v).toEqual(copy);
  });
});

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
    expect(seriesOf(s, START, [])).toEqual({ values: [], base: [null], hidden: [] });
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

describe('snapshot: the record shape the chart and the saved record are built from', () => {
  const loops = (parts: PartState[], hidden: [number, number][] = []): Loops => ({
    parts,
    start: () => START,
    hidden,
    done: Promise.resolve(),
    stop: async () => {},
    cancel: () => {},
  });

  it('carries the plan, each part\'s keys, units, base, values and drop, and the longest hidden list', () => {
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
    expect(rec.parts.map((p) => p.id)).toEqual(['cpu-multi', 'memory']);
    expect(rec.parts[0]!.keys).toEqual([defKey(A), defKey(B)]);
    expect(rec.parts[0]!.units).toEqual([A.unit, B.unit]);
    expect(rec.parts[1]!.workers).toBe(4);
    expect(rec.parts[0]!.values).toEqual([1, null, null, 0.5, 0.5]);
    expect(rec.parts[0]!.drop).toBeCloseTo(1 - 0.5, 12); // 3 valid windows: n = 1
    expect(rec.parts[1]!.drop).toBe(0);
  });

  it('a part that failed carries its error; a part with no windows has no drop', () => {
    const a = part(1, 1, 3);
    a.error = 'worker init failed: nope';
    const rec = snapshot(loops([a]), 15_000);
    expect(rec.parts[0]).toMatchObject({ values: [], drop: null, error: 'worker init failed: nope' });
    expect(rec.hidden).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The saved endurance block

const KEY_A = defKey(A);
/** A valid record body as JSON, with `edit` applied to the endurance block's JSON. */
function enduranceJson(edit: (r: any) => void = () => {}): any {
  const r = JSON.parse(
    JSON.stringify(
      buildEnduranceRecord(
        {
          durationMs: 60_000,
          windowMs: 5_000,
          hidden: [2],
          parts: [
            {
              id: 'cpu-single',
              label: 'CPU — single core',
              workers: 1,
              keys: [KEY_A, defKey(B)],
              units: [A.unit, B.unit],
              base: [123.456789, 98.7654321],
              values: [1, 1.0004, null, 0.98, 0.95, 0.9, 0.8, 0.75, 0.7, 0.6, 0.55, 0.5],
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

describe('buildEnduranceRecord', () => {
  const build = (values: (number | null)[], base: (number | null)[] = [123456.789]) =>
    buildEnduranceRecord(
      {
        durationMs: 30_000,
        windowMs: 5_000,
        hidden: [],
        parts: [{ id: 'cpu-single', label: 'CPU', workers: 1, keys: [KEY_A], units: [A.unit], base, values }],
      },
      'smoke',
      SYSTEM,
    );

  it('is an Endurance record: mode "endurance", no components, no points, schema 1', () => {
    const r = build([1, 0.9]);
    expect(r).toMatchObject({ schema: 1, mode: 'endurance', size: 'smoke', components: [], total: null });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.time).toISOString()).toBe(r.time);
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(0.1, 12);
  });

  it('rounds values to 4 and base to 6 significant digits, and maps non-finite numbers to null', () => {
    const r = build([1, 0.123456789, 1.00004, NaN, Infinity, null], [123456.789, null]);
    expect(r.endurance!.parts[0]!.values).toEqual([1, 0.1235, 1, null, null, null]);
    expect(r.endurance!.parts[0]!.base).toEqual([123457, null]);
  });

  it('computes the drop from the rounded series, never from a drop passed in', () => {
    const r = build([1, 0.5]);
    const p = (r.endurance!.parts[0] as unknown) as Record<string, unknown>;
    expect(p['drop']).toBeCloseTo(0.5, 12);
    const again = buildEnduranceRecord(
      { ...r.endurance!, parts: [{ ...r.endurance!.parts[0]!, drop: 0.99 } as never] },
      'smoke',
      SYSTEM,
    );
    expect(again.endurance!.parts[0]!.drop).toBeCloseTo(0.5, 12);
  });

  it('a record with no valid windows has drop null and still validates', () => {
    const r = build(nulls(4));
    expect(r.endurance!.parts[0]!.drop).toBeNull();
    expect(cleanRecord(JSON.parse(JSON.stringify(r)))).toMatchObject({ mode: 'endurance' });
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

  it('keeps the block\'s fields: plan, hidden indexes, keys, units, base, series (null = invalid) and drop', () => {
    const r = ok(enduranceJson());
    expect(r).toMatchObject({ mode: 'endurance', components: [], total: null });
    const e = r.endurance!;
    expect(e).toMatchObject({ durationMs: 60_000, windowMs: 5_000, hidden: [2] });
    expect(e.parts[0]).toMatchObject({ id: 'cpu-single', label: 'CPU — single core', workers: 1, keys: [KEY_A, defKey(B)] });
    expect(e.parts[0]!.base).toEqual([123.457, 98.7654]);
    expect(e.parts[0]!.values[2]).toBeNull();
    expect(e.parts[0]!.values).toHaveLength(12);
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
});

describe('strict validation of the endurance block', () => {
  it('mode "endurance" if and only if the block is present', () => {
    expect(bad(enduranceJson((r) => delete r.endurance))).toMatch(/^Run 1 in the file is not valid/);
    expect(bad(enduranceJson((r) => (r.mode = 'quick')))).toMatch(/^Run 1 in the file is not valid/);
    expect(bad(enduranceJson((r) => (r.mode = 'full')))).toMatch(/^Run 1 in the file is not valid/);
    // A benchmark record with a block added.
    const quick: any = JSON.parse(JSON.stringify(tinyRecord('q', at(1))));
    quick.endurance = enduranceJson().endurance;
    expect(bad(quick)).toMatch(/^Run 1 in the file is not valid/);
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
    expect(bad(enduranceJson((r) => edit(r.endurance.parts[0])))).toMatch(/^Run 1 in the file is not valid/);
  });

  it('a part with no kernels at all (all three lists empty) is fine', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance.parts[0], { keys: [], units: [], base: [] })));
    expect(r.endurance!.parts[0]!.keys).toEqual([]);
  });

  it(`at most ${MAX_WINDOWS} windows per part: ${MAX_WINDOWS} is accepted, ${MAX_WINDOWS + 1} is refused`, () => {
    const series = (n: number) => Array.from({ length: n }, () => 1);
    expect(ok(enduranceJson((r) => (r.endurance.parts[0].values = series(MAX_WINDOWS)))).endurance!.parts[0]!.values).toHaveLength(MAX_WINDOWS);
    expect(bad(enduranceJson((r) => (r.endurance.parts[0].values = series(MAX_WINDOWS + 1))))).toMatch(/^Run 1/);
    expect(bad(enduranceJson((r) => (r.endurance.parts[0].values = series(50_000))))).toMatch(/^Run 1/);
  });

  it(`the hidden list is bounded the same way (${MAX_WINDOWS})`, () => {
    const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(ok(enduranceJson((r) => (r.endurance.hidden = idx(MAX_WINDOWS)))).endurance!.hidden).toHaveLength(MAX_WINDOWS);
    expect(bad(enduranceJson((r) => (r.endurance.hidden = idx(MAX_WINDOWS + 1))))).toMatch(/^Run 1/);
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
    ['a non-string error', (p: any) => (p.error = 5)],
  ])('a part with %s is refused', (_n, edit) => {
    expect(bad(enduranceJson((r) => edit(r.endurance.parts[0])))).toMatch(/^Run 1 in the file is not valid/);
  });

  it('values of 0 and null are accepted (0 = not faster than nothing, null = invalid window)', () => {
    const r = ok(enduranceJson((x) => (x.endurance.parts[0].values = [1, 0, null, 0.5])));
    expect(r.endurance!.parts[0]!.values).toEqual([1, 0, null, 0.5]);
  });

  it.each([
    ['durationMs 0', (e: any) => (e.durationMs = 0)],
    ['durationMs negative', (e: any) => (e.durationMs = -5)],
    ['durationMs fractional', (e: any) => (e.durationMs = 1.5)],
    ['durationMs a string', (e: any) => (e.durationMs = '60000')],
    ['windowMs 0', (e: any) => (e.windowMs = 0)],
    ['a negative hidden index', (e: any) => (e.hidden = [-1])],
    ['a fractional hidden index', (e: any) => (e.hidden = [1.5])],
    ['hidden not a list', (e: any) => (e.hidden = 3)],
    ['parts not a list', (e: any) => (e.parts = {})],
    ['hidden missing', (e: any) => delete e.hidden],
    ['parts missing', (e: any) => delete e.parts],
    ['the block is null', (_e: any) => {}],
  ])('a block with %s is refused', (n, edit) => {
    const run = enduranceJson((r) => (n === 'the block is null' ? (r.endurance = null) : edit(r.endurance)));
    expect(bad(run)).toMatch(/^Run 1 in the file is not valid/);
  });

  it('an empty list of parts is accepted (a run with nothing to show is still a valid file)', () => {
    expect(ok(enduranceJson((r) => (r.endurance.parts = []))).endurance!.parts).toEqual([]);
  });

  it('one bad Endurance record refuses the whole file, and says which run', () => {
    const good = enduranceJson((r) => ((r.id = 'good'), (r.time = at(1))));
    const broken = enduranceJson((r) => ((r.id = 'broken'), (r.endurance.parts[0].values[0] = -1)));
    const p = parseExport(file([good, broken]));
    expect('error' in p && p.error).toMatch(/^Run 2 in the file is not valid/);
  });
});

describe('a saved drop is never trusted', () => {
  const expected = (r: any) => dropOf(r.endurance.parts[0].values);

  it.each([0.99, -4, 0, null, 1e9])('a saved drop of %j is recomputed on import', (d) => {
    const r = ok(enduranceJson((x) => (x.endurance.parts[0].drop = d)));
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(expected(enduranceJson())!, 12);
  });

  it('a missing drop is filled in', () => {
    const r = ok(enduranceJson((x) => delete x.endurance.parts[0].drop));
    expect(r.endurance!.parts[0]!.drop).toBeCloseTo(expected(enduranceJson())!, 12);
    expect(r.endurance!.parts[0]!.drop).not.toBeNull();
  });

  it('a drop on a series with fewer than 2 valid windows becomes null', () => {
    const r = ok(enduranceJson((x) => Object.assign(x.endurance.parts[0], { values: [1, null, null], drop: 0.5 })));
    expect(r.endurance!.parts[0]!.drop).toBeNull();
  });

  it('is recomputed when the saved history is loaded', () => {
    const forged = enduranceJson((x) => (x.endurance.parts[0].drop = 0.99));
    const store = new FakeStore();
    store.setItem(HISTORY_KEY, JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs: [forged] }));
    const loaded = loadHistory(store as never);
    expect(loaded.error).toBeUndefined();
    expect(loaded.runs[0]!.endurance!.parts[0]!.drop).toBeCloseTo(expected(enduranceJson())!, 12);
    expect(loaded.runs[0]!.endurance!.parts[0]!.drop).not.toBeCloseTo(0.99, 3);
  });

  it('every part gets its own recomputed drop', () => {
    const r = ok(
      enduranceJson((x) => {
        const second = JSON.parse(JSON.stringify(x.endurance.parts[0]));
        Object.assign(second, { id: 'memory', values: [1, 1, 1, 1], drop: 0.7 });
        x.endurance.parts.push(second);
      }),
    );
    expect(r.endurance!.parts[1]!.drop).toBe(0);
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
    expect(Object.keys(r.endurance!)).toEqual(['durationMs', 'windowMs', 'hidden', 'parts']);
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
});

// Known product bugs, kept as `it.fails`: they pass while the bug exists and start failing (remove the marker) once
// it is fixed.
describe('KNOWN BUGS (it.fails)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.fails('dropOf: a first minute of all zeros gives a drop that is not null or finite (schema allows values of 0)', () => {
    const d = dropOf([0, 0, 1, 1]);
    expect(d === null || Number.isFinite(d)).toBe(true); // src/lib/harness/drop.ts:18: 1 - x / 0 = -Infinity (0 / 0 = NaN)
  });

  it.fails('holdWakeLock: a request still in flight when the tab turns visible again must not take a second lock', async () => {
    const f = fakes();
    const release = holdWakeLock(() => {});
    f.setHidden(false); // visibilitychange before the first request resolved: a second request goes out
    await flush();
    release();
    await flush();
    expect(f.sentinels.filter((s) => !s.released)).toEqual([]); // wakelock.ts:16-19: the first lock is never released
  });

  it.fails('holdWakeLock: a late lock whose release() rejects must not cause an unhandled rejection', async () => {
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
    expect(unhandled).toEqual([]); // wakelock.ts:20: `void l.release()` has no catch
  });
});
