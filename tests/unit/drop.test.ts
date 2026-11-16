// M7 round 2 (docs/SPEC.md, section 4, "Figures"): the burst -> sustained and sustained drop formulas, the noisy flag,
// the chart's 100 % and the figures a saved part carries. Pure functions over a window series; nothing asserts on speed.
//
// For a series of N windows, m = min(12, floor(N / 3)); minute 1 = [0, m), minute 2 = [m, 2m), last minute = [N - m, N).
// burst  = 1 - median(valid minute 2) / first valid window of minute 1
// drop   = 1 - median(valid last minute) / median(valid minute 2)
import { describe, expect, it } from 'vitest';
import { burstOf, chartBase, dropOf, figuresOf, groupsOf, MINUTE, noisyOf, NOISY_IQR, WINDOW_MS } from '../../src/lib/harness/drop.ts';

const nulls = (n: number) => Array<number | null>(n).fill(null);
const fill = (n: number, x: number | null) => Array<number | null>(n).fill(x);

describe('constants', () => {
  it('windows are 5 s, a minute is 12 windows, noisy means an IQR above 10 % of the median', () => {
    expect(WINDOW_MS).toBe(5_000);
    expect(MINUTE).toBe(12);
    expect(NOISY_IQR).toBe(0.1);
  });
});

describe('groupsOf: m = min(12, floor(N / 3))', () => {
  it('has no groups below 3 windows', () => {
    for (const n of [0, 1, 2]) expect(groupsOf(n)).toBeNull();
  });

  it('uses thirds for runs under 3 minutes, so the groups never overlap', () => {
    expect(groupsOf(3)).toEqual({ first: [0, 1], sustained: [1, 2], last: [2, 3] });
    expect(groupsOf(6)).toEqual({ first: [0, 2], sustained: [2, 4], last: [4, 6] }); // the 30 s test run
    expect(groupsOf(7)).toEqual({ first: [0, 2], sustained: [2, 4], last: [5, 7] });
    expect(groupsOf(35)).toEqual({ first: [0, 11], sustained: [11, 22], last: [24, 35] });
  });

  it('uses whole minutes from 3 minutes (36 windows) on', () => {
    expect(groupsOf(36)).toEqual({ first: [0, 12], sustained: [12, 24], last: [24, 36] });
    expect(groupsOf(120)).toEqual({ first: [0, 12], sustained: [12, 24], last: [108, 120] }); // 10 min
    expect(groupsOf(720)).toEqual({ first: [0, 12], sustained: [12, 24], last: [708, 720] }); // 60 min
  });

  it('never overlaps: first < sustained < last, for every length', () => {
    for (let n = 3; n <= 1000; n++) {
      const g = groupsOf(n)!;
      expect(g.first[1]).toBe(g.sustained[0]);
      expect(g.sustained[1]).toBeLessThanOrEqual(g.last[0]);
      expect(g.last[1]).toBe(n);
      expect(g.first[1] - g.first[0]).toBe(g.last[1] - g.last[0]);
    }
  });
});

