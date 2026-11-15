// Records, export/import and history (docs/SPEC.md, section 6, "How it works (M6)"). Everything runs in Node
// against made-up outcomes and a fake localStorage. Nothing here asserts on speed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { describe as describeKey } from '../../src/lib/bench/components.ts';
import { latencyDefs, memCopyMulti, memoryKernels } from '../../src/lib/bench/memory/index.ts';
import { storageKernels } from '../../src/lib/bench/storage/index.ts';
import { webgpuKernels, gpuKernels } from '../../src/lib/bench/gpu/index.ts';
import { defKey } from '../../src/lib/bench/types.ts';
import { CONSTANTS, SCORE_VERSION } from '../../src/lib/scoring/constants.ts';
import { exportText } from '../../src/lib/store/export.ts';
import {
  HISTORY_CAP,
  HISTORY_KEY,
  loadHistory,
  mergeRuns,
  saveHistory,
  sortRuns,
} from '../../src/lib/store/history.ts';
import { parseExport } from '../../src/lib/store/import.ts';
import { buildRecord, kernelRecord, multiRecord } from '../../src/lib/store/record.ts';
import { checkRecord, SCHEMA, type RunRecord } from '../../src/lib/store/schema.ts';
import {
  at,
  completeRecord,
  completeView,
  emptyView,
  FakeStore,
  multiOutcome,
  outcome,
  quotaError,
  SYSTEM,
  tinyRecord,
  tp,
} from './store-support.ts';

const ok = (p: ReturnType<typeof parseExport>): RunRecord[] => {
  if ('error' in p) throw new Error(`expected runs, got: ${p.error}`);
  return p.runs;
};
const bad = (p: ReturnType<typeof parseExport>): string => {
  if (!('error' in p)) throw new Error('expected an error, got runs');
  return p.error;
};
const file = (runs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'browser-bench', schema: SCHEMA, runs, ...extra });

// ───────────────────────────────── record ─────────────────────────────────

