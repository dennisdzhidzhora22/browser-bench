// Points maths (docs/SPEC.md, section 6, "How it works (M6)"): geometric means, direction of units, partial
// flags, the components that earn no points, the GPU "Both" rule, and the constants table against the defs.
// Nothing here asserts on speed: every number is made up.
import { afterEach, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { gpuKernels, webgpuKernels } from '../../src/lib/bench/gpu/index.ts';
import { latencyDefs, memCopyMulti, memoryKernels } from '../../src/lib/bench/memory/index.ts';
import { storageKernels } from '../../src/lib/bench/storage/index.ts';
import { defKey, type ComponentId, type KernelDef } from '../../src/lib/bench/types.ts';
import { CONSTANTS, LOWER_IS_BETTER, SCORE_VERSION } from '../../src/lib/scoring/constants.ts';
import {
  counted,
  excluded,
  geomean,
  references,
  refsFor,
  SCORED,
  scoreComponent,
  scoreTotal,
  type Reference,
} from '../../src/lib/scoring/score.ts';
import type { ComponentRecord, GpuTargetRecord, KernelRecord } from '../../src/lib/store/schema.ts';

const keysOf = (id: ComponentId): string[] =>
  Object.keys(CONSTANTS)
    .filter((k) => k.startsWith(`${id}/`))
    .map((k) => k.slice(id.length + 1));
const unitOf = (key: string) => (key.startsWith('mem_latency') ? 'ns' : 'u');

const kr = (key: string, unit: string, value: number | null, over: Partial<KernelRecord> = {}): KernelRecord => ({
  key,
  unit,
  value,
  valid: value !== null,
  noisy: false,
  hidden: false,
  ...over,
});

/** Every kernel of `id` that has a constant, scoring `scale` times its constant (ns: constant / scale). */
function full(id: ComponentId, scale = 1, over: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id,
    kernels: keysOf(id).map((key) => {
      const c = CONSTANTS[`${id}/${key}`]!;
      return kr(key, unitOf(key), unitOf(key) === 'ns' ? c / scale : c * scale);
    }),
    points: null,
    partial: false,
    ...over,
  };
}

const one = (id: ComponentId, k: KernelRecord, over: Partial<ComponentRecord> = {}): ComponentRecord => ({
  id,
  kernels: [k],
  points: null,
  partial: false,
  ...over,
});

const HP: GpuTargetRecord = { preference: 'high-performance', label: 'Fast GPU', api: 'webgpu', info: {} };
const LP: GpuTargetRecord = { preference: 'low-power', label: 'Slow GPU', api: 'webgpu', info: {} };

describe('geomean', () => {
  it('is the nth root of the product', () => {
    expect(geomean([4])).toBeCloseTo(4, 12);
    expect(geomean([1, 4])).toBeCloseTo(2, 12);
    expect(geomean([2, 8])).toBeCloseTo(4, 12);
    expect(geomean([1, 1, 1, 16])).toBeCloseTo(2, 12);
  });

  it('does not depend on the order, and ones change nothing', () => {
    expect(geomean([3, 5, 7])).toBeCloseTo(geomean([7, 3, 5]), 12);
    expect(geomean([3, 5, 7, 1, 1])).toBeCloseTo(Math.pow(105, 1 / 5), 12);
  });
});

