// Strict import details added in M6 (docs/SPEC.md, section 6): time format, core/worker counts, valid-and-hidden,
// unknown keys dropped, the size limit constant, and sorting by moment. Nothing here asserts on speed.
import { describe, expect, it } from 'vitest';
import { exportText } from '../../src/lib/store/export.ts';
import { loadHistory, mergeRuns, sortRuns, HISTORY_CAP, HISTORY_KEY, saveHistory } from '../../src/lib/store/history.ts';
import { MAX_IMPORT_BYTES, parseExport } from '../../src/lib/store/import.ts';
import { cleanRecord, SCHEMA, type RunRecord } from '../../src/lib/store/schema.ts';
import { at, completeRecord, FakeStore, tinyRecord } from './store-support.ts';

const parse = (runs: unknown[]) => parseExport(JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs }));
const runsOf = (p: ReturnType<typeof parseExport>): RunRecord[] => {
  if ('error' in p) throw new Error(`expected runs, got: ${p.error}`);
  return p.runs;
};
const message = (p: ReturnType<typeof parseExport>): string => {
  if (!('error' in p)) throw new Error('expected an error');
  return p.error;
};
/** `completeRecord()` as plain JSON with `edit` applied. */
const edited = (edit: (r: any) => void): unknown => {
  const r = JSON.parse(JSON.stringify(completeRecord()));
  edit(r);
  return r;
};

describe('time must be ISO 8601 UTC ("...Z")', () => {
  it.each([
    '2026-11-01T10:00:00+05:00', // an offset, not Z
    '2026-11-01T10:00:00', // no zone
    '2026-11-01 10:00:00Z', // space instead of T
    '2026-11-01', // date only
    'Sun, 01 Nov 2026 10:00:00 GMT', // RFC 2822
    '2026-13-45T99:99:99Z', // right shape, not a date
    '',
    'Z',
  ])('%j is refused', (t) => {
    const p = parse([edited((r) => (r.time = t))]);
    expect(message(p)).toMatch(/^Run 1 in the file is not valid/);
  });

  it.each(['2026-11-01T10:00:00Z', '2026-11-01T10:00:00.123Z'])('%s is accepted', (t) => {
    expect(runsOf(parse([edited((r) => (r.time = t))]))[0]!.time).toBe(t);
  });
});

describe('core and worker counts are integers of at least 1', () => {
  it.each([0, -1, 1.5, 0.5, '8', null, NaN, 1e999])('system.cores %j is refused', (n) => {
    // JSON.stringify turns NaN/Infinity into null, which is refused as well.
    expect(message(parse([edited((r) => (r.system.cores = n))]))).toMatch(/Run 1/);
  });

  it.each([0, -3, 2.5, '16', null])('an all-cores kernel with workers %j is refused', (n) => {
    expect(message(parse([edited((r) => (r.components[1].kernels[0].workers = n))]))).toMatch(/Run 1/);
  });

  it.each([1, 2, 64])('cores and workers of %i are accepted', (n) => {
    const r = runsOf(
      parse([
        edited((x) => {
          x.system.cores = n;
          x.components[1].kernels[0].workers = n;
        }),
      ]),
    )[0]!;
    expect(r.system.cores).toBe(n);
    expect(r.components[1]!.kernels[0]!.workers).toBe(n);
  });
});

describe('a kernel cannot be both valid and hidden', () => {
  it('valid && hidden: the whole file is refused', () => {
    const p = parse([tinyRecord('ok', at(0)), edited((r) => Object.assign(r.components[0].kernels[0], { valid: true, hidden: true }))]);
    expect(message(p)).toMatch(/^Run 2 in the file is not valid/);
  });

  it('the other three combinations are fine', () => {
    for (const [valid, hidden] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const r = runsOf(parse([edited((x) => Object.assign(x.components[0].kernels[0], { valid, hidden }))]))[0]!;
      expect(r.components[0]!.kernels[0]).toMatchObject({ valid, hidden });
    }
  });

  it('an invalid-and-hidden result keeps both flags and has no points effect', () => {
    const r = runsOf(
      parse([
        edited((x) => {
          Object.assign(x.components[0].kernels[0], { valid: false, hidden: true, value: null });
        }),
      ]),
    )[0]!;
    expect(r.components[0]!.partial).toBe(true);
  });
});

