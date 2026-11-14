<script lang="ts">
  import { components } from '../lib/bench/components.ts';
  import { SCORE_VERSION } from '../lib/scoring/constants.ts';
  import { counted, refsFor } from '../lib/scoring/score.ts';
  import type { ComponentRecord, RunRecord } from '../lib/store/schema.ts';

  let { run, saved }: { run: RunRecord; saved: boolean } = $props();

  const other = $derived(run.scoreVersion !== SCORE_VERSION);
  const refs = $derived(refsFor(run.scoreVersion));
  const name = (c: ComponentRecord) =>
    (components.find((d) => d.id === c.id)?.name ?? c.id) +
    (c.gpu ? ` (${c.gpu.preference === 'high-performance' ? 'Fast' : 'Power-saving'}: ${c.gpu.label})` : '');
  const shown = (p: number | null | undefined) => (p == null ? '—' : String(p));
</script>

<section class="points" data-testid="points" data-score-version={run.scoreVersion}>
  <p class="muted" data-testid="run-info">
    {saved ? 'Saved run' : 'This run'} · {new Date(run.time).toLocaleString()} · {run.mode === 'full' ? 'Full' : 'Quick'}
    · {run.system.browser} {run.system.version} · {run.system.cores} logical cores
  </p>
  {#if other}
    <p class="warn" data-testid="not-comparable">
      Not comparable (score v{run.scoreVersion}): this build uses v{SCORE_VERSION}. Points shown as saved.
    </p>
  {/if}
  {#if run.size === 'smoke'}
    <p data-testid="total">smoke: no points</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Points</th>
          <th class="r">This run</th>
          {#each refs as ref (ref.name)}<th class="r">{ref.name}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each run.components as c, i (i)}
          <tr data-testid="points-{c.id}">
            <td>{name(c)}{c.gpu && counted(run.components, 'gpu') !== c ? ' · not in total' : ''}</td>
            <td class="r num">{shown(c.points)}{c.points != null && c.partial ? ' (partial)' : ''}
              {#if c.note}<span class="muted">{c.note}</span>{/if}</td>
            {#each refs as ref (ref.name)}
              <td class="r num">{c.note ? '—' : shown(ref.points[c.id])}</td>
            {/each}
          </tr>
        {/each}
        <tr class="total">
          <td>Total</td>
          <td class="r num" data-testid="total" data-partial={run.partial}>
            {shown(run.total)}{run.total != null && run.partial ? ' partial' : ''}
          </td>
          {#each refs as ref (ref.name)}<td class="r num">{shown(ref.points['total'])}</td>{/each}
        </tr>
      </tbody>
    </table>
    <p class="muted">
      1000 points = the provisional reference constants (score v{run.scoreVersion}). Raw numbers
      below are the headline; points are a summary.{run.partial
        ? ' Partial: not every component ran, or a test was invalid or missing.'
        : ''}
    </p>
  {/if}
</section>

<style>
  .total td {
    font-weight: 600;
  }
</style>