describe('constants table', () => {
  it('SCORE_VERSION is a positive integer; every constant is a positive finite number', () => {
    expect(Number.isInteger(SCORE_VERSION)).toBe(true);
    expect(SCORE_VERSION).toBeGreaterThanOrEqual(1);
    for (const [k, v] of Object.entries(CONSTANTS)) {
      expect(Number.isFinite(v) && v > 0, k).toBe(true);
    }
  });

  it('only latency (ns) is lower-is-better', () => {
    expect([...LOWER_IS_BETTER]).toEqual(['ns']);
  });

  const DEFS: Record<ComponentId, readonly KernelDef[]> = {
    'cpu-single': cpuKernels,
    'cpu-multi': cpuKernels,
    memory: [...memoryKernels, memCopyMulti],
    gpu: webgpuKernels, // the WebGL2 fallback earns no points, so it has no constant
    storage: storageKernels,
  };

  it.each(Object.entries(DEFS))('%s: every def has a constant', (id, defs) => {
    for (const d of defs) expect(CONSTANTS, `${id}/${defKey(d)}`).toHaveProperty([`${id}/${defKey(d)}`]);
  });

  it('every constant belongs to a def: no stale or misspelled keys (the fallback has none)', () => {
    const expected = Object.entries(DEFS)
      .flatMap(([id, defs]) => defs.map((d) => `${id}/${defKey(d)}`))
      .sort();
    expect(Object.keys(CONSTANTS).sort()).toEqual(expected);
    for (const d of gpuKernels.filter((g) => !webgpuKernels.includes(g))) {
      expect(CONSTANTS, d.id).not.toHaveProperty([`gpu/${defKey(d)}`]);
    }
  });

  it('covers the SIMD variants, the 17 latency sizes, the all-cores copy and the four storage tests', () => {
    const simd = cpuKernels.filter((d) => d.simd);
    expect(simd.length).toBeGreaterThan(0);
    for (const d of simd) {
      expect(CONSTANTS).toHaveProperty([`cpu-single/${defKey(d)}`]);
      expect(CONSTANTS).toHaveProperty([`cpu-multi/${defKey(d)}`]);
    }
    expect(latencyDefs).toHaveLength(17);
    expect(keysOf('memory').filter((k) => k.startsWith('mem_latency:'))).toHaveLength(17);
    expect(keysOf('memory')).toContain('mem_copy_mt');
    expect(keysOf('storage')).toHaveLength(4);
    expect(SCORED).toEqual(['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage']);
  });

  it('no def other than latency has a lower-is-better unit', () => {
    for (const d of Object.values(DEFS).flat()) {
      if (d.id !== 'mem_latency') expect(LOWER_IS_BETTER.has(d.unit), defKey(d)).toBe(false);
    }
  });
});

