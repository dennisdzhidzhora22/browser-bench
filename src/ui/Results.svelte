<script lang="ts">
  import { describe } from '../lib/bench/components.ts';
  import type { Reference } from '../lib/scoring/score.ts';
  import type { KernelRecord } from '../lib/store/schema.ts';
  import Table, { fmt, pct, value, type Column } from './Table.svelte';

  let {
    kernels,
    refs = [],
    prefix,
  }: {
    kernels: KernelRecord[];
    /** Matching-version references; the column is hidden when empty. */
    refs?: Reference[];
    /** Component id, for reference keys `<component>/<defKey>`. */
    prefix: string;
  } = $props();

  const cols: Column[] = [
    { head: 'Test', cell: (k) => describe(k.key).name, sub: (k) => describe(k.key).stresses },
    { head: 'Result', num: true, cell: (k) => value(k), testid: 'value' },
    { head: 'Unit', cell: (k) => k.unit },
    { head: 'Median', num: true, cell: (k) => (k.ms ? `${k.ms.median.toFixed(1)} ms` : '—') },
    {
      head: 'Spread',
      num: true,
      cell: (k) => pct(k.ms && k.spread),
      tip: (k) => (k.samples ? `${k.samples} samples taken` : ''),
    },
  ];
</script>

<Table
  rows={kernels}
  {cols}
  rowid={(k) => `row-${k.key}`}
  testid="results"
  {refs}
  refAt={3}
  ref={(r, k) => fmt(r.results[`${prefix}/${k.key}`])}
  refv={(r, k) => r.results[`${prefix}/${k.key}`]}
/>
