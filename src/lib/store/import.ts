// Reads an export file (or the saved history, which uses the same format).
// Validates strictly and never throws: every problem becomes a message.

import { checkRecord, SCHEMA, type RunRecord } from './schema.ts';

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
  for (let i = 0; i < runs.length; i++) {
    const why = checkRecord(runs[i]);
    if (why) return { error: `Run ${i + 1} in the file is not valid: ${why}.` };
    const r = runs[i] as RunRecord;
    if (!out.some((x) => x.id === r.id)) out.push(r);
  }
  return { runs: out };
}
