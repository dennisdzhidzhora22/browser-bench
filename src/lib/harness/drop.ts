// Endurance windows and the drop formula (docs/SPEC.md, 4). Pure: the store
// uses it to recompute saved drops, so it must not import worker code.

export const WINDOW_MS = 5_000;
/** Windows per minute: the drop compares the first and last minute. */
export const MINUTE = 60_000 / WINDOW_MS;

/**
 * Drop over the run: 1 - mean(last minute) / mean(first minute), over valid
 * windows only. A "minute" is the first / last min(12, floor(valid / 2))
 * valid windows, so short runs compare halves and the two never overlap.
 * Null with fewer than 2 valid windows.
 */
export function dropOf(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  const n = Math.min(MINUTE, Math.floor(v.length / 2));
  if (n < 1) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return 1 - mean(v.slice(-n)) / mean(v.slice(0, n));
}
