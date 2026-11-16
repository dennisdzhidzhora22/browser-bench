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

  const pct = (d: number | null | undefined) => (d === null || d === undefined ? '—' : `${(d * 100).toFixed(1)}%`);
  const sum = (xs: readonly number[] | undefined) => (xs ?? []).reduce((a, b) => a + b, 0);
  const worst = (xs: readonly number[] | undefined) => (xs ?? []).reduce((a, b) => Math.max(a, b), 0);
</script>

<EnduranceChart parts={run.parts} {windows} hidden={run.hidden} unfocused={run.unfocused ?? []} windowMs={run.windowMs} />
<table data-testid="endurance-results">
  <thead>
    <tr><th>Part</th><th class="r">Burst → sustained</th><th class="r">Sustained drop</th><th>At the start</th></tr>
  </thead>
  <tbody>
    {#each run.parts as p, i (i)}
      <tr data-testid="endurance-row-{p.id}">
        <td
          >{p.label}<span class="muted"> · {p.workers} worker{p.workers === 1 ? '' : 's'}</span>
          {#if sum(p.missed) > 0}<span class="muted" data-testid="endurance-missed"
              >· {sum(p.missed)} slice{sum(p.missed) === 1 ? '' : 's'} missed (worst worker {worst(p.missed)})</span
            >{/if}
          {#if p.error}<span class="error" data-testid="endurance-error">{p.error}</span>{/if}</td
        >
        <td class="r num" data-testid="endurance-burst">{pct(p.burst)}</td>
        <td class="r num"
          ><span data-testid="endurance-drop">{pct(p.drop)}</span>{#if p.noisy}<span
              class="muted"
              data-testid="endurance-noisy"> noisy</span
            >{/if}</td
        >
        <td class="muted">
          {p.keys.map((k, j) => `${describe(k).name} ${fmt(p.base[j] ?? undefined)} ${p.units[j]}`).join(' · ')}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
{#if run.notes?.length}
  <p class="muted" data-testid="endurance-notes">{run.notes.join(' ')}</p>
{/if}
<p class="muted">
  Over valid 5-second windows: <b>burst → sustained</b> = 1 − median of minute 2 ÷ the first window, mostly
  the short power boost running out in the first seconds; <b>sustained drop</b> = 1 − median of the last
  minute ÷ median of minute 2, the slow slide that usually means the PC slows down as it heats up (browsers
  cannot read temperatures). Runs under 3 minutes use thirds instead of minutes. "noisy": minute 2 or the
  last minute is too uneven, or has too few valid windows, to trust. Windows with the tab hidden or another
  window in front are not counted.{stress ? '' : ' No points: Endurance shows these figures instead.'}
  All selected parts run at the same time.
</p>
