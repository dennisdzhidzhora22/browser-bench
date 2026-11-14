// Export runs as a JSON file the user downloads. No network: a Blob URL.

import { SCHEMA, type ExportFile, type RunRecord } from './schema.ts';

/** Pretty-printed for files people read; compact (indent 0) for localStorage. */
export function exportText(runs: readonly RunRecord[], indent = 1): string {
  const file: ExportFile = { format: 'browser-bench', schema: SCHEMA, runs: [...runs] };
  return JSON.stringify(file, null, indent);
}

export function download(runs: readonly RunRecord[]): void {
  const name =
    runs.length === 1
      ? `browser-bench-${runs[0]!.time.slice(0, 19).replace(/:/g, '-')}.json`
      : `browser-bench-history-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([exportText(runs)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
