// M6 scoring rules in detail (docs/SPEC.md, section 6): the memory sub-scores, worker counts, missing constants,
// software GPUs, and "saved points are never trusted". Every number is made up; nothing asserts on speed.
import { describe, expect, it } from 'vitest';
import type { ComponentId } from '../../src/lib/bench/types.ts';
import { CONSTANTS, SCORE_VERSION } from '../../src/lib/scoring/constants.ts';
import { excluded, offCores, rescore, SCORED, scoreComponent } from '../../src/lib/scoring/score.ts';
import { exportText } from '../../src/lib/store/export.ts';
import { parseExport } from '../../src/lib/store/import.ts';
import { buildRecord } from '../../src/lib/store/record.ts';
import type { ComponentRecord, GpuTargetRecord, KernelRecord, RunRecord } from '../../src/lib/store/schema.ts';
import { completeRecord, completeView, SYSTEM } from './store-support.ts';

const HP: GpuTargetRecord = { preference: 'high-performance', label: 'Fast GPU', api: 'webgpu', info: {} };

const keysOf = (id: ComponentId): string[] =>
  Object.keys(CONSTANTS)
    .filter((k) => k.startsWith(`${id}/`))
    .map((k) => k.slice(id.length + 1));

const kr = (key: string, unit: string, value: number | null, over: Partial<KernelRecord> = {}): KernelRecord => ({
  key,
  unit,
  value,
  valid: value !== null,
  noisy: false,
  hidden: false,
  ...over,
});

/** Every kernel of `id` that has a constant, at its constant. */
function full(id: ComponentId, over: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id,
    kernels: keysOf(id).map((key) => {
      const ns = key.startsWith('mem_latency');
      return kr(key, ns ? 'ns' : 'u', CONSTANTS[`${id}/${key}`]!);
    }),
    points: null,
    partial: false,
    ...over,
  };
}

/** `f` times better on one key (ns: f times faster, so the value is divided). */
const better = (key: string, f: number) => (k: KernelRecord) => {
  if (k.key === key || (key === 'mem_latency' && k.key.startsWith('mem_latency'))) {
    k.value = k.unit === 'ns' ? k.value! / f : k.value! * f;
  }
};

describe('memory points: 1000 x geomean{fill, copy, copy_mt, latency sub-score}', () => {
  const mem = (...fns: ((k: KernelRecord) => void)[]) => {
    const c = full('memory');
    for (const k of c.kernels) for (const f of fns) f(k);
    return c;
  };

  it('has four sub-scores: fill, copy, copy_mt and ONE latency sub-score', () => {
    expect(keysOf('memory').filter((k) => k.startsWith('mem_latency'))).toHaveLength(17);
    // One of four sub-scores 16x better: geomean{16,1,1,1} = 2. (Counting the 17 sizes separately would give 16^(1/20).)
    for (const key of ['mem_fill', 'mem_copy', 'mem_copy_mt']) {
      expect(scoreComponent(mem(better(key, 16)), 'standard'), key).toEqual({ points: 2000, partial: false });
    }
    // All latency sizes 16x faster: the sub-score is 16, so the component is again geomean{1,1,1,16} = 2.
    expect(scoreComponent(mem(better('mem_latency', 16)), 'standard')).toEqual({ points: 2000, partial: false });
  });

  it('the latency sub-score is the geomean of its sizes', () => {
    // One size 16x faster: sub-score 16^(1/17); component geomean{1,1,1,sub} = 16^(1/68).
    const r = scoreComponent(mem(better('mem_latency:16384', 16)), 'standard');
    expect(r.points).toBe(Math.round(1000 * Math.pow(16, 1 / 68)));
    expect(r.partial).toBe(false);
  });

  it('a slower latency lowers memory points (ns is inverted)', () => {
    const r = scoreComponent(mem(better('mem_latency', 1 / 16)), 'standard');
    expect(r.points).toBe(500); // geomean{1,1,1,1/16} = 1/2
  });

  it('one missing or invalid latency size: the others carry the sub-score, the component is partial', () => {
    const bad = mem();
    Object.assign(bad.kernels.find((k) => k.key === 'mem_latency:16384')!, { valid: false, value: null });
    expect(scoreComponent(bad, 'standard')).toEqual({ points: 1000, partial: true });
    const gone = mem();
    gone.kernels = gone.kernels.filter((k) => k.key !== 'mem_latency:16384');
    expect(scoreComponent(gone, 'standard')).toEqual({ points: 1000, partial: true });
  });

  it('every latency size invalid: that sub-score is gone, the other three still score (partial)', () => {
    const c = mem((k) => {
      if (k.key.startsWith('mem_latency')) Object.assign(k, { valid: false, value: null });
    });
    expect(scoreComponent(c, 'standard')).toEqual({ points: 1000, partial: true });
  });

  it('copy_mt invalid: partial, still scored over the rest', () => {
    const c = mem();
    Object.assign(c.kernels.find((k) => k.key === 'mem_copy_mt')!, { valid: false, value: null });
    expect(scoreComponent(c, 'standard')).toEqual({ points: 1000, partial: true });
  });
});