describe('dropOf: 1 - median(last minute) / median(minute 2), valid windows only', () => {
  it('has no drop with fewer than 3 windows, valid or not', () => {
    expect(dropOf([])).toBeNull();
    expect(dropOf([1])).toBeNull();
    expect(dropOf([1, 0.5])).toBeNull();
  });

  it('three windows: minute 2 is the middle one, the last minute the last', () => {
    expect(dropOf([1, 0.8, 0.6])).toBeCloseTo(0.25, 12); // 1 - 0.6 / 0.8
    expect(dropOf([5, 1, 1.25])).toBeCloseTo(-0.25, 12); // faster at the end: negative
  });

  it('the 30 s test run: groups of two, the median of two is their mean', () => {
    // minute 2 = [1, 0.5] -> 0.75; last = [0.6, 0.4] -> 0.5
    expect(dropOf([9, 9, 1, 0.5, 0.6, 0.4])).toBeCloseTo(1 - 0.5 / 0.75, 12);
  });

  it('only valid windows count: an invalid one is not averaged in and does not shrink the group', () => {
    // [1, 1 | null, 0.9 | 0.8, 0.6]: minute 2 = [0.9] (0.9), last = [0.8, 0.6] (0.7)
    expect(dropOf([1, 1, null, 0.9, 0.8, 0.6])).toBeCloseTo(1 - 0.7 / 0.9, 12);
    // m = 3: minute 2 = [1, null, null] (1), last = [null, 0.5, 0.5] (0.5): the nulls neither count nor pull a median down
    expect(dropOf([1, 1, 1, 1, null, null, null, 0.5, 0.5])).toBeCloseTo(0.5, 12);
  });

  it('uses the median, not the mean: one wild window does not move the figure', () => {
    // m = 3: minute 2 = [0.9, 50, 0.9] -> 0.9; last = [0.8, 0, 0.8] -> 0.8
    expect(dropOf([1, 1, 1, 0.9, 50, 0.9, 0.8, 0, 0.8])).toBeCloseTo(1 - 0.8 / 0.9, 12);
  });

  it('is null when a group has no valid window', () => {
    expect(dropOf([1, 1, null, null, 0.5, 0.5])).toBeNull(); // minute 2 empty
    expect(dropOf([1, 1, 0.8, 0.8, null, null])).toBeNull(); // last minute empty
    expect(dropOf(nulls(6))).toBeNull();
    expect(dropOf(nulls(1000))).toBeNull();
  });

  it('is null when minute 2 is all zeros (no division by zero, no Infinity or NaN)', () => {
    expect(dropOf([0, 0, 0, 0, 1, 1])).toBeNull();
    expect(dropOf([1, 1, 1, 1, 0, 0])).toBe(1); // a last minute of zeros is a drop of 100 %
  });

  it('the first minute is not used at all', () => {
    expect(dropOf([100, 0, 1, 1, 0.5, 0.5])).toBeCloseTo(0.5, 12);
    expect(dropOf([null, null, 1, 1, 0.5, 0.5])).toBeCloseTo(0.5, 12);
  });

  it('whole minutes: windows 12..23 against the last 12; everything in between is ignored', () => {
    const v = [...fill(12, 1.5), ...fill(12, 1), ...fill(696, 0.2), ...fill(12, 0.9)] as number[];
    expect(v).toHaveLength(MINUTE * 2 + 696 + MINUTE);
    expect(dropOf(v)).toBeCloseTo(0.1, 12);
  });

  it('thirds under 3 minutes: windows between minute 2 and the last minute are ignored', () => {
    // N = 35, m = 11: minute 2 = [11, 22), last = [24, 35); windows 22 and 23 are in neither
    const v = [...fill(11, 3), ...fill(11, 1), 99, 99, ...fill(11, 0.5)] as number[];
    expect(v).toHaveLength(35);
    expect(dropOf(v)).toBeCloseTo(0.5, 12);
  });

  it('a flat series has drop 0, whatever its level and length', () => {
    expect(dropOf([1, 1, 1])).toBe(0);
    expect(dropOf(fill(7, 0.73) as number[])).toBe(0);
    expect(dropOf(fill(60, 1.2345) as number[])).toBe(0);
    expect(dropOf([1, null, 1, null, null, 1, 1])).toBe(0);
  });

  it('is scale-free, and does not change its input', () => {
    const v = [1, 0.97, 0.9, 0.85, 0.8, 0.78, 0.7, 0.69, 0.66];
    expect(dropOf(v.map((x) => x * 37))).toBeCloseTo(dropOf(v)!, 12);
    const w = [1, null, 0.5, 0.4, 0.3, null];
    const copy = [...w];
    dropOf(w);
    burstOf(w);
    noisyOf(w);
    expect(w).toEqual(copy);
  });
});

