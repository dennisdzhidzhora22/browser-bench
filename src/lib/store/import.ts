// Reads an export file (or the saved history, which uses the same format).
// Validates strictly and never throws: every problem becomes a message.
// Each run is rebuilt from its known fields and, for this build's
// scoreVersion, rescored from its kernels: saved points are never trusted.

import { rescore } from '../scoring/score.ts';
import { cleanRecord, SCHEMA, type RunRecord } from './schema.ts';

/** Larger import files are refused before they are read. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type Parsed = { runs: RunRecord[] } | { error: string };

export function parseExport(text: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'The file is not valid JSON.' };
  }
  if (typeof data !== 'object' || data === null || (data as { format?: unknown }).format !== 'browser-bench') {
    return { error: 'This is not a browser-bench export file.' };
  }
  const { schema, runs } = data as { schema?: unknown; runs?: unknown };
  if (schema !== SCHEMA) {
    return {
      error: `This file uses export format v${String(schema)}; this version of browser-bench reads v${SCHEMA}.`,
    };
  }
  if (!Array.isArray(runs)) return { error: 'The file has no list of runs.' };
  const out: RunRecord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    const r = cleanRecord(runs[i]);
    if (typeof r === 'string') return { error: `Run ${i + 1} in the file is not valid: ${r}.` };
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(rescore(r));
  }
  return { runs: out };
}
