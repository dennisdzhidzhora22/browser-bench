<script lang="ts">
  import { describe } from '../lib/bench/components.ts';
  import type { EnduranceRecord } from '../lib/store/schema.ts';
  import EnduranceChart from './EnduranceChart.svelte';
  import { fmt } from './Table.svelte';

  let {
    run,
    windows,
    stress = false,
  }: {
    run: EnduranceRecord;
    /** x-axis width in windows. */
    windows: number;
    stress?: boolean;
  } = $props();

  const pct = (d: number | null) => (d === null ? '—' : `${(d * 100).toFixed(1)}%`);
</script>

<EnduranceChart parts={run.parts} {windows} hidden={run.hidden} windowMs={run.windowMs} />
<table data-testid="endurance-results">
  <thead>
    <tr><th>Part</th><th class="r">Drop</th><th>At the start</th></tr>
  </thead>
  <tbody>
    {#each run.parts as p, i (i)}
      <tr data-testid="endurance-row-{p.id}">
        <td>{p.label}<span class="muted"> · {p.workers} worker{p.workers === 1 ? '' : 's'}</span>
          {#if p.error}<span class="error" data-testid="endurance-error">{p.error}</span>{/if}</td>
        <td class="r num" data-testid="endurance-drop">{pct(p.drop)}</td>
        <td class="muted">
          {p.keys.map((k, j) => `${describe(k).name} ${fmt(p.base[j] ?? undefined)} ${p.units[j]}`).join(' · ')}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
<p class="muted">
  Drop = 1 − mean of the last minute ÷ mean of the first minute, over valid 5-second windows
  (shorter runs: halves). A falling line usually means the PC slows down as it heats up
  (thermal throttling): browsers cannot read temperatures.{stress ? '' : ' No points: Endurance shows the drop instead.'}
  All selected parts run at the same time.
</p>
