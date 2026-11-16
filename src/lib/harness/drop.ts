// Endurance windows and the figures read from a series (docs/SPEC.md, 4).
// Pure: the store uses it to recompute saved figures, so it must not import
// worker code.

export const WINDOW_MS = 5_000;
/** Windows per minute. */
export const MINUTE = 60_000 / WINDOW_MS;
/** A group whose interquartile range exceeds this fraction of its median makes the figures noisy. */
export const NOISY_IQR = 0.1;

type Range = [from: number, to: number];

/**
 * The three groups the figures compare, as window-index ranges [from, to).
 * With m = min(12, floor(N / 3)) for a series of N windows:
 *   first     = [0, m)        (minute 1; the burst is its first valid window)
 *   sustained = [m, 2m)       (minute 2)
 *   last      = [N - m, N)    (the last minute)
 * Runs of 3 minutes or more use whole minutes; shorter runs use thirds, so
 * the groups never overlap. Null when N < 3.
 */
export function groupsOf(n: number): { first: Range; sustained: Range; last: Range } | null {
  const m = Math.min(MINUTE, Math.floor(n / 3));
  if (m < 1) return null;
  return { first: [0, m], sustained: [m, 2 * m], last: [n - m, n] };
}

const validIn = (values: readonly (number | null)[], [from, to]: Range) => {
  const v: number[] = [];
  for (let i = from; i < to; i++) {
    const x = values[i];
    if (x !== null && x !== undefined) v.push(x);
  }
  return v;
};

/** Linear-interpolated quantile of an ascending, non-empty list (q in [0, 1]). */
function quantile(sorted: readonly number[], q: number): number {
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (p - lo);
}

const median = (v: readonly number[]) => (v.length ? quantile([...v].sort((a, b) => a - b), 0.5) : undefined);

/** 1 - b / a, or null when that is not a finite number (no data, or a zero base). */
const fall = (a: number | undefined, b: number | undefined): number | null => {
  if (a === undefined || b === undefined || !(a > 0)) return null;
  const d = 1 - b / a;
  return Number.isFinite(d) ? d : null;
};

/**
 * Sustained drop: 1 - median(last minute) / median(minute 2), over valid
 * windows only (groupsOf). This is the figure that follows heat. Null when a
 * group has no valid window or minute 2's median is 0. Positive = slower at
 * the end.
 */
export function dropOf(values: readonly (number | null)[]): number | null {
  const g = groupsOf(values.length);
  if (!g) return null;
  return fall(median(validIn(values, g.sustained)), median(validIn(values, g.last)));
}

/**
 * Burst to sustained: 1 - median(minute 2) / the first valid window of
 * minute 1. Mostly the CPU's short power boost running out in the first
 * seconds, not heat. Null as for dropOf.
 */
export function burstOf(values: readonly (number | null)[]): number | null {
  const g = groupsOf(values.length);
  if (!g) return null;
  return fall(validIn(values, g.first)[0], median(validIn(values, g.sustained)));
}

/**
 * True when minute 2 or the last minute is too uneven to trust the figures:
 * fewer than half its windows valid, or an interquartile range above
 * NOISY_IQR of its median. False when there are no groups yet.
 */
export function noisyOf(values: readonly (number | null)[]): boolean {
  const g = groupsOf(values.length);
  if (!g) return false;
  for (const r of [g.sustained, g.last]) {
    const v = validIn(values, r).sort((a, b) => a - b);
    if (v.length === 0 || v.length * 2 < r[1] - r[0]) return true;
    const mid = quantile(v, 0.5);
    if (!(mid > 0) || (quantile(v, 0.75) - quantile(v, 0.25)) / mid > NOISY_IQR) return true;
  }
  return false;
}

/** The chart's 100 %: mean of the valid windows of minute 2, else the first valid window, else 1. */
export function chartBase(values: readonly (number | null)[]): number {
  const g = groupsOf(values.length);
  const s = g ? validIn(values, g.sustained) : [];
  if (s.length) {
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    if (mean > 0) return mean;
  }
  for (const x of values) if (x !== null && x > 0) return x;
  return 1;
}

/** The figures a saved part carries, all recomputed on load. A part with an error has none. */
export function figuresOf(
  values: readonly (number | null)[],
  error?: string,
): { burst: number | null; drop: number | null; noisy: boolean } {
  if (error !== undefined) return { burst: null, drop: null, noisy: false };
  return { burst: burstOf(values), drop: dropOf(values), noisy: noisyOf(values) };
}