describe('burstOf: 1 - median(minute 2) / first valid window of minute 1', () => {
  it('has no burst with fewer than 3 windows', () => {
    expect(burstOf([])).toBeNull();
    expect(burstOf([1, 0.5])).toBeNull();
  });

  it('compares minute 2 with the very first valid window, not with minute 1\'s median', () => {
    // minute 1 = [1, 0.2]: its median would be 0.6, the first window is 1
    expect(burstOf([1, 0.2, 0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 12);
    expect(burstOf([1, 0.8, 0.6])).toBeCloseTo(0.2, 12);
  });

  it('is null when window 0 is invalid (a later window has already lost part of the boost)', () => {
    expect(burstOf([null, 0.8, 0.5, 0.5, 0.5, 0.5])).toBeNull();
  });

  it('is negative when minute 2 is faster than the first window', () => {
    expect(burstOf([0.5, 1, 1, 1, 1, 1])).toBeCloseTo(-1, 12);
  });

  it('only valid windows of minute 2 count', () => {
    expect(burstOf([1, 1, null, 0.8, 0.5, 0.5])).toBeCloseTo(0.2, 12);
  });

  it('is null when minute 1 or minute 2 has no valid window, or the first window is 0', () => {
    expect(burstOf([null, null, 0.5, 0.5, 0.5, 0.5])).toBeNull();
    expect(burstOf([1, 1, null, null, 0.5, 0.5])).toBeNull();
    expect(burstOf([0, 1, 1, 1, 1, 1])).toBeNull();
    expect(burstOf(nulls(6))).toBeNull();
  });

  it('does not need the last minute: burst is there when the drop is not', () => {
    expect(burstOf([1, 1, 0.8, 0.8, null, null])).toBeCloseTo(0.2, 12);
    expect(dropOf([1, 1, 0.8, 0.8, null, null])).toBeNull();
  });

  it('a flat series has burst 0', () => {
    expect(burstOf(fill(12, 1) as number[])).toBe(0);
  });

  it('the first window of minute 1 is meant: a later window of a long first minute is not', () => {
    const v = [2, ...fill(11, 1), ...fill(12, 1), ...fill(12, 1)] as number[];
    expect(burstOf(v)).toBeCloseTo(1 - 1 / 2, 12);
  });
});

describe('noisyOf: minute 2 or the last minute too uneven or too thin', () => {
  it('is false when there are no groups yet', () => {
    expect(noisyOf([])).toBe(false);
    expect(noisyOf([1, 0.5])).toBe(false);
  });

  it('is false for a flat, fully valid series, however far it drops', () => {
    expect(noisyOf([1, 1, 0.8, 0.8, 0.5, 0.5])).toBe(false);
    expect(noisyOf(fill(36, 1) as number[])).toBe(false);
  });

  it('is true when the interquartile range of minute 2 or of the last minute is above 10 % of its median', () => {
    expect(noisyOf([1, 1, 0.5, 1, 1, 1])).toBe(true); // minute 2 = [0.5, 1]: IQR 0.25 over median 0.75
    expect(noisyOf([1, 1, 1, 1, 0.5, 1])).toBe(true); // the same in the last minute
  });

  it('IQR is 10 % of the median at most: [1, 1.05, 1.1, 1.15] is fine, [1, 1.1, 1.2, 1.3] is not', () => {
    const calm = [1, 1, 1, 1, 1, 1.05, 1.1, 1.15, 1, 1, 1, 1];
    const rough = [1, 1, 1, 1, 1, 1.1, 1.2, 1.3, 1, 1, 1, 1];
    expect(noisyOf(calm)).toBe(false);
    expect(noisyOf(rough)).toBe(true);
  });

  it('the first minute never makes a series noisy (the burst is allowed to be wild)', () => {
    expect(noisyOf([5, 0.1, 1, 1, 1, 1])).toBe(false);
  });

  it('fewer than half the windows of minute 2 or the last minute valid: noisy; exactly half: not', () => {
    // N = 12, m = 4: minute 2 = windows 4..7, last = 8..11
    const base = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const half = base.slice() as (number | null)[];
    half[4] = null;
    half[5] = null;
    expect(noisyOf(half)).toBe(false); // 2 of 4
    half[6] = null;
    expect(noisyOf(half)).toBe(true); // 1 of 4
    const last = base.slice() as (number | null)[];
    last[8] = last[9] = last[10] = null;
    expect(noisyOf(last)).toBe(true);
  });

  it('an empty group, or one whose median is 0, is noisy', () => {
    expect(noisyOf([1, 1, null, null, 1, 1])).toBe(true);
    expect(noisyOf([1, 1, 1, 1, null, null])).toBe(true);
    expect(noisyOf([1, 1, 0, 0, 1, 1])).toBe(true);
    expect(noisyOf(nulls(6))).toBe(true);
  });
});

describe('chartBase: the chart\'s 100 %', () => {
  it('is the mean of the valid windows of minute 2', () => {
    expect(chartBase([1, 1, 0.5, 0.7, 9, 9])).toBeCloseTo(0.6, 12);
    expect(chartBase([1, 1, null, 0.7, 9, 9])).toBeCloseTo(0.7, 12);
    expect(chartBase([1, 1, 1, 1, 10, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(13 / 4, 12); // m = 4: mean of [1, 10, 1, 1]
  });

  it('before minute 2 exists it is the first valid window', () => {
    expect(chartBase([])).toBe(1);
    expect(chartBase([0.8])).toBe(0.8);
    expect(chartBase([null, 0.4])).toBe(0.4);
  });

  it('falls back to the first valid window when minute 2 has none or averages 0', () => {
    expect(chartBase([2, 1, null, null, 1, 1])).toBe(2);
    expect(chartBase([2, 1, 0, 0, 1, 1])).toBe(2);
  });

  it('is 1 when nothing is valid', () => {
    expect(chartBase(nulls(6))).toBe(1);
    expect(chartBase([0, 0, 0])).toBe(1);
  });
});

describe('figuresOf: what a saved part carries', () => {
  it('burst, drop and noisy of the series', () => {
    const v = [1, 1, 0.8, 0.8, 0.5, 0.5];
    expect(figuresOf(v)).toEqual({ burst: burstOf(v), drop: dropOf(v), noisy: noisyOf(v) });
    expect(figuresOf(v).burst).toBeCloseTo(0.2, 12);
    expect(figuresOf(v).drop).toBeCloseTo(1 - 0.5 / 0.8, 12);
    expect(figuresOf(v).noisy).toBe(false);
  });

  it('a part with an error has no figures, whatever its series says', () => {
    expect(figuresOf([1, 1, 0.8, 0.8, 0.5, 0.5], 'checksum mismatch')).toEqual({ burst: null, drop: null, noisy: false });
    expect(figuresOf([], 'worker init failed')).toEqual({ burst: null, drop: null, noisy: false });
  });

  it('an empty error string is still an error (the figures are not computed)', () => {
    expect(figuresOf([1, 1, 0.8, 0.8, 0.5, 0.5], '')).toEqual({ burst: null, drop: null, noisy: false });
  });

  it('a zero or empty group gives null, never NaN or Infinity', () => {
    for (const v of [[0, 0, 0, 0, 0, 0], nulls(6), [], [0, 0, 0]]) {
      const f = figuresOf(v);
      expect(f.burst).toBeNull();
      expect(f.drop).toBeNull();
    }
  });
});
