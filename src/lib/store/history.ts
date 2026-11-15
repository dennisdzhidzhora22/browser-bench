// Run history in localStorage, under one key, newest first (docs/SPEC.md, D9).
// Saving happens after a run, never during a measurement. Errors (full or
// disabled storage, corrupt data) come back as messages; nothing throws.

import { exportText } from './export.ts';
import { parseExport } from './import.ts';
import type { RunRecord } from './schema.ts';

export const HISTORY_KEY = 'browser-bench:history';
export const HISTORY_CAP = 50;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Read inside each try: with site data blocked, the `localStorage` property itself throws. */
const local = (): Store => globalThis.localStorage;

export function loadHistory(store?: Store): { runs: RunRecord[]; error?: string } {
  let text: string | null;
  try {
    text = (store ?? local()).getItem(HISTORY_KEY);
  } catch {
    return { runs: [], error: 'Saved history is not available: this browser blocks local storage here.' };
  }
  if (text === null) return { runs: [] };
  const p = parseExport(text);
  if ('error' in p) {
    return {
      runs: [],
      error: `Saved history could not be read (${p.error}) The next saved run replaces it.`,
    };
  }
  return { runs: sortRuns(p.runs).slice(0, HISTORY_CAP) };
}

/** Writes `runs`; returns an error message, or undefined on success. */
export function saveHistory(runs: readonly RunRecord[], store?: Store): string | undefined {
  try {
    const s = store ?? local();
    if (runs.length === 0) s.removeItem(HISTORY_KEY);
    else s.setItem(HISTORY_KEY, exportText(runs, 0));
    return undefined;
  } catch (err) {
    return err instanceof DOMException && err.name === 'QuotaExceededError'
      ? 'Could not save to history: browser storage for this page is full. Export and delete old runs.'
      : 'Could not save to history: local storage is not available.';
  }
}

/** Newest first, by the moment in time (not the text). */
export function sortRuns(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

/**
 * Adds runs not already present (by id), newest first, capped. `added` counts
 * new runs that were kept, `tooOld` new runs the cap cut at once, `dropped`
 * saved runs the cap pushed out.
 */
export function mergeRuns(
  existing: readonly RunRecord[],
  incoming: readonly RunRecord[],
): { runs: RunRecord[]; added: number; tooOld: number; dropped: number } {
  const have = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !have.has(r.id));
  const runs = sortRuns([...existing, ...fresh]).slice(0, HISTORY_CAP);
  const kept = new Set(runs.map((r) => r.id));
  const added = fresh.filter((r) => kept.has(r.id)).length;
  return { runs, added, tooOld: fresh.length - added, dropped: lostRuns(existing, runs) };
}

/** How many of `existing` are not in `merged` (pushed out by the cap). */
export function lostRuns(existing: readonly RunRecord[], merged: readonly RunRecord[]): number {
  const kept = new Set(merged.map((r) => r.id));
  return existing.filter((r) => !kept.has(r.id)).length;
}
