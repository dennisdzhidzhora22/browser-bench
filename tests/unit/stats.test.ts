import { describe, expect, it } from 'vitest';
import { summarize } from '../../src/lib/harness/stats.ts';

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
