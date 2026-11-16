<script lang="ts">
  import { SCORE_VERSION } from '../lib/scoring/constants.ts';
  import { download } from '../lib/store/export.ts';
  import { MAX_IMPORT_BYTES, parseExport } from '../lib/store/import.ts';
  import type { RunRecord } from '../lib/store/schema.ts';

  let {
    runs,
    message,
    disabled,
    onopen,
    onchange,
    onimport,
    pending,
    onconfirm,
  }: {
    runs: RunRecord[];
    /** Last problem or result to report (save failed, import result, ...). */
    message: string | undefined;
    disabled: boolean;
    onopen: (r: RunRecord) => void;
    /** Replace the whole list (delete, clear). */
    onchange: (runs: RunRecord[]) => void;
    onimport: (runs: RunRecord[] | string) => void;
    /** An import waiting for a yes/no, with the question to ask. */
    pending?: string;
    onconfirm: (yes: boolean) => void;
  } = $props();

  let confirmClear = $state(false);

  const len = (ms: number) => (ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`);

  function label(r: RunRecord): string {
    if (r.endurance) {
      return `drop ${r.endurance.parts.map((p) => (p.drop === null ? '—' : `${(p.drop * 100).toFixed(1)}%`)).join(' / ')}`;
    }
    if (r.scoreVersion !== SCORE_VERSION) return `not comparable (score v${r.scoreVersion})`;
    if (r.size === 'smoke') return 'smoke: no points';
    return r.total === null ? 'no points' : `${r.total}${r.partial ? ' partial' : ''}`;
  }

  async function pick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      onimport(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB; browser-bench exports are much smaller.`);
      return;
    }
    try {
      const p = parseExport(await file.text());
      onimport('error' in p ? p.error : p.runs);
    } catch {
      onimport('The file could not be read.');
    }
  }
</script>

<section data-testid="history">
  <h2>History</h2>
  {#if message}<p class="warn" data-testid="history-message">{message}</p>{/if}
  {#if pending}
    <p class="warn" data-testid="history-confirm">
      {pending}
      <button onclick={() => onconfirm(true)} {disabled} data-testid="history-confirm-yes">Import</button>
      <button onclick={() => onconfirm(false)} {disabled} data-testid="history-confirm-no">Cancel</button>
    </p>
  {/if}
  <p>
    <label class="button">
      Import…
      <input
        type="file"
        accept=".json,application/json"
        onchange={pick}
        disabled={disabled || pending !== undefined}
        data-testid="history-import"
      />
    </label>
    {#if runs.length > 0}
      <button onclick={() => download(runs)} {disabled} data-testid="history-export-all">Export all</button>
      <!-- Two clicks: the first asks, the second deletes. -->
      <button
        onclick={() => {
          if (confirmClear) onchange([]);
          confirmClear = !confirmClear;
        }}
        onblur={() => (confirmClear = false)}
        {disabled}
        data-testid="history-clear">{confirmClear ? `Really delete all ${runs.length}?` : 'Clear all'}</button
      >
    {/if}
  </p>
  {#if runs.length === 0}
    <p class="muted" data-testid="history-empty">No saved runs yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Date</th><th>Mode</th><th>Browser</th><th class="r">Total</th><th></th></tr>
      </thead>
      <tbody>
        {#each runs as r (r.id)}
          <tr data-testid="history-item" data-id={r.id}>
            <td>{new Date(r.time).toLocaleString()}</td>
            <td>{r.endurance ? `Endurance ${len(r.endurance.durationMs)}` : r.mode === 'full' ? 'Full' : 'Quick'}{r.size === 'smoke' ? ' · smoke' : ''}</td>
            <td>{r.system.browser} {r.system.version}</td>
            <td class="r num" data-testid="history-total">{label(r)}</td>
            <td>
              <button onclick={() => onopen(r)} {disabled} data-testid="history-open">Open</button>
              <button onclick={() => download([r])} {disabled} data-testid="history-export">Export</button>
              <button onclick={() => onchange(runs.filter((x) => x.id !== r.id))} {disabled} data-testid="history-delete"
                >Delete</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  <p class="muted">Kept in this browser only (up to 50 runs). Nothing is sent anywhere.</p>
</section>

<style>
  .button {
    display: inline-block;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    border-radius: 3px;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }
  .button input {
    display: none;
  }
</style>
