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
