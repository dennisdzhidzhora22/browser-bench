<script lang="ts">
  import { describe } from '../lib/bench/components.ts';
  import type { Reference } from '../lib/scoring/score.ts';
  import type { KernelRecord } from '../lib/store/schema.ts';
  import Table, { fmt, pct, value, type Column } from './Table.svelte';

  let { kernels, refs = [] }: { kernels: KernelRecord[]; refs?: Reference[] } = $props();

  const both = (k: KernelRecord) => k.spread !== undefined && k.singleSpread !== undefined;
  const cols: Column[] = [
    { head: 'Test', cell: (k) => describe(k.key).name, sub: (k) => `${k.workers} workers` },
    { head: 'All cores', num: true, cell: (k) => value(k), testid: 'value' },
    { head: '1 core', num: true, cell: (k) => (k.valid ? fmt(k.single) : '—') },
    { head: 'Unit', cell: (k) => k.unit },
    {
      head: 'Scaling',
      num: true,
      cell: (k) => (k.valid && k.scaling != null ? `${k.scaling.toFixed(2)}×` : '—'),
      tip: (k) => `ideal = ${k.workers}×`,
      testid: 'scaling',
    },
    {
      head: 'Spread',
      num: true,
      title: 'the larger of the all-cores and 1-core spreads',
      cell: (k) => (both(k) ? pct(Math.max(k.spread!, k.singleSpread!)) : '—'),
      tip: (k) =>
        both(k)
          ? `all cores ${pct(k.spread)} (${k.samples} samples) · 1 core ${pct(k.singleSpread)} (${k.singleSamples ?? '?'} samples)`
          : '',
    },
  ];
</script>

<Table
  rows={kernels}
  {cols}
  rowid={(k) => `multi-row-${k.key}`}
  testid="multi-results"
  {refs}
  refAt={2}
  ref={(r, k) => fmt(r.results[`cpu-multi/${k.key}`])}
  refv={(r, k) => r.results[`cpu-multi/${k.key}`]}
/>
