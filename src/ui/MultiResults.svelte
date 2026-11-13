<script lang="ts">
  import { NOISY_SPREAD } from '../lib/harness/orchestrator.ts';
  import type { MultiOutcome } from '../lib/harness/multi.ts';

  let { outcomes }: { outcomes: MultiOutcome[] } = $props();

  function fmt(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return '—';
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function status(o: MultiOutcome): string {
    if (o.hidden) return 'hidden';
    if (!o.checksumOk) return o.error ?? 'failed';
    return o.noisy ? 'noisy' : 'ok';
  }
</script>

<table data-testid="multi-results">
  <thead>
    <tr>
      <th>Test</th>
      <th class="r">All cores</th>
      <th class="r">1 core</th>
      <th>Unit</th>
      <th class="r">Scaling</th>
      <th class="r">Spread</th>
      <th>Check</th>
    </tr>
  </thead>
  <tbody>
    {#each outcomes as o (o.def.id)}
      <tr data-testid="multi-row-{o.def.id}" class:noisy={o.valid && o.noisy}>
        <td>
          {o.def.name}
          <span class="muted">{o.workers} workers</span>
        </td>
        <td class="r num" data-testid="value">{o.valid ? fmt(o.all?.throughput) : '—'}</td>
        <td class="r num">{o.valid ? fmt(o.single?.throughput) : '—'}</td>
        <td>{o.def.unit}</td>
        <td class="r num" data-testid="scaling" title="ideal = {o.workers}×">
          {o.valid && o.scaling !== undefined ? `${o.scaling.toFixed(2)}×` : '—'}
        </td>
        <td class="r num" title={o.all ? `${o.all.samples} samples taken` : ''}>
          {o.all ? `${(o.all.stats.spread * 100).toFixed(1)} %` : '—'}
        </td>
        <td
          data-testid="checksum"
          data-ok={o.checksumOk}
          data-valid={o.valid}
          data-noisy={o.noisy}
          title={o.error ??
            (o.noisy ? `fastest samples differ by more than ${NOISY_SPREAD * 100} %` : '')}
        >
          {status(o)}
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    text-align: left;
    vertical-align: top;
  }
  .r {
    text-align: right;
  }
  .muted {
    display: block;
    font-size: 0.85em;
    opacity: 0.6;
  }
  .noisy td {
    background: color-mix(in srgb, #d97706 12%, transparent);
  }
</style>