describe('a failed output check (checksumOk) is never valid', () => {
  const kernel = (x: any) => x.components[0].kernels[0];

  it('valid && checksumOk:false: the whole file is refused', () => {
    const p = parse([tinyRecord('ok', at(0)), edited((r) => Object.assign(kernel(r), { valid: true, checksumOk: false }))]);
    expect(message(p)).toMatch(/^Run 2 in the file is not valid/);
  });

  it('valid:false with checksumOk:false is fine, also together with hidden, and both flags survive a round trip', () => {
    const r = runsOf(parse([edited((x) => Object.assign(kernel(x), { valid: false, hidden: true, checksumOk: false, value: null, error: 'output check failed: x' }))]))[0]!;
    expect(r.components[0]!.kernels[0]).toMatchObject({ valid: false, hidden: true, checksumOk: false, error: 'output check failed: x' });
    const again = runsOf(parseExport(exportText([r])))[0]!;
    expect(again.components[0]!.kernels[0]!.checksumOk).toBe(false);
  });

  it('valid with checksumOk:true, or without the key (older records), is fine', () => {
    expect(runsOf(parse([edited((x) => Object.assign(kernel(x), { checksumOk: true }))]))[0]!.components[0]!.kernels[0]!.valid).toBe(true);
    expect(runsOf(parse([edited(() => {})]))[0]!.components[0]!.kernels[0]!.valid).toBe(true);
  });

  it.each(['no', 0, 1, null, {}])('checksumOk %j (not a boolean) is refused', (v) => {
    expect(message(parse([edited((x) => Object.assign(kernel(x), { checksumOk: v }))]))).toMatch(/Run 1/);
  });

  it('an all-cores kernel is held to the same rule', () => {
    const p = parse([edited((x) => Object.assign(x.components[1].kernels[0], { valid: true, checksumOk: false }))]);
    expect(message(p)).toMatch(/Run 1/);
  });
});

describe('sample counts are integers of at least 0', () => {
  it.each([-1, 1.5, 0.1, '5', null, true])('samples %j is refused', (n) => {
    expect(message(parse([edited((r) => (r.components[0].kernels[0].samples = n))]))).toMatch(/Run 1/);
  });

  it.each([-2, 2.5, '3', null])('singleSamples %j on an all-cores kernel is refused', (n) => {
    expect(message(parse([edited((r) => (r.components[1].kernels[0].singleSamples = n))]))).toMatch(/Run 1/);
  });

  it.each([0, 1, 5, 1000])('samples and singleSamples of %i are accepted', (n) => {
    const r = runsOf(
      parse([
        edited((x) => {
          x.components[0].kernels[0].samples = n;
          x.components[1].kernels[0].singleSamples = n;
        }),
      ]),
    )[0]!;
    expect(r.components[0]!.kernels[0]!.samples).toBe(n);
    expect(r.components[1]!.kernels[0]!.singleSamples).toBe(n);
  });
});

describe('keyed lists must be unique', () => {
  it('two kernels with the same key in one component: the whole file is refused', () => {
    const p = parse([tinyRecord('ok', at(0)), edited((r) => (r.components[0].kernels[1].key = r.components[0].kernels[0].key))]);
    expect(message(p)).toMatch(/^Run 2 in the file is not valid/);
  });

  it('the same kernel key in two different components is fine', () => {
    const r = completeRecord();
    const keys = (id: string) => r.components.find((c) => c.id === id)!.kernels.map((k) => k.key);
    expect(keys('cpu-single').filter((k) => keys('cpu-multi').includes(k)).length).toBeGreaterThan(0);
    expect(runsOf(parse([r]))).toHaveLength(1);
  });

  it('two components with the same id (not GPU) are refused', () => {
    const p = parse([edited((r) => r.components.push(JSON.parse(JSON.stringify(r.components[0]))))]);
    expect(message(p)).toMatch(/Run 1/);
  });

  it('two GPU components with the same preference are refused', () => {
    const p = parse([edited((r) => (r.components[4].gpu.preference = r.components[3].gpu.preference))]);
    expect(message(p)).toMatch(/Run 1/);
  });

  it('two GPU components with different preferences are fine (the Both mode)', () => {
    const r = runsOf(parse([completeRecord()]))[0]!;
    expect(r.components.filter((c) => c.id === 'gpu').map((c) => c.gpu!.preference)).toEqual(['high-performance', 'low-power']);
  });

  it('a duplicate in a stored history is refused on load like any invalid file (empty history plus a message)', () => {
    const s = new FakeStore();
    const dup = JSON.parse(JSON.stringify(tinyRecord('dup', at(1))));
    dup.components[0].kernels.push({ ...dup.components[0].kernels[0] });
    s.data.set(HISTORY_KEY, JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs: [dup, tinyRecord('fine', at(0))] }));
    const loaded = loadHistory(s);
    expect(loaded.runs).toEqual([]);
    expect(loaded.error).toMatch(/could not be read/);
  });
});

