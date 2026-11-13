import { describe, expect, it } from 'vitest';
import { fastest, fastestSpread, summarize } from '../../src/lib/harness/stats.ts';

describe('summarize', () => {
  it('handles an odd number of samples', () => {
    const s = summarize(Float64Array.of(3, 1, 2));
    expect(s.median).toBe(2);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.spread).toBeCloseTo((3 - 1) / 2, 12);
  });

  it('averages the middle pair for an even number of samples', () => {
    const s = summarize(Float64Array.of(1, 2, 3, 10));
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.spread).toBeCloseTo((10 - 1) / 2.5, 12);
  });

  it('handles a single sample with zero spread', () => {
    const s = summarize(Float64Array.of(42));
    expect(s).toEqual({ median: 42, min: 42, max: 42, spread: 0 });
  });

  it('handles two samples', () => {
    const s = summarize(Float64Array.of(4, 2));
    expect(s.median).toBe(3);
    expect(s.min).toBe(2);
    expect(s.max).toBe(4);
  });

  it('sorts numerically, not lexicographically', () => {
    const s = summarize(Float64Array.of(100, 9, 20, 3, 1000));
    expect(s.median).toBe(20);
    expect(s.min).toBe(3);
    expect(s.max).toBe(1000);
  });

  it('gives the same result for sorted, reversed and shuffled input', () => {
    const a = summarize(Float64Array.of(1, 2, 3, 4, 5));
    const b = summarize(Float64Array.of(5, 4, 3, 2, 1));
    const c = summarize(Float64Array.of(3, 5, 1, 4, 2));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('has zero spread when all samples are equal', () => {
    const s = summarize(Float64Array.of(7, 7, 7, 7));
    expect(s.median).toBe(7);
    expect(s.spread).toBe(0);
  });

  it('has zero spread when the median is 0 (no division by zero)', () => {
    const s = summarize(Float64Array.of(0, 0, 5));
    expect(s.median).toBe(0);
    expect(s.spread).toBe(0);
    expect(Number.isFinite(s.spread)).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = Float64Array.of(3, 1, 2);
    summarize(input);
    expect(Array.from(input)).toEqual([3, 1, 2]);
  });

  it('throws on empty input', () => {
    expect(() => summarize(new Float64Array(0))).toThrow(/no samples/);
  });
});

describe('fastest', () => {
  it('returns the k fastest samples, ascending', () => {
    expect(Array.from(fastest(Float64Array.of(9, 3, 7, 1, 5), 3))).toEqual([1, 3, 5]);
  });

  it('returns all samples, sorted, when n < k', () => {
    expect(Array.from(fastest(Float64Array.of(4, 2, 3), 7))).toEqual([2, 3, 4]);
  });

  it('returns everything when k equals n', () => {
    expect(Array.from(fastest(Float64Array.of(2, 1), 2))).toEqual([1, 2]);
  });

  it('k = 1 gives the minimum', () => {
    expect(Array.from(fastest(Float64Array.of(5, 2, 8), 1))).toEqual([2]);
  });

  it('sorts numerically, not lexicographically', () => {
    expect(Array.from(fastest(Float64Array.of(100, 9, 20, 3), 3))).toEqual([3, 9, 20]);
  });

  it('keeps duplicates', () => {
    expect(Array.from(fastest(Float64Array.of(2, 2, 2, 9), 3))).toEqual([2, 2, 2]);
  });

  it('does not mutate its input', () => {
    const input = Float64Array.of(3, 1, 2);
    fastest(input, 2);
    expect(Array.from(input)).toEqual([3, 1, 2]);
  });

  it('throws for k < 1', () => {
    expect(() => fastest(Float64Array.of(1, 2), 0)).toThrow(/at least 1/);
    expect(() => fastest(Float64Array.of(1, 2), -1)).toThrow(/at least 1/);
  });

  it('on empty input returns an empty array (summarize then rejects it)', () => {
    expect(fastest(new Float64Array(0), 3)).toHaveLength(0);
    expect(() => summarize(fastest(new Float64Array(0), 3))).toThrow(/no samples/);
  });
});

describe('fastestSpread', () => {
  const spreadOf = (samples: number[], n: number, k: number) =>
    fastestSpread(Float64Array.from(samples), n, k, new Float64Array(samples.length));

  it('matches summarize(fastest(...)).spread', () => {
    const cases: Array<[number[], number]> = [
      [[10, 12, 11, 40, 90, 13], 3],
      [[10, 12, 11, 40, 90, 13], 4],
      [[5, 5, 5, 5], 3],
      [[100, 101, 99, 250, 300, 98, 102, 103, 500], 7],
      [[1, 2], 2],
      [[8, 3, 5, 1], 1],
    ];
    for (const [samples, k] of cases) {
      const expected = summarize(fastest(Float64Array.from(samples), k)).spread;
      expect(spreadOf(samples, samples.length, k)).toBeCloseTo(expected, 12);
    }
  });

  it('only looks at the first n entries', () => {
    // Entries past n are stale scratch-like data and must be ignored.
    const samples = [10, 11, 12, 1, 1, 1];
    const expected = summarize(fastest(Float64Array.of(10, 11, 12), 3)).spread;
    expect(spreadOf(samples, 3, 3)).toBeCloseTo(expected, 12);
  });

  it('with n < k uses all n samples', () => {
    const expected = summarize(Float64Array.of(10, 20)).spread;
    expect(spreadOf([20, 10], 2, 7)).toBeCloseTo(expected, 12);
    expect(expected).toBeGreaterThan(0);
  });

  it('is 0 for one sample and for identical samples', () => {
    expect(spreadOf([42], 1, 3)).toBe(0);
    expect(spreadOf([7, 7, 7], 3, 3)).toBe(0);
  });

  it('is 0 when the median is 0 (no division by zero)', () => {
    const s = spreadOf([0, 0, 5], 3, 3);
    expect(s).toBe(0);
    expect(Number.isFinite(s)).toBe(true);
  });

  it('ignores slow outliers outside the k fastest', () => {
    expect(spreadOf([100, 100, 100, 9999], 4, 3)).toBe(0);
  });

  it('does not modify the samples array, only scratch', () => {
    const samples = Float64Array.of(3, 1, 2);
    const scratch = new Float64Array(3);
    fastestSpread(samples, 3, 3, scratch);
    expect(Array.from(samples)).toEqual([3, 1, 2]);
    expect(Array.from(scratch)).toEqual([1, 2, 3]);
  });

  it('works with scratch larger than n', () => {
    const scratch = new Float64Array(10).fill(-1);
    const s = fastestSpread(Float64Array.of(10, 12, 11, 50), 3, 3, scratch);
    expect(s).toBeCloseTo((12 - 10) / 11, 12);
  });
});
