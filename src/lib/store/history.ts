// Run history in localStorage, under one key, newest first (docs/SPEC.md, D9).
// Saving happens after a run, never during a measurement. Errors (full or
// disabled storage, corrupt data) come back as messages; nothing throws.

import { exportText } from './export.ts';
import { parseExport } from './import.ts';
import type { RunRecord } from './schema.ts';

export const HISTORY_KEY = 'browser-bench:history';
export const HISTORY_CAP = 50;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store => globalThis.localStorage;

export function loadHistory(store: Store = local()): { runs: RunRecord[]; error?: string } {
  let text: string | null;
  try {
    text = store.getItem(HISTORY_KEY);
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
export function saveHistory(runs: readonly RunRecord[], store: Store = local()): string | undefined {
  try {
    if (runs.length === 0) store.removeItem(HISTORY_KEY);
    else store.setItem(HISTORY_KEY, exportText(runs, 0));
    return undefined;
  } catch (err) {
    return err instanceof DOMException && err.name === 'QuotaExceededError'
      ? 'Could not save to history: browser storage for this page is full. Export and delete old runs.'
      : 'Could not save to history: local storage is not available.';
  }
}

/** Newest first. ISO UTC times sort as strings. */
export function sortRuns(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

/** Adds runs not already present (by id), newest first, capped. */
export function mergeRuns(
  existing: readonly RunRecord[],
  incoming: readonly RunRecord[],
): { runs: RunRecord[]; added: number; dropped: number } {
  const fresh = incoming.filter((r) => !existing.some((x) => x.id === r.id));
  const all = sortRuns([...existing, ...fresh]);
  const runs = all.slice(0, HISTORY_CAP);
  return { runs, added: fresh.length, dropped: all.length - runs.length };
}
