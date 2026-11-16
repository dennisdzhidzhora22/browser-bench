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
  /** Gap to a reference, e.g. "+6.4 %"; CSS shows it after the reference value (layout D). */
  const gap = (mine: number | null | undefined, ref: number | undefined) =>
    mine == null || ref == null || !(ref > 0)
      ? undefined
      : `${mine >= ref ? '+' : '−'}${Math.abs((mine / ref - 1) * 100).toFixed(1)} %`;
</script>

{#snippet refCell(mine: number | null | undefined, ref: number | undefined, like: boolean, rname: string)}
  <!-- Like for like only: no reference beside an excluded or partial component, or a partial total. -->
  <td
    class="r num ref"
    class:down={like && mine != null && ref != null && mine < ref}
    data-name={rname}
    data-gap={like ? gap(mine, ref) : undefined}>{like ? shown(ref) : '—'}</td
  >
{/snippet}

<div class="points" data-testid="points" data-score-version={run.scoreVersion}>
  {#if other}
    <p class="warn" data-testid="not-comparable">
      Not comparable (score v{run.scoreVersion}): this build uses v{SCORE_VERSION}. Points shown as saved.
    </p>
  {/if}
  {#if run.size === 'smoke'}
    <p class="smoke-total" data-testid="total">smoke: no points</p>
  {:else}
    <table class="pts">
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
            <td class="r num"
              >{shown(c.points)}{#if c.points != null && c.partial}{' '}<span class="badge">(partial)</span>{/if}
              {#if c.note}<span class="muted">{c.note}</span>{/if}</td
            >
            {#each refs as ref (ref.name)}
              {@render refCell(c.points, ref.points[c.id], !c.note && !c.partial, ref.name)}
            {/each}
          </tr>
        {/each}
        <tr class="total">
          <td>Total</td>
          <td class="r num" data-testid="total" data-partial={run.partial}
            ><span class="unit">{shown(run.total)}</span>{#if run.total != null && run.partial}{' '}<span class="badge">partial</span>{/if}</td
          >
          {#each refs as ref (ref.name)}
            {@render refCell(run.total, ref.points['total'], !run.partial, ref.name)}
          {/each}
        </tr>
      </tbody>
    </table>
  {/if}
  <p class="muted" data-testid="run-info">
    {saved ? 'Saved run' : 'This run'} · {new Date(run.time).toLocaleString()} · {run.mode === 'full' ? 'Full' : 'Quick'}
    · {run.system.browser} {run.system.version} · {run.system.cores} logical cores
  </p>
  {#if run.size !== 'smoke'}
    <p class="muted">
      1000 points = the reference constants (score v{run.scoreVersion}). Raw numbers below are the headline; points
      are a summary.{run.partial ? ' Partial: not every component ran, or a test was invalid or missing.' : ''}
    </p>
  {/if}
</div>