describe('buildRecord', () => {
  it('a full run at the constants: 1000 everywhere, one record per tested GPU, not partial', () => {
    const r = completeRecord();
    expect(r.schema).toBe(SCHEMA);
    expect(r.scoreVersion).toBe(SCORE_VERSION);
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.time).toMatch(/Z$/); // UTC
    expect(Number.isNaN(Date.parse(r.time))).toBe(false);
    expect(r.mode).toBe('quick');
    expect(r.size).toBe('standard');
    expect(r.components.map((c) => c.id)).toEqual(['cpu-single', 'cpu-multi', 'memory', 'gpu', 'gpu', 'storage']);
    for (const c of r.components) {
      expect(c.points, c.id).toBe(1000);
      expect(c.partial, c.id).toBe(false);
      expect(c.note, c.id).toBeUndefined();
    }
    expect(r.total).toBe(1000);
    expect(r.partial).toBe(false);
    expect(checkRecord(r)).toBeUndefined();
  });

  it('ids are unique per call', () => {
    expect(completeRecord().id).not.toBe(completeRecord().id);
  });

  it('every kernel keeps its defKey; latency is stored as ns per access with unit "ns"', () => {
    const r = completeRecord();
    const keys = (id: string) => r.components.find((c) => c.id === id)!.kernels.map((k) => k.key);
    expect(keys('cpu-single')).toEqual(cpuKernels.map(defKey));
    expect(keys('cpu-multi')).toEqual(cpuKernels.map(defKey));
    expect(keys('memory')).toEqual([...memoryKernels.map(defKey), 'mem_copy_mt']);
    expect(keys('storage')).toEqual(storageKernels.map(defKey));
    const mem = r.components.find((c) => c.id === 'memory')!;
    for (const d of latencyDefs) {
      const k = mem.kernels.find((x) => x.key === defKey(d))!;
      expect(k.unit).toBe('ns');
      expect(k.value).toBeCloseTo(CONSTANTS[`memory/${defKey(d)}`]!, 9);
    }
    // Every other kernel keeps the def's unit.
    expect(mem.kernels.find((k) => k.key === 'mem_fill')!.unit).toBe('GB/s');
    expect(r.components[0]!.kernels[0]!.unit).toBe(cpuKernels[0]!.unit);
  });

  it('all-cores kernels record the combined throughput, the worker count, 1-worker value and scaling', () => {
    const r = completeRecord();
    const k = r.components.find((c) => c.id === 'cpu-multi')!.kernels[0]!;
    expect(k.value).toBe(CONSTANTS['cpu-multi/sha256']);
    expect(k.workers).toBe(16);
    expect(k.single).toBeCloseTo(CONSTANTS['cpu-multi/sha256']! / 8, 9);
    expect(k.singleSpread).toBe(0.02);
    expect(k.scaling).toBe(8);
    expect(k.weakBaseline).toBe(false);
    // Single-core records carry none of these.
    const s = r.components.find((c) => c.id === 'cpu-single')!.kernels[0]!;
    expect(s.workers).toBeUndefined();
    expect(s.scaling).toBeUndefined();
  });

  it('numbers keep six significant digits, summary stats only, no per-sample arrays', () => {
    const k = completeRecord().components[0]!.kernels[0]!;
    expect(k.ms).toEqual({ median: 12.3457, min: 12.1, max: 12.9 });
    expect(k.spread).toBe(0.0647);
    expect(k.samples).toBe(5);
    expect(k.noisy).toBe(false);
    const text = exportText([completeRecord()], 0);
    expect(text).not.toMatch(/times|samplesList/i);
    expect(text.length).toBeLessThan(25_000); // SPEC: a full run is about 11 kB
  });

  it('an invalid or hidden kernel has value null, keeps its flags and error, and leaves the component partial', () => {
    const v = completeView();
    v.outcomes[0] = outcome(cpuKernels[0]!, 123, { valid: false, checksumOk: false, error: 'output check failed: x' });
    v.outcomes[1] = outcome(cpuKernels[1]!, 123, { valid: false, hidden: true, error: 'tab was hidden' });
    const r = buildRecord(v, ['cpu-single'], 'quick', 'standard', SYSTEM);
    const [a, b, c] = r.components[0]!.kernels;
    expect(a).toMatchObject({ value: null, valid: false, hidden: false, error: 'output check failed: x' });
    expect(b).toMatchObject({ value: null, valid: false, hidden: true, error: 'tab was hidden' });
    expect(c!.valid).toBe(true);
    expect(r.components[0]!.partial).toBe(true);
    expect(r.components[0]!.points).toBe(1000); // the other nine still score; the bad ones are left out
    expect(r.partial).toBe(true);
  });

  it('a kernel that failed outright (no stats, no throughput) is recorded with null and no stats', () => {
    const k = kernelRecord({ def: cpuKernels[0]!, checksumOk: false, hidden: false, noisy: false, valid: false, error: 'boom' });
    expect(k).toEqual({ key: 'sha256', unit: cpuKernels[0]!.unit, value: null, valid: false, noisy: false, hidden: false, checksumOk: false, error: 'boom' });
  });

  it('a failed output check is stored as checksumOk:false, a passed one leaves the key out (compact, older records lack it)', () => {
    const bad = kernelRecord(outcome(cpuKernels[0]!, 123, { valid: false, checksumOk: false, error: 'output check failed: x' }));
    expect(bad.checksumOk).toBe(false);
    const good = kernelRecord(outcome(cpuKernels[0]!, 123));
    expect('checksumOk' in good).toBe(false);
    // hidden but with a passing check: no checksumOk key either
    const hidden = kernelRecord(outcome(cpuKernels[0]!, 123, { valid: false, hidden: true }));
    expect('checksumOk' in hidden).toBe(false);
    // the all-cores record carries it as well
    const m = multiRecord(multiOutcome(cpuKernels[0]!, 123, { valid: false, checksumOk: false, error: 'output check failed: x' }));
    expect(m.checksumOk).toBe(false);
    expect('checksumOk' in multiRecord(multiOutcome(cpuKernels[0]!, 123))).toBe(false);
  });

  it('hidden and a failed check together: both flags are recorded, so the failure is not lost behind "hidden"', () => {
    const k = kernelRecord(outcome(cpuKernels[0]!, 123, { valid: false, hidden: true, checksumOk: false, error: 'output check failed: x' }));
    expect(k).toMatchObject({ valid: false, hidden: true, checksumOk: false, error: 'output check failed: x' });
    expect(checkRecord({ ...tinyRecord('a', at(0)), components: [{ ...tinyRecord('a', at(0)).components[0]!, kernels: [k] }] })).toBeUndefined();
  });

  it('a partial selection: the total is the geomean of what ran, marked partial', () => {
    const v = completeView(4);
    const r = buildRecord(v, ['cpu-single', 'memory'], 'full', 'standard', SYSTEM);
    expect(r.mode).toBe('full');
    expect(r.components.map((c) => c.id)).toEqual(['cpu-single', 'memory']);
    expect(r.total).toBe(4000);
    expect(r.partial).toBe(true);
  });

  it('smoke size: components carry the note, no points, no total', () => {
    const r = buildRecord(completeView(), ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'], 'quick', 'smoke', SYSTEM);
    expect(r.size).toBe('smoke');
    for (const c of r.components) {
      expect(c.points, c.id).toBeNull();
      expect(c.note, c.id).toBe('smoke: no points');
    }
    expect(r.total).toBeNull();
    expect(r.partial).toBe(true);
    expect(checkRecord(r)).toBeUndefined();
  });

  it('GPU Both: each GPU gets its own points, but only the high-performance one is in the total', () => {
    const v = completeView();
    v.gpuRuns[1]!.outcomes = webgpuKernels.map((d) => outcome(d, tp('gpu', d, 16))); // the slow GPU "scores" 16000
    const r = buildRecord(v, ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'], 'quick', 'standard', SYSTEM);
    const gpus = r.components.filter((c) => c.id === 'gpu');
    expect(gpus.map((g) => [g.gpu!.preference, g.points])).toEqual([
      ['high-performance', 1000],
      ['low-power', 16000],
    ]);
    expect(r.total).toBe(1000);
    expect(r.partial).toBe(false);
    expect(r.system.gpu).toEqual(['Fast GPU · xe', 'Slow GPU · uhd']);
  });

  it('the WebGL2 fallback earns no points and leaves the total partial', () => {
    const v = completeView();
    v.gpuPlan = { api: 'webgl2', targets: [v.gpuRuns[0]!.target], sameGpu: false };
    v.gpuRuns = [{ target: v.gpuRuns[0]!.target, info: {}, outcomes: gpuKernels.slice(-1).map((d) => outcome(d, 100)) }];
    const r = buildRecord(v, ['gpu'], 'quick', 'standard', SYSTEM);
    const g = r.components[0]!;
    expect(g.gpu!.api).toBe('webgl2');
    expect(g.points).toBeNull();
    expect(g.note).toMatch(/fallback/);
    expect(r.total).toBeNull();
    expect(r.partial).toBe(true);
  });

  it('a scaled-down storage file is recorded with its size and earns no points', () => {
    const v = completeView();
    v.storagePlan = { ok: true, fileBytes: 16 * 1024 * 1024, scaled: true };
    const r = buildRecord(v, ['storage'], 'quick', 'standard', SYSTEM);
    const s = r.components[0]!;
    expect(s).toMatchObject({ id: 'storage', fileBytes: 16 * 1024 * 1024, scaled: true, points: null });
    expect(s.note).toMatch(/smaller/);
    expect(r.total).toBeNull();
  });

  it('storage that could not run, and a browser with no GPU API, are recorded with their reason', () => {
    const v = completeView();
    v.storagePlan = { ok: false, message: 'Not enough storage quota' };
    v.storageOutcomes = [];
    v.gpuPlan = { api: 'none', targets: [], sameGpu: false };
    v.gpuRuns = [];
    const r = buildRecord(v, ['gpu', 'storage'], 'quick', 'standard', SYSTEM);
    expect(r.components).toHaveLength(2);
    expect(r.components[0]).toMatchObject({ id: 'gpu', kernels: [], points: null, error: expect.stringMatching(/WebGPU/) });
    expect(r.components[1]).toMatchObject({ id: 'storage', kernels: [], points: null, error: 'Not enough storage quota' });
    expect(r.total).toBeNull();
    expect(checkRecord(r)).toBeUndefined();
  });

  it('storage that stopped part-way keeps the finished rows and the error', () => {
    const v = completeView();
    v.storageOutcomes = v.storageOutcomes.slice(0, 2);
    v.storageError = 'worker died';
    const s = buildRecord(v, ['storage'], 'quick', 'standard', SYSTEM).components[0]!;
    expect(s.kernels).toHaveLength(2);
    expect(s.error).toBe('worker died');
    expect(s.partial).toBe(true);
    expect(s.points).toBe(1000);
  });

  it('"both" that gave the same GPU is flagged on the first record only', () => {
    const v = completeView();
    v.gpuPlan = { api: 'webgpu', targets: [v.gpuRuns[0]!.target], sameGpu: true };
    v.gpuRuns = [v.gpuRuns[0]!];
    const g = buildRecord(v, ['gpu'], 'quick', 'standard', SYSTEM).components;
    expect(g).toHaveLength(1);
    expect(g[0]!.sameGpu).toBe(true);
  });

  it('system info is copied, with the tested GPU labels added only when GPU ran', () => {
    expect(buildRecord(emptyView(), [], 'quick', 'standard', SYSTEM).system).toEqual(SYSTEM);
    expect(completeRecord().system).toEqual({ ...SYSTEM, gpu: ['Fast GPU · xe', 'Slow GPU · uhd'] });
  });
});

describe('record round trip (outcomes -> record -> JSON -> import -> identical)', () => {
  const variants: [string, () => RunRecord][] = [
    ['a full standard run', () => completeRecord()],
    ['a full-mode run', () => completeRecord({ mode: 'full' })],
    ['a smoke run', () => completeRecord({ size: 'smoke' })],
    [
      'a run with invalid, hidden and noisy kernels',
      () => {
        const v = completeView(1.37);
        v.outcomes[2] = outcome(cpuKernels[2]!, 1, { valid: false, hidden: true, error: 'hidden' });
        v.multiOutcomes[0] = multiOutcome(cpuKernels[0]!, undefined, { valid: false, error: 'a worker failed', weakBaseline: true, noisy: true });
        v.memOutcomes[5] = outcome(latencyDefs[3]!, undefined, { stats: undefined, valid: false, checksumOk: false, error: 'x' });
        return buildRecord(v, ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'], 'quick', 'standard', SYSTEM);
      },
    ],
  ];

  it.each(variants)('%s', (_name, make) => {
    const rec = make();
    for (const indent of [0, 1]) {
      const text = exportText([rec], indent);
      const back = ok(parseExport(text));
      expect(back).toHaveLength(1);
      expect(back[0]).toEqual(rec);
      expect(exportText(back, indent)).toBe(text); // byte-identical when written out again
    }
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec); // nothing lost to JSON (no NaN, Infinity or undefined values)
  });

  it('several runs keep their order and contents', () => {
    const runs = [completeRecord(), completeRecord({ size: 'smoke' }), tinyRecord('t', at(5))];
    expect(ok(parseExport(exportText(runs)))).toEqual(runs);
  });

  it('an empty export is valid and imports as no runs', () => {
    expect(ok(parseExport(exportText([])))).toEqual([]);
  });

  it('the file marker and versions are written at the top', () => {
    const j = JSON.parse(exportText([tinyRecord('a', at(0))])) as Record<string, unknown>;
    expect(j['format']).toBe('browser-bench');
    expect(j['schema']).toBe(SCHEMA);
    expect(Object.keys(j).sort()).toEqual(['format', 'runs', 'schema']);
  });
});

describe('describe(key): display names for saved keys', () => {
  it("every key in a complete record resolves to this build's def name", () => {
    const rec = ok(parseExport(exportText([completeRecord()])))[0]!;
    for (const c of rec.components) {
      for (const k of c.kernels) {
        const d = describeKey(k.key);
        expect(d.name, k.key).not.toBe('');
      }
    }
    const sha = describeKey('sha256');
    expect(sha.name).toBe(cpuKernels.find((d) => defKey(d) === 'sha256')!.name);
    expect(sha.stresses).toBe(cpuKernels.find((d) => defKey(d) === 'sha256')!.stresses);
  });

  it('a key this build no longer has still shows, under its own name', () => {
    expect(describeKey('old_kernel')).toEqual({ name: 'old_kernel', stresses: '' });
  });

  it('latency sizes and the all-cores copy resolve', () => {
    for (const d of latencyDefs) expect(describeKey(defKey(d)).name).toBe(d.name);
    expect(describeKey('mem_copy_mt').name).toBe(memCopyMulti.name);
  });
});

// ───────────────────────────────── import ─────────────────────────────────

describe('parseExport: not a file of ours', () => {
  const rec = tinyRecord('a', at(0));

  it.each(['', ' ', 'not json', '{', '{"format":', 'undefined', "{'format':'browser-bench'}", '\u0000', '[1,2'])(
    'non-JSON %j: a message, no throw',
    (text) => {
      expect(bad(parseExport(text))).toMatch(/not valid JSON/);
    },
  );

  it.each(['null', '[]', '[1]', '42', 'true', '"browser-bench"', '{}', '{"runs":[]}', '{"format":"other","schema":1,"runs":[]}', '{"format":"Browser-Bench","schema":1,"runs":[]}', '{"format":1}'])(
    'JSON without the format marker %j',
    (text) => {
      expect(bad(parseExport(text))).toMatch(/not a browser-bench export/);
    },
  );

  it.each([2, 0, -1, 99, '1', null, true, 1.5, [], {}])('schema %j: refused with a message naming both versions', (schema) => {
    const msg = bad(parseExport(JSON.stringify({ format: 'browser-bench', schema, runs: [rec] })));
    expect(msg).toMatch(/format v/);
    expect(msg).toContain(`v${SCHEMA}`);
  });

  it('a missing schema is refused too, and an unknown version says which one', () => {
    expect(bad(parseExport(JSON.stringify({ format: 'browser-bench', runs: [] })))).toMatch(/format v/);
    expect(bad(parseExport(file([], { schema: 7 })))).toContain('v7');
  });

  it.each([undefined, null, 'x', {}, 5])('runs %j is not a list', (runs) => {
    const text = JSON.stringify({ format: 'browser-bench', schema: SCHEMA, ...(runs === undefined ? {} : { runs }) });
    expect(bad(parseExport(text))).toMatch(/no list of runs/);
  });

  it('never throws, whatever the input', () => {
    const inputs = ['{'.repeat(100_000), '['.repeat(100_000), '"'.repeat(5), 'x'.repeat(1_000_000), '{"format":"browser-bench","schema":1,"runs":[' + '[],'.repeat(1000) + '[]]}'];
    for (const t of inputs) expect(() => parseExport(t), t.slice(0, 10)).not.toThrow();
  });
});

describe('parseExport: every run is checked, field by field', () => {
  const DELETE = Symbol('delete');
  const BASE = completeRecord();
  /** Export text where the run is `BASE` with `value` (or nothing) at `path`. */
  function withField(path: (string | number)[], value: unknown): string {
    const r = JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>;
    let at: Record<string, unknown> = r;
    for (const p of path.slice(0, -1)) at = at[p as string] as Record<string, unknown>;
    const last = path[path.length - 1] as string;
    if (value === DELETE) delete at[last];
    else at[last] = value;
    return file([r]);
  }

  const gpuAt = ['components', 3, 'gpu'];
  const kernel0 = ['components', 0, 'kernels', 0];
  const multi0 = ['components', 1, 'kernels', 0];
  const storage = ['components', 5];
  const cases: [string, (string | number)[], unknown][] = [
    ['id: number', ['id'], 5],
    ['id: missing', ['id'], DELETE],
    ['time: not a date', ['time'], 'yesterday'],
    ['time: number', ['time'], 1_700_000_000],
    ['time: missing', ['time'], DELETE],
    ['mode: unknown', ['mode'], 'turbo'],
    ['size: unknown', ['size'], 'huge'],
    ['size: missing', ['size'], DELETE],
    ['scoreVersion: zero', ['scoreVersion'], 0],
    ['scoreVersion: negative', ['scoreVersion'], -1],
    ['scoreVersion: fraction', ['scoreVersion'], 1.5],
    ['scoreVersion: string', ['scoreVersion'], '1'],
    ['scoreVersion: null', ['scoreVersion'], null],
    ['scoreVersion: missing', ['scoreVersion'], DELETE],
    ['record schema: other', ['schema'], 2],
    ['record schema: missing', ['schema'], DELETE],
    ['total: string', ['total'], '1000'],
    ['total: missing', ['total'], DELETE],
    ['partial: string', ['partial'], 'no'],
    ['partial: missing', ['partial'], DELETE],
    ['system: missing', ['system'], DELETE],
    ['system: null', ['system'], null],
    ['system: string', ['system'], 'x'],
    ['system.browser: number', ['system', 'browser'], 5],
    ['system.version: missing', ['system', 'version'], DELETE],
    ['system.ua: null', ['system', 'ua'], null],
    ['system.cores: string', ['system', 'cores'], '16'],
    ['system.cores: null', ['system', 'cores'], null],
    ['system.isolated: string', ['system', 'isolated'], 'yes'],
    ['system.screen: missing', ['system', 'screen'], DELETE],
    ['system.deviceMemory: string', ['system', 'deviceMemory'], '8'],
    ['system.gpu: string', ['system', 'gpu'], 'x'],
    ['system.gpu: list of numbers', ['system', 'gpu'], [1]],
    ['components: string', ['components'], 'x'],
    ['components: object', ['components'], {}],
    ['components: missing', ['components'], DELETE],
    ['component: null', ['components', 0], null],
    ['component: number', ['components', 0], 5],
    ['component.id: unknown', ['components', 0, 'id'], 'cpu-triple'],
    ['component.kernels: string', ['components', 0, 'kernels'], 'x'],
    ['component.kernels: missing', ['components', 0, 'kernels'], DELETE],
    ['component.points: string', ['components', 0, 'points'], 'x'],
    ['component.points: missing', ['components', 0, 'points'], DELETE],
    ['component.partial: number', ['components', 0, 'partial'], 1],
    ['component.note: number', ['components', 0, 'note'], 5],
    ['component.error: object', ['components', 0, 'error'], {}],
    ['kernel: number', [...kernel0], 5],
    ['kernel: null', [...kernel0], null],
    ['kernel.key: number', [...kernel0, 'key'], 5],
    ['kernel.unit: null', [...kernel0, 'unit'], null],
    ['kernel.value: string', [...kernel0, 'value'], '5'],
    ['kernel.value: missing', [...kernel0, 'value'], DELETE],
    ['kernel.valid: number', [...kernel0, 'valid'], 1],
    ['kernel.noisy: missing', [...kernel0, 'noisy'], DELETE],
    ['kernel.hidden: string', [...kernel0, 'hidden'], 'false'],
    ['kernel.ms: string', [...kernel0, 'ms'], 'x'],
    ['kernel.ms.median: string', [...kernel0, 'ms', 'median'], '1'],
    ['kernel.ms.min: missing', [...kernel0, 'ms', 'min'], DELETE],
    ['kernel.spread: string', [...kernel0, 'spread'], 'x'],
    ['kernel.samples: null', [...kernel0, 'samples'], null],
    ['kernel.error: number', [...kernel0, 'error'], 5],
    ['all-cores workers: string', [...multi0, 'workers'], 'many'],
    ['all-cores single: string', [...multi0, 'single'], 'x'],
    ['all-cores scaling: string', [...multi0, 'scaling'], 'x'],
    ['all-cores weakBaseline: string', [...multi0, 'weakBaseline'], 'no'],
    ['gpu.api: unknown', [...gpuAt, 'api'], 'metal'],
    ['gpu.preference: both', [...gpuAt, 'preference'], 'both'],
    ['gpu.label: number', [...gpuAt, 'label'], 5],
    ['gpu.info: string', [...gpuAt, 'info'], 'x'],
    ['gpu.info: number values', [...gpuAt, 'info'], { a: 1 }],
    ['gpu.info: missing', [...gpuAt, 'info'], DELETE],
    ['gpu: string', [...gpuAt], 'x'],
    ['sameGpu: string', ['components', 3, 'sameGpu'], 'yes'],
    ['storage.fileBytes: string', [...storage, 'fileBytes'], '256'],
    ['storage.scaled: string', [...storage, 'scaled'], 'no'],
  ];

  it('the unmodified record passes (so each failure below is the one edited field)', () => {
    expect(ok(parseExport(withField(['id'], BASE.id)))).toEqual([BASE]);
  });

  it.each(cases)('%s: the file is rejected, naming the run', (_name, path, value) => {
    const p = parseExport(withField(path, value));
    expect(bad(p)).toMatch(/^Run 1 in the file is not valid: .+\.$/);
  });

  it.each(['1e999', '-1e999'])('a number that overflows to Infinity (%s) is rejected', (n) => {
    const text = file([BASE]).replace(`"cores":${BASE.system.cores}`, `"cores":${n}`);
    expect(text).toContain(n);
    expect(bad(parseExport(text))).toMatch(/Run 1/);
  });

  it('a record that is not an object, whatever it is', () => {
    for (const r of [null, 5, 'x', [], true]) expect(bad(parseExport(file([r])))).toMatch(/Run 1 .* not an object/);
  });

  it('one bad run rejects the whole file: no runs come back, and the message counts from 1', () => {
    const good = tinyRecord('good', at(0));
    const broken = { ...tinyRecord('broken', at(1)), mode: 'turbo' };
    const p = parseExport(file([good, good === good ? { ...good, id: 'other' } : good, broken]));
    expect(p).not.toHaveProperty('runs');
    expect(bad(p)).toMatch(/^Run 3 /);
  });

  it('an unknown record schema inside a valid file is named', () => {
    expect(bad(parseExport(file([{ ...tinyRecord('a', at(0)), schema: 2 }])))).toContain('v2');
  });

  it('any scoreVersion of at least 1 is accepted (other versions load, they are just never compared)', () => {
    for (const v of [1, 2, 7, 1000]) {
      const runs = ok(parseExport(file([tinyRecord('a', at(0), { scoreVersion: v })])));
      expect(runs[0]!.scoreVersion).toBe(v);
    }
  });

  it('a run with a saved total and points is taken as saved (no recomputing on import)', () => {
    const r = tinyRecord('a', at(0), { total: 31337, scoreVersion: 3 });
    expect(ok(parseExport(file([r])))[0]!.total).toBe(31337);
  });

  it('runs with the same id are kept once, the first one wins', () => {
    const a = tinyRecord('same', at(0));
    const a2 = tinyRecord('same', at(9), { mode: 'full' });
    const b = tinyRecord('other', at(1));
    const runs = ok(parseExport(file([a, b, a2])));
    expect(runs.map((r) => r.id)).toEqual(['same', 'other']);
    expect(runs[0]!.time).toBe(at(0));
  });
});

describe('parseExport: hostile keys do not pollute Object.prototype', () => {
  const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort();
  const before = protoNames();
  const probe = (name: string) => (({}) as Record<string, unknown>)[name];

  const inject = (text: string, where: string, extra: string) => {
    expect(text).toContain(where);
    return text.replace(where, where + extra);
  };
  const HOSTILE = '"__proto__":{"polluted":"yes","isAdmin":true},"constructor":{"prototype":{"polluted2":"yes"}},';

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)['polluted'];
  });

  function hostileFile(): string {
    let t = exportText([completeRecord()], 0);
    t = inject(t, '{"format":"browser-bench",', HOSTILE); // the file
    t = inject(t, '"runs":[{', HOSTILE); // the run
    t = inject(t, '"system":{', HOSTILE); // system info
    t = inject(t, '"components":[{', HOSTILE); // a component
    t = inject(t, '"kernels":[{', HOSTILE); // a kernel
    t = inject(t, '"ms":{', HOSTILE); // sample stats
    t = inject(t, '"info":{', '"__proto__":"x","constructor":"y",'); // a string map
    return t;
  }

  it('the file parses (unknown keys are ignored, not an error), and nothing global changes', () => {
    const runs = ok(parseExport(hostileFile()));
    expect(runs).toHaveLength(1);
    expect(probe('polluted')).toBeUndefined();
    expect(probe('polluted2')).toBeUndefined();
    expect(probe('isAdmin')).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({}) as object).not.toHaveProperty('isAdmin');
    expect(protoNames()).toEqual(before);
    expect(Object.getPrototypeOf(runs[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(runs[0]!.components[0]!.kernels[0])).toBe(Object.prototype);
  });

  it('merging, sorting, saving, loading and opening such a run pollutes nothing either', () => {
    const runs = ok(parseExport(hostileFile()));
    const store = new FakeStore();
    const m = mergeRuns([tinyRecord('x', at(0))], runs);
    expect(saveHistory(m.runs, store)).toBeUndefined();
    const back = loadHistory(store);
    expect(back.error).toBeUndefined();
    expect(back.runs).toHaveLength(2);
    describeKey(back.runs[0]!.components[0]!.kernels[0]!.key);
    expect(probe('polluted')).toBeUndefined();
    expect(protoNames()).toEqual(before);
  });

  it('a run id of "__proto__" or "constructor" is just an id', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const runs = ok(parseExport(file([tinyRecord(id, at(0)), tinyRecord(id, at(1))])));
      expect(runs.map((r) => r.id)).toEqual([id]);
      expect(mergeRuns([], runs).runs).toHaveLength(1);
    }
    expect(protoNames()).toEqual(before);
  });

  it('a hostile file that is rejected for another reason pollutes nothing', () => {
    const t = '{"__proto__":{"polluted":"yes"},"format":"browser-bench","schema":1,"runs":[{"__proto__":{"polluted":"yes"}}]}';
    expect(bad(parseExport(t))).toMatch(/Run 1/);
    expect(probe('polluted')).toBeUndefined();
  });
});

