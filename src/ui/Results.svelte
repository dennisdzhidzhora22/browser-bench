<script lang="ts">
  import { NOISY_SPREAD, type KernelOutcome } from '../lib/harness/orchestrator.ts';

  let { outcomes }: { outcomes: KernelOutcome[] } = $props();

  function fmt(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return '—';
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function status(o: KernelOutcome): string {
    if (o.hidden) return 'hidden';
    if (!o.checksumOk) return o.error ?? 'failed';
    return o.noisy ? 'noisy' : 'ok';
  }
</script>

<table data-testid="results">
  <thead>
    <tr>
      <th>Test</th>
      <th class="r">Result</th>
      <th>Unit</th>
      <th class="r">Median</th>
      <th class="r">Spread</th>
      <th>Check</th>
    </tr>
  </thead>
  <tbody>
    {#each outcomes as o (o.def.id)}
      <tr data-testid="row-{o.def.id}" class:noisy={o.valid && o.noisy}>
        <td>
          {o.def.name}
          <span class="muted">{o.def.stresses}</span>
        </td>
        <td class="r num" data-testid="value">{o.valid ? fmt(o.throughput) : '—'}</td>
        <td>{o.def.unit}</td>
        <td class="r num">{o.stats ? `${o.stats.median.toFixed(1)} ms` : '—'}</td>
        <td class="r num" title={o.samples ? `${o.samples} samples taken` : ''}>
          {o.stats ? `${(o.stats.spread * 100).toFixed(1)} %` : '—'}
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