describe('scoreComponent', () => {
  it.each(SCORED)('%s: every kernel at its constant is exactly 1000 points, not partial', (id) => {
    expect(scoreComponent(full(id), 'standard')).toEqual({ points: 1000, partial: false });
  });

  it('twice the constant everywhere (latency: half the time) is 2000; half is 500', () => {
    expect(scoreComponent(full('memory', 2), 'standard').points).toBe(2000);
    expect(scoreComponent(full('memory', 0.5), 'standard').points).toBe(500);
    expect(scoreComponent(full('storage', 2), 'standard').points).toBe(2000);
  });

  it('is a geometric mean, not an average: ratios 1, 1, 1, 16 give 2000', () => {
    const c = full('storage');
    c.kernels[3]!.value = CONSTANTS['storage/storage_rand_read']! * 16;
    expect(scoreComponent(c, 'standard')).toEqual({ points: 2000, partial: false });
  });

  it('ns is inverted: a slower latency scores below 1000, a faster one above', () => {
    const lat = (v: number) => one('memory', kr('mem_latency:16384', 'ns', v));
    const c = CONSTANTS['memory/mem_latency:16384']!;
    expect(scoreComponent(lat(c * 2), 'standard').points).toBe(500);
    expect(scoreComponent(lat(c / 2), 'standard').points).toBe(2000);
    expect(scoreComponent(lat(c), 'standard').points).toBe(1000);
  });

  it.each(['MB/s', 'IOPS', 'GB/s', 'GFLOP/s', 'MFLOP/s', 'hops/s', 'u'])(
    'unit %s is higher-is-better: twice the constant is 2000, half is 500',
    (unit) => {
      const c = CONSTANTS['cpu-single/sha256']!;
      expect(scoreComponent(one('cpu-single', kr('sha256', unit, c * 2)), 'standard').points).toBe(2000);
      expect(scoreComponent(one('cpu-single', kr('sha256', unit, c / 2)), 'standard').points).toBe(500);
    },
  );

  it('a missing kernel makes the component partial, and the others still count', () => {
    const c = full('storage', 2);
    c.kernels.pop();
    expect(scoreComponent(c, 'standard')).toEqual({ points: 2000, partial: true });
  });

  it('invalid, hidden, null, zero and negative results are excluded and mark the component partial', () => {
    const base = () => full('storage', 2);
    const cases: [string, Partial<KernelRecord>][] = [
      ['invalid with a number', { valid: false, value: 1e9 }],
      ['hidden', { valid: false, hidden: true, value: null }],
      ['valid but null', { valid: true, value: null }],
      ['zero', { value: 0 }],
      ['negative', { value: -5 }],
    ];
    for (const [name, patch] of cases) {
      const c = base();
      Object.assign(c.kernels[0]!, patch);
      // The other three still score twice their constant: the bad one is left out, not counted as 0 or 1e9.
      expect(scoreComponent(c, 'standard'), name).toEqual({ points: 2000, partial: true });
    }
  });

  it('a noisy but valid kernel still counts and does not make the component partial', () => {
    const c = full('storage', 2);
    c.kernels[0]!.noisy = true;
    expect(scoreComponent(c, 'standard')).toEqual({ points: 2000, partial: false });
  });

  it('no valid kernel at all: no points, a note, partial', () => {
    const c = full('storage');
    for (const k of c.kernels) Object.assign(k, { valid: false, value: null });
    const r = scoreComponent(c, 'standard');
    expect(r.points).toBeNull();
    expect(r.partial).toBe(true);
    expect(r.note).toBe('no valid results');
    const empty = scoreComponent({ id: 'gpu', kernels: [], points: null, partial: false, error: 'x' }, 'standard');
    expect(empty.points).toBeNull();
    expect(empty.partial).toBe(true);
  });

  it('a kernel without a constant is ignored: it neither scores nor makes the component partial', () => {
    const c = full('storage', 2);
    c.kernels.push(kr('storage_made_up', 'MB/s', 1));
    expect(scoreComponent(c, 'standard')).toEqual({ points: 2000, partial: false });
  });

  it('keys are looked up per component: cpu-multi kernels never score as cpu-single', () => {
    const k = kr('sha256', 'u', CONSTANTS['cpu-multi/sha256']!);
    const single = scoreComponent(one('cpu-single', k), 'standard').points!;
    const multi = scoreComponent(one('cpu-multi', k), 'standard').points!;
    expect(multi).toBe(1000);
    expect(single).not.toBe(1000);
  });

  it('smoke, the WebGL2 fallback and a scaled-down storage file earn no points', () => {
    expect(scoreComponent(full('cpu-single'), 'smoke')).toMatchObject({ points: null, note: 'smoke: no points' });
    expect(scoreComponent(full('gpu', 1, { gpu: { ...HP, api: 'webgl2' } }), 'standard')).toMatchObject({
      points: null,
      note: expect.stringMatching(/fallback/),
    });
    expect(scoreComponent(full('storage', 1, { scaled: true, fileBytes: 16 * 1024 * 1024 }), 'standard')).toMatchObject({
      points: null,
      note: expect.stringMatching(/smaller/),
    });
    // The same components at standard size, WebGPU, full-size file do score.
    expect(scoreComponent(full('gpu', 1, { gpu: HP }), 'standard').points).toBe(1000);
    expect(scoreComponent(full('storage', 1, { scaled: false }), 'standard').points).toBe(1000);
  });

  it('excluded(): smoke wins over the other reasons; nothing for a plain component', () => {
    expect(excluded(full('storage', 1, { scaled: true }), 'smoke')).toBe('smoke: no points');
    expect(excluded(full('cpu-single'), 'standard')).toBeUndefined();
    expect(excluded(full('gpu', 1, { gpu: HP }), 'standard')).toBeUndefined();
    expect(excluded(full('gpu', 1, { gpu: { ...LP, api: 'webgl2' } }), 'standard')).toMatch(/fallback/);
  });
});

