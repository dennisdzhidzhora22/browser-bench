export interface SampleStats {
  median: number;
  min: number;
  max: number;
  /** (max - min) / median. 0 when there is one sample. */
  spread: number;
}

export function summarize(samples: Float64Array): SampleStats {
  if (samples.length === 0) throw new Error('summarize: no samples');
  const sorted = Float64Array.from(samples).sort();
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  return { median, min, max, spread: median > 0 ? (max - min) / median : 0 };
}

/**
 * The `k` fastest samples, ascending. Slow samples are mostly interference
 * (another process, a slow core, a clock dip), so results are taken from the
 * fastest ones (docs/SPEC.md, section 5).
 */
export function fastest(samples: Float64Array, k: number): Float64Array {
  if (k < 1) throw new Error('fastest: k must be at least 1');
  return Float64Array.from(samples).sort().subarray(0, Math.min(k, samples.length));
}

/**
 * Spread of the `k` fastest among the first `n` entries of `samples`, using
 * `scratch` (length >= n) so nothing is allocated. Used by the worker between
 * samples to decide whether to stop.
 */
export function fastestSpread(
  samples: Float64Array,
  n: number,
  k: number,
  scratch: Float64Array,
): number {
  for (let i = 0; i < n; i++) scratch[i] = samples[i]!;
  // Insertion sort: n is at most a few dozen, and it allocates nothing.
  for (let i = 1; i < n; i++) {
    const v = scratch[i]!;
    let j = i - 1;
    while (j >= 0 && scratch[j]! > v) {
      scratch[j + 1] = scratch[j]!;
      j--;
    }
    scratch[j + 1] = v;
  }
  const m = Math.min(k, n);
  const mid = m >> 1;
  const median = m % 2 === 1 ? scratch[mid]! : (scratch[mid - 1]! + scratch[mid]!) / 2;
  return median > 0 ? (scratch[m - 1]! - scratch[0]!) / median : 0;
}