describe('all-cores results and the worker count', () => {
  const withWorkers = (id: ComponentId, n: number, key?: string) => {
    const c = full(id);
    for (const k of c.kernels) if (key === undefined || k.key === key) k.workers = n;
    return c;
  };

  it('offCores: only when both numbers are known and differ', () => {
    const k = (workers?: number) => kr('sha256', 'u', 1, workers === undefined ? {} : { workers });
    expect(offCores(k(8), 16)).toBe(true);
    expect(offCores(k(16), 16)).toBe(false);
    expect(offCores(k(), 16)).toBe(false);
    expect(offCores(k(8), undefined)).toBe(false);
  });

  it('cpu-multi on a worker count other than the core count: no points, a note naming both numbers', () => {
    const c = withWorkers('cpu-multi', 4);
    expect(scoreComponent(c, 'standard', 16)).toMatchObject({ points: null, note: expect.stringMatching(/4 workers, not 16/) });
    expect(excluded(c, 'standard', 16)).toMatch(/4 workers, not 16/);
    expect(scoreComponent(withWorkers('cpu-multi', 16), 'standard', 16)).toEqual({ points: 1000, partial: false });
  });

  it('memory: only the all-cores copy is left out; the component keeps its points, is partial, and says why', () => {
    const c = withWorkers('memory', 4, 'mem_copy_mt');
    c.kernels.find((k) => k.key === 'mem_copy_mt')!.value = 1e12; // would change the score if it counted
    const r = scoreComponent(c, 'standard', 16);
    expect(r.points).toBe(1000);
    expect(r.partial).toBe(true);
    expect(r.note).toMatch(/4 workers, not 16/);
    expect(excluded(c, 'standard', 16)).toBeUndefined(); // memory as a whole is not excluded
  });

  it('memory with the all-cores copy on the core count is complete', () => {
    expect(scoreComponent(withWorkers('memory', 16, 'mem_copy_mt'), 'standard', 16)).toEqual({
      points: 1000,
      partial: false,
    });
  });

  it('the same rules apply when a record is rescored with its system.cores', () => {
    const v = completeView();
    for (const o of v.multiOutcomes) o.workers = 4;
    v.memMulti[0]!.workers = 4;
    const r = buildRecord(v, ['cpu-multi', 'memory'], 'quick', 'standard', SYSTEM); // SYSTEM.cores = 16
    const multi = r.components.find((c) => c.id === 'cpu-multi')!;
    const memory = r.components.find((c) => c.id === 'memory')!;
    expect(multi.points).toBeNull();
    expect(multi.note).toMatch(/4 workers, not 16/);
    expect(memory.points).toBe(1000);
    expect(memory.partial).toBe(true);
    expect(r.total).toBe(1000); // geomean of memory alone
    expect(r.partial).toBe(true);
  });
});

describe('missing constants and software GPUs', () => {
  it('a scored def without a constant makes its component partial; the others still score', () => {
    const table = CONSTANTS as Record<string, number>;
    const key = 'storage/storage_rand_read';
    const saved = table[key]!;
    try {
      delete table[key];
      // The def still exists, so a component without its constant is partial even though every record kernel is fine.
      expect(scoreComponent(full('storage'), 'standard')).toEqual({ points: 1000, partial: true });
    } finally {
      table[key] = saved;
    }
    expect(scoreComponent(full('storage'), 'standard')).toEqual({ points: 1000, partial: false });
  });

  it('every scored def has a constant: a complete component is never partial', () => {
    for (const id of SCORED) expect(scoreComponent(full(id), 'standard'), id).toEqual({ points: 1000, partial: false });
  });

  it('a software GPU adapter earns no points; a hardware one does', () => {
    const soft = full('gpu', { gpu: { ...HP, info: { software: 'true' } } });
    expect(scoreComponent(soft, 'standard')).toMatchObject({ points: null, note: expect.stringMatching(/software/) });
    expect(excluded(soft, 'standard')).toMatch(/software/);
    expect(scoreComponent(full('gpu', { gpu: { ...HP, info: { vendor: 'acme' } } }), 'standard').points).toBe(1000);
  });
});

describe('rescore: saved points are never trusted', () => {
  const lie = (r: RunRecord): RunRecord => ({
    ...r,
    total: 999999,
    partial: true,
    components: r.components.map((c) => ({ ...c, points: 999999, partial: true, note: 'a lie' })),
  });

  it('rewrites points, partial flags, notes and the total from the kernels', () => {
    const honest = completeRecord();
    expect(rescore(lie(honest))).toEqual(honest);
  });

  it('a 999999 file is corrected on import, and the corrected record re-exports unchanged', () => {
    const honest = completeRecord();
    const p = parseExport(exportText([lie(honest)]));
    if ('error' in p) throw new Error(p.error);
    expect(p.runs).toEqual([honest]);
    expect(p.runs[0]!.total).toBe(1000);
    expect(p.runs[0]!.components.every((c) => c.points === 1000 && !c.partial && c.note === undefined)).toBe(true);
  });

  it('a lie that hides partiality is corrected too', () => {
    const r = buildRecord(completeView(2), ['cpu-single'], 'quick', 'standard', SYSTEM);
    const back = rescore({ ...r, total: 999999, partial: false, components: r.components.map((c) => ({ ...c, points: 999999 })) });
    expect(back.components[0]!.points).toBe(2000);
    expect(back.total).toBe(2000);
    expect(back.partial).toBe(true);
  });

  it('smoke records lose any claimed points', () => {
    const r = completeRecord({ size: 'smoke' });
    const back = rescore({ ...r, total: 5000, partial: false, components: r.components.map((c) => ({ ...c, points: 5000 })) });
    expect(back.total).toBeNull();
    expect(back.components.every((c) => c.points === null && c.note === 'smoke: no points')).toBe(true);
  });

  it('another scoreVersion is returned as it is: saved points shown as saved, never recomputed', () => {
    const r = { ...completeRecord(), scoreVersion: SCORE_VERSION + 1, total: 777 };
    expect(rescore(r)).toBe(r);
    const p = parseExport(exportText([r]));
    if ('error' in p) throw new Error(p.error);
    expect(p.runs[0]!.total).toBe(777);
    expect(p.runs[0]!.components[0]!.points).toBe(r.components[0]!.points);
  });
});