describe('scoreTotal', () => {
  const pts = (id: ComponentId, points: number | null, over: Partial<ComponentRecord> = {}): ComponentRecord => ({
    id,
    kernels: [],
    points,
    partial: false,
    ...over,
  });
  const all = (a: number, b: number, c: number, d: number, e: number) => [
    pts('cpu-single', a),
    pts('cpu-multi', b),
    pts('memory', c),
    pts('gpu', d, { gpu: HP }),
    pts('storage', e),
  ];

  it('all five complete: the geometric mean, not partial', () => {
    expect(scoreTotal(all(1000, 1000, 1000, 1000, 1000))).toEqual({ total: 1000, partial: false });
    // (2000 * 2000 * 500 * 500 * 1000)^(1/5) = (1e15)^(1/5) = 1000
    expect(scoreTotal(all(2000, 2000, 500, 500, 1000))).toEqual({ total: 1000, partial: false });
  });

  it('a missing component leaves the total partial; it is the geomean of the rest', () => {
    const four = all(1000, 1000, 1000, 1000, 1000).slice(0, 4);
    expect(scoreTotal(four)).toEqual({ total: 1000, partial: true });
    expect(scoreTotal([pts('cpu-single', 4000), pts('memory', 1000)])).toEqual({ total: 2000, partial: true });
  });

  it('a component without points counts as missing: partial, and left out of the mean', () => {
    expect(scoreTotal(all(1000, 1000, 1000, 1000, 1000).map((c, i) => (i === 4 ? pts('storage', null) : c)))).toEqual({
      total: 1000,
      partial: true,
    });
  });

  it('a partial component makes the total partial but still counts', () => {
    const list = all(1000, 1000, 1000, 1000, 4000);
    list[4]!.partial = true;
    const t = scoreTotal(list);
    expect(t.partial).toBe(true);
    expect(t.total).toBe(Math.round(Math.pow(1000 ** 4 * 4000, 1 / 5)));
  });

  it('nothing to count: no total, partial', () => {
    expect(scoreTotal([])).toEqual({ total: null, partial: true });
    expect(scoreTotal(all(0, 0, 0, 0, 0).map((c) => ({ ...c, points: null })))).toEqual({ total: null, partial: true });
  });

  it('GPU "Both": only the high-performance target counts, whatever the order', () => {
    const fast = pts('gpu', 1000, { gpu: HP });
    const slow = pts('gpu', 4000, { gpu: LP });
    const rest = [pts('cpu-single', 1000), pts('cpu-multi', 1000), pts('memory', 1000), pts('storage', 1000)];
    expect(scoreTotal([...rest, fast, slow])).toEqual({ total: 1000, partial: false });
    expect(scoreTotal([...rest, slow, fast])).toEqual({ total: 1000, partial: false });
    expect(counted([slow, fast], 'gpu')).toBe(fast);
    expect(counted([fast, slow], 'gpu')).toBe(fast);
  });

  it('a lone power-saving GPU (the user picked it) counts; a missing id counts as nothing', () => {
    const slow = pts('gpu', 4000, { gpu: LP });
    expect(counted([slow], 'gpu')).toBe(slow);
    expect(counted([slow], 'storage')).toBeUndefined();
    expect(counted([], 'gpu')).toBeUndefined();
    expect(scoreTotal([slow, pts('cpu-single', 1000)])).toEqual({
      total: Math.round(Math.sqrt(4000 * 1000)),
      partial: true,
    });
  });

  it('the total is rounded to a whole number', () => {
    const t = scoreTotal([pts('cpu-single', 1000), pts('memory', 1001)]);
    expect(Number.isInteger(t.total)).toBe(true);
    expect(t.total).toBe(1000);
  });
});

describe('references and scoreVersion', () => {
  const entry = (scoreVersion: number, name = `ref-v${scoreVersion}`): Reference => ({
    name,
    scoreVersion,
    results: {},
    points: { total: 1234 },
  });
  const original = references.length;
  afterEach(() => references.splice(original));

  it('every shipped entry is well-formed, and refsFor only offers this build version', () => {
    for (const r of references) {
      expect(typeof r.name).toBe('string');
      expect(Number.isInteger(r.scoreVersion)).toBe(true);
      expect(typeof r.results).toBe('object');
      expect(typeof r.points).toBe('object');
    }
    expect(refsFor(SCORE_VERSION).every((r) => r.scoreVersion === SCORE_VERSION)).toBe(true);
  });

  it('entries of this build scoreVersion are offered for results of this version', () => {
    references.push(entry(SCORE_VERSION, 'mine'), entry(SCORE_VERSION + 1, 'future'), entry(0, 'ancient'));
    const names = refsFor(SCORE_VERSION).map((r) => r.name);
    expect(names).toContain('mine');
    expect(names).not.toContain('future');
    expect(names).not.toContain('ancient');
  });

  it('results of any other scoreVersion are never compared, even with a reference of that same version', () => {
    references.push(entry(SCORE_VERSION), entry(SCORE_VERSION + 1), entry(99), entry(0));
    for (const v of [SCORE_VERSION + 1, 99, 0, SCORE_VERSION - 1, -1]) {
      expect(refsFor(v), `v${v}`).toEqual([]);
    }
  });
});
