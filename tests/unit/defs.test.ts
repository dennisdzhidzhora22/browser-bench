// Structure of kernel defs and the small pure helpers of the memory tests.
import { describe, expect, it } from 'vitest';
import { components } from '../../src/lib/bench/components.ts';
import {
  formatBytes,
  LATENCY_HOPS,
  latencyDefs,
  latencyNs,
  memCopy,
  memFill,
  memoryKernels,
} from '../../src/lib/bench/memory/index.ts';
import { defKey, type KernelDef } from '../../src/lib/bench/types.ts';

const stub = (over: Partial<KernelDef>): KernelDef => ({
  id: 'x',
  name: 'X',
  stresses: 's',
  unit: 'u',
  seed: 1,
  sizes: { smoke: 1, standard: 2 },
  expected: { smoke: 0, standard: 0 },
  work: () => 1,
  ...over,
});

describe('defKey', () => {
  it('is the id alone when there is no variant', () => {
    expect(defKey(stub({ id: 'sha256' }))).toBe('sha256');
    expect(defKey(memFill)).toBe('mem_fill');
    expect(defKey(memCopy)).toBe('mem_copy');
  });

  it('is id:variant when there is one', () => {
    expect(defKey(stub({ id: 'mem_latency', variant: '16384' }))).toBe('mem_latency:16384');
    expect(defKey(latencyDefs[0]!)).toBe('mem_latency:16384');
    expect(defKey(latencyDefs[14]!)).toBe('mem_latency:268435456');
  });

  it('treats an empty variant like none (falsy)', () => {
    expect(defKey(stub({ id: 'a', variant: '' }))).toBe('a');
  });

  it('tells defs that share an id apart by variant', () => {
    expect(defKey(stub({ id: 'm', variant: '1' }))).not.toBe(defKey(stub({ id: 'm', variant: '2' })));
    expect(defKey(stub({ id: 'm', variant: '1' }))).not.toBe(defKey(stub({ id: 'm' })));
  });
});

describe('every def in components has a unique defKey', () => {
  it.each(components.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const keys = c.kernels.map(defKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.length).toBeGreaterThan(0);
  });

  it('the memory component lists fill, copy and 15 latency points with distinct keys', () => {
    const memory = components.find((c) => c.id === 'memory')!;
    expect(memory.kernels).toBe(memoryKernels);
    const keys = memory.kernels.map(defKey);
    expect(keys).toHaveLength(17);
    expect(keys.slice(0, 2)).toEqual(['mem_fill', 'mem_copy']);
    expect(keys.slice(2)).toEqual(latencyDefs.map((d) => `mem_latency:${d.sizes.standard}`));
  });

  it('the latency id is shared, so the id alone would not be unique', () => {
    const ids = memoryKernels.map((d) => d.id);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('every def that shares an id with another has a variant', () => {
    for (const c of components) {
      const counts = new Map<string, number>();
      for (const d of c.kernels) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
      for (const d of c.kernels) {
        if (counts.get(d.id)! > 1) expect(d.variant, `${c.id}/${d.id}`).toBeTruthy();
      }
    }
  });
});

describe('latencyNs', () => {
  it('is 1e9 / throughput (ns per hop from hops per second)', () => {
    expect(latencyNs(1e9)).toBe(1);
    expect(latencyNs(2e9)).toBe(0.5);
    expect(latencyNs(1e6)).toBe(1000);
    expect(latencyNs(1)).toBe(1e9);
  });

  it('is undefined when there is no usable throughput', () => {
    expect(latencyNs(undefined)).toBeUndefined();
    expect(latencyNs(0)).toBeUndefined();
    expect(latencyNs(-5)).toBeUndefined();
    expect(latencyNs(Number.NaN)).toBeUndefined();
  });

  it('agrees with the def: seconds per run x 1e9 / hops per run', () => {
    for (const d of latencyDefs) {
      for (const seconds of [0.25, 1, 3.5]) {
        const throughput = d.work(d.sizes.standard) / seconds; // hops/s, as the harness computes it
        expect(latencyNs(throughput)!).toBeCloseTo((seconds * 1e9) / LATENCY_HOPS, 6);
      }
    }
  });

  it('is monotonic: more hops per second is fewer ns per hop', () => {
    expect(latencyNs(2e8)!).toBeLessThan(latencyNs(1e8)!);
  });
});

describe('formatBytes', () => {
  it('uses KB below 1 MB and MB from 1 MB', () => {
    expect(formatBytes(16 * 1024)).toBe('16 KB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(1024 * 1024 - 1024)).toBe('1023 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(256 * 1024 * 1024)).toBe('256 MB');
  });

  it('labels the 15 latency sizes 16 KB ... 256 MB', () => {
    expect(latencyDefs.map((d) => formatBytes(d.sizes.standard))).toEqual([
      '16 KB',
      '32 KB',
      '64 KB',
      '128 KB',
      '256 KB',
      '512 KB',
      '1 MB',
      '2 MB',
      '4 MB',
      '8 MB',
      '16 MB',
      '32 MB',
      '64 MB',
      '128 MB',
      '256 MB',
    ]);
    expect(latencyDefs.map((d) => d.name)).toEqual(
      latencyDefs.map((d) => `Latency ${formatBytes(d.sizes.standard)}`),
    );
  });

  it('keeps a fractional MB value (not rounded)', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});