// ───────────────────────────────── history ─────────────────────────────────

describe('loadHistory', () => {
  it('nothing saved: no runs, no message', () => {
    expect(loadHistory(new FakeStore())).toEqual({ runs: [] });
  });

  it('reads what saveHistory wrote, newest first', () => {
    const s = new FakeStore();
    const runs = [tinyRecord('a', at(1)), tinyRecord('b', at(3)), tinyRecord('c', at(2))];
    expect(saveHistory(runs, s)).toBeUndefined();
    const r = loadHistory(s);
    expect(r.error).toBeUndefined();
    expect(r.runs.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('is saved under one key in the compact export format', () => {
    const s = new FakeStore();
    saveHistory([tinyRecord('a', at(0))], s);
    expect([...s.data.keys()]).toEqual([HISTORY_KEY]);
    expect(HISTORY_KEY).toBe('browser-bench:history');
    const text = s.data.get(HISTORY_KEY)!;
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toMatchObject({ format: 'browser-bench', schema: SCHEMA });
  });

  it.each([
    ['not json at all', 'not json {'],
    ['an empty string', ''],
    ['truncated JSON', '{"format":"browser-bench","schema":1,"runs":[{"id":'],
    ['JSON of another kind', '[1,2,3]'],
    ['another app\'s object', '{"hello":"world"}'],
    ['a future schema', '{"format":"browser-bench","schema":2,"runs":[]}'],
    ['a run with a wrong field', file([{ ...tinyRecord('a', at(0)), total: 'lots' }])],
  ])('corrupt data (%s): a message, no runs, no throw', (_name, text) => {
    const s = new FakeStore();
    s.data.set(HISTORY_KEY, text);
    const r = loadHistory(s);
    expect(r.runs).toEqual([]);
    expect(r.error).toEqual(expect.stringMatching(/could not be read/));
    expect(r.error).toMatch(/next saved run replaces it/);
  });

  it('the next save replaces corrupt data and loads clean afterwards', () => {
    const s = new FakeStore();
    s.data.set(HISTORY_KEY, 'garbage');
    expect(loadHistory(s).error).toBeDefined();
    expect(saveHistory([tinyRecord('fresh', at(0))], s)).toBeUndefined();
    expect(loadHistory(s)).toEqual({ runs: [expect.objectContaining({ id: 'fresh' })] });
  });

  it('blocked storage (getItem throws): a message, no runs, no throw', () => {
    const s = new FakeStore();
    s.getItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const r = loadHistory(s);
    expect(r.runs).toEqual([]);
    expect(r.error).toMatch(/not available/);
  });

  it('keeps at most 50 runs, the newest', () => {
    const s = new FakeStore();
    const runs = Array.from({ length: 60 }, (_, i) => tinyRecord(`r${i}`, at(i)));
    s.data.set(HISTORY_KEY, exportText(runs, 0));
    const r = loadHistory(s);
    expect(r.runs).toHaveLength(HISTORY_CAP);
    expect(r.runs[0]!.id).toBe('r59');
    expect(r.runs[49]!.id).toBe('r10');
  });

  it('uses the page\'s localStorage when no store is given', () => {
    const s = new FakeStore();
    s.data.set(HISTORY_KEY, exportText([tinyRecord('g', at(0))], 0));
    vi.stubGlobal('localStorage', s);
    try {
      expect(loadHistory().runs.map((r) => r.id)).toEqual(['g']);
      expect(saveHistory([])).toBeUndefined();
      expect(s.data.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('saveHistory', () => {
  it('an empty list removes the key instead of storing an empty file', () => {
    const s = new FakeStore();
    saveHistory([tinyRecord('a', at(0))], s);
    expect(s.data.has(HISTORY_KEY)).toBe(true);
    expect(saveHistory([], s)).toBeUndefined();
    expect(s.data.has(HISTORY_KEY)).toBe(false);
  });

  it('a full quota: a message about being full, no throw, old data untouched', () => {
    const s = new FakeStore();
    saveHistory([tinyRecord('old', at(0))], s);
    const kept = s.data.get(HISTORY_KEY);
    s.setItem = () => {
      throw quotaError();
    };
    const msg = saveHistory([tinyRecord('old', at(0)), tinyRecord('new', at(1))], s);
    expect(msg).toMatch(/full/);
    expect(msg).toMatch(/Export/);
    expect(s.data.get(HISTORY_KEY)).toBe(kept);
  });

  it.each([
    ['a SecurityError', () => new DOMException('denied', 'SecurityError')],
    ['a plain Error', () => new Error('nope')],
    ['a string', () => 'nope' as unknown as Error],
  ])('any other failure (%s): a "not available" message, no throw', (_name, make) => {
    const s = new FakeStore();
    s.setItem = () => {
      throw make();
    };
    expect(saveHistory([tinyRecord('a', at(0))], s)).toMatch(/not available/);
  });

  it('removeItem failing while clearing is also a message, not a throw', () => {
    const s = new FakeStore();
    s.removeItem = () => {
      throw new Error('blocked');
    };
    expect(saveHistory([], s)).toMatch(/not available/);
  });

  it('a message is returned for the page to show; the run itself stays in memory (setItem fails, load sees none)', () => {
    const s = new FakeStore();
    s.setItem = () => {
      throw quotaError();
    };
    expect(saveHistory([tinyRecord('a', at(0))], s)).toBeDefined();
    expect(loadHistory(s).runs).toEqual([]);
  });
});

describe('blocked localStorage (the property itself throws, as Chrome does with site data blocked)', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete (globalThis as Record<string, unknown>)['localStorage'];
  });
  const block = () =>
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException("Failed to read the 'localStorage' property from 'Window': Access is denied.", 'SecurityError');
      },
    });

  it('loadHistory() gives a message instead of throwing (the page calls it while starting up)', () => {
    block();
    let r: ReturnType<typeof loadHistory> | undefined;
    expect(() => (r = loadHistory())).not.toThrow();
    expect(r?.runs).toEqual([]);
    expect(r?.error).toMatch(/not available/);
  });

  it('saveHistory() gives a message instead of throwing', () => {
    block();
    let msg: string | undefined;
    expect(() => (msg = saveHistory([tinyRecord('a', at(0))]))).not.toThrow();
    expect(msg).toMatch(/not available/);
  });
});

describe('mergeRuns and sortRuns', () => {
  it('sortRuns: newest first, input untouched, equal times keep their order', () => {
    const a = tinyRecord('a', at(1));
    const b = tinyRecord('b', at(3));
    const c = tinyRecord('c', at(3));
    const input = [a, b, c];
    expect(sortRuns(input).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('adds new runs, skips ids already present (same id = same run), reports counts', () => {
    const existing = [tinyRecord('a', at(1)), tinyRecord('b', at(2))];
    const m = mergeRuns(existing, [tinyRecord('b', at(99)), tinyRecord('c', at(3))]);
    expect(m.runs.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(m.added).toBe(1);
    expect(m.dropped).toBe(0);
    expect(m.runs.find((r) => r.id === 'b')!.time).toBe(at(2)); // the saved one is kept
  });

  it('importing only runs already there changes nothing', () => {
    const existing = [tinyRecord('a', at(1)), tinyRecord('b', at(2))];
    const m = mergeRuns(existing, existing);
    expect(m).toEqual({ runs: sortRuns(existing), added: 0, tooOld: 0, dropped: 0 });
  });

  it('merging into an empty history', () => {
    const m = mergeRuns([], [tinyRecord('a', at(1)), tinyRecord('b', at(2))]);
    expect(m.runs.map((r) => r.id)).toEqual(['b', 'a']);
    expect(m.added).toBe(2);
  });

  it('the cap is 50: the oldest are dropped and counted', () => {
    expect(HISTORY_CAP).toBe(50);
    const existing = Array.from({ length: 48 }, (_, i) => tinyRecord(`e${i}`, at(100 + i)));
    const incoming = Array.from({ length: 5 }, (_, i) => tinyRecord(`i${i}`, at(200 + i)));
    const m = mergeRuns(existing, incoming);
    expect(m.runs).toHaveLength(50);
    expect(m.added).toBe(5);
    expect(m.tooOld).toBe(0);
    expect(m.dropped).toBe(3);
    expect(m.runs.map((r) => r.id)).toEqual([...incoming.map((r) => r.id).reverse(), ...existing.map((r) => r.id).reverse().slice(0, 45)]);
    expect(m.runs.some((r) => r.id === 'e0')).toBe(false); // the oldest is gone
  });

  it('an old run imported into a full history is itself dropped, not a newer one', () => {
    const existing = Array.from({ length: 50 }, (_, i) => tinyRecord(`e${i}`, at(100 + i)));
    const m = mergeRuns(existing, [tinyRecord('ancient', at(0))]);
    expect(m.runs.map((r) => r.id)).toEqual(sortRuns(existing).map((r) => r.id));
    expect(m.added).toBe(0);
    expect(m.tooOld).toBe(1); // the new run was cut, not a saved one
    expect(m.dropped).toBe(0);
  });

  it('counts: added (kept), tooOld (new runs cut at once) and dropped (saved runs pushed out) are separate', () => {
    // 48 saved (times 100..147); 5 new: 3 newer than all (kept), 2 older than all (cut at once).
    const existing = Array.from({ length: 48 }, (_, i) => tinyRecord(`e${i}`, at(100 + i)));
    const newer = Array.from({ length: 3 }, (_, i) => tinyRecord(`n${i}`, at(200 + i)));
    const older = Array.from({ length: 2 }, (_, i) => tinyRecord(`o${i}`, at(i)));
    const m = mergeRuns(existing, [...newer, ...older]);
    expect(m.runs).toHaveLength(HISTORY_CAP);
    expect(m.added).toBe(3);
    expect(m.tooOld).toBe(2);
    expect(m.dropped).toBe(1); // 48 + 3 = 51: the oldest saved run, e0, goes
    expect(m.runs.some((r) => r.id === 'e0')).toBe(false);
    expect(m.runs.some((r) => r.id.startsWith('o'))).toBe(false);
    // Every incoming run is accounted for exactly once.
    expect(m.added + m.tooOld).toBe(5);
  });

  it('runs already saved count in none of added, tooOld or dropped', () => {
    const existing = Array.from({ length: HISTORY_CAP }, (_, i) => tinyRecord(`e${i}`, at(100 + i)));
    const m = mergeRuns(existing, [existing[0]!, existing[49]!, tinyRecord('ancient', at(0))]);
    expect(m).toMatchObject({ added: 0, tooOld: 1, dropped: 0 });
    expect(m.runs.map((r) => r.id)).toEqual(sortRuns(existing).map((r) => r.id));
  });

  it('a newer-than-all import into a full history only pushes saved runs out', () => {
    const existing = Array.from({ length: HISTORY_CAP }, (_, i) => tinyRecord(`e${i}`, at(100 + i)));
    const m = mergeRuns(existing, [tinyRecord('x', at(500)), tinyRecord('y', at(501))]);
    expect(m).toMatchObject({ added: 2, tooOld: 0, dropped: 2 });
  });

  it('into an empty history, 51 new runs: 50 kept, the oldest is tooOld, nothing saved is dropped', () => {
    const incoming = Array.from({ length: HISTORY_CAP + 1 }, (_, i) => tinyRecord(`i${i}`, at(i)));
    expect(mergeRuns([], incoming)).toMatchObject({ added: HISTORY_CAP, tooOld: 1, dropped: 0 });
  });

  it('a new run saved after the last measurement goes first and pushes the oldest out at 50', () => {
    const existing = Array.from({ length: 50 }, (_, i) => tinyRecord(`e${i}`, at(i)));
    const m = mergeRuns(existing, [tinyRecord('now', at(1000))]);
    expect(m.runs).toHaveLength(50);
    expect(m.runs[0]!.id).toBe('now');
    expect(m.runs.some((r) => r.id === 'e0')).toBe(false);
  });

  it('orders by the moment in time, not by the text of the time (hand-edited files may carry an offset)', () => {
    const early = tinyRecord('early', '2026-11-01T10:00:00+05:00'); // 05:00Z
    const late = tinyRecord('late', '2026-11-01T08:00:00Z');
    expect(sortRuns([early, late]).map((r) => r.id)).toEqual(['late', 'early']);
  });
});