describe('unknown keys are dropped, at every level', () => {
  it('junk keys are neither kept nor re-exported', () => {
    const r = edited((x) => {
      x.junk = 1;
      x.system.junk = 2;
      x.components[0].junk = 3;
      x.components[0].kernels[0].junk = 4;
      x.components[0].kernels[0].ms.junk = 5;
      x.components[3].gpu.junk = 6;
    });
    const back = runsOf(parse([r]))[0]!;
    const text = exportText([back]);
    expect(text).not.toContain('junk');
    expect(Object.keys(back).sort()).toEqual(['components', 'id', 'mode', 'partial', 'schema', 'scoreVersion', 'size', 'system', 'time', 'total']);
  });

  it('top-level extras in the file are ignored', () => {
    const text = JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs: [], extra: [1, 2, 3], note: 'hi' });
    expect(runsOf(parseExport(text))).toEqual([]);
  });

  it('cleanRecord returns a copy, never the object it was given', () => {
    const src = JSON.parse(JSON.stringify(completeRecord()));
    const out = cleanRecord(src);
    expect(typeof out).toBe('object');
    expect(out).not.toBe(src);
    expect((out as RunRecord).system).not.toBe(src.system);
  });
});

describe('size limit and dedupe', () => {
  it('the refusal threshold is 5 MB, and a full run is far below it', () => {
    expect(MAX_IMPORT_BYTES).toBe(5 * 1024 * 1024);
    expect(exportText([completeRecord()]).length * 50).toBeLessThan(MAX_IMPORT_BYTES); // a full 50-run history fits
  });

  it('duplicate ids inside one file: the first is kept, the later ones silently skipped', () => {
    const a = tinyRecord('dup', at(0));
    const runs = runsOf(parse([a, tinyRecord('dup', at(5), { mode: 'full' }), tinyRecord('other', at(1)), tinyRecord('dup', at(9))]));
    expect(runs.map((r) => [r.id, r.time])).toEqual([
      ['dup', at(0)],
      ['other', at(1)],
    ]);
  });

  it('importing the same file twice adds nothing the second time', () => {
    const file = runsOf(parse([tinyRecord('a', at(0)), tinyRecord('b', at(1))]));
    const first = mergeRuns([], file);
    const second = mergeRuns(first.runs, file);
    expect(second.added).toBe(0);
    expect(second.runs).toEqual(first.runs);
  });
});

describe('history cap and ordering', () => {
  it('saving 51 runs through merge drops the oldest; load never returns more than 50', () => {
    const runs = Array.from({ length: HISTORY_CAP + 1 }, (_, i) => tinyRecord(`r${i}`, at(i)));
    const m = mergeRuns([], runs);
    expect(m.runs).toHaveLength(HISTORY_CAP);
    expect(m.added).toBe(HISTORY_CAP);
    expect(m.tooOld).toBe(1); // into an empty history the oldest new run is the one cut: nothing saved is lost
    expect(m.dropped).toBe(0);
    expect(m.runs.some((r) => r.id === 'r0')).toBe(false);
    const s = new FakeStore();
    expect(saveHistory(m.runs, s)).toBeUndefined();
    expect(loadHistory(s).runs).toHaveLength(HISTORY_CAP);
  });

  it('a history file holding more than the cap loads as the newest 50, even when written out of order', () => {
    const s = new FakeStore();
    const runs = Array.from({ length: 70 }, (_, i) => tinyRecord(`r${i}`, at((i * 37) % 70)));
    s.data.set(HISTORY_KEY, exportText(runs, 0));
    const loaded = loadHistory(s).runs;
    expect(loaded).toHaveLength(HISTORY_CAP);
    const times = loaded.map((r) => Date.parse(r.time));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(Date.parse(loaded[HISTORY_CAP - 1]!.time)).toBe(Date.parse(at(20)));
  });

  it('sortRuns sorts by the time value, not the text: milliseconds and fractions compare numerically', () => {
    const a = tinyRecord('a', '2026-11-01T10:00:00.5Z');
    const b = tinyRecord('b', '2026-11-01T10:00:00.25Z');
    const c = tinyRecord('c', '2026-11-01T10:00:01Z');
    expect(sortRuns([a, b, c]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
