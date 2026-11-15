<script lang="ts" module>
  import type { KernelRecord } from '../lib/store/schema.ts';

  /** One results-table column. The Check column is always added last. */
  export interface Column {
    head: string;
    /** Right-aligned number column. */
    num?: boolean;
    /** Header tooltip. */
    title?: string;
    cell: (k: KernelRecord) => string;
    /** Muted text after the cell's text. */
    sub?: (k: KernelRecord) => string;
    tip?: (k: KernelRecord) => string;
    testid?: string;
  }

  /** 3 significant-ish digits: 0 decimals from 100, 1 from 10, else `small`. */
  export function fmt(n: number | null | undefined, small = 2): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(Math.min(1, small)) : n.toFixed(small);
  }

  export const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(1)} %`);

  /** The headline value, or a dash when the result does not count. */
  export const value = (k: KernelRecord, small = 2) => (k.valid ? fmt(k.value, small) : '—');
</script>

<script lang="ts">
  import { NOISY_SPREAD } from '../lib/harness/orchestrator.ts';
  import type { Reference } from '../lib/scoring/score.ts';

  let {
    rows,
    cols,
    rowid,
    testid,
    refs = [],
    refAt = cols.length,
    ref,
  }: {
    rows: KernelRecord[];
    cols: Column[];
    rowid: (k: KernelRecord) => string;
    testid?: string;
    /** Matching-version references, one column each, inserted before column `refAt`. */
    refs?: Reference[];
    refAt?: number;
    ref?: (r: Reference, k: KernelRecord) => string;
  } = $props();

  const before = $derived(cols.slice(0, refAt));
  const after = $derived(cols.slice(refAt));

  function status(k: KernelRecord): string {
    if (k.hidden) return 'hidden';
    if (!k.valid) return k.error ?? 'failed';
    return k.noisy ? 'noisy' : 'ok';
  }

  const why = (k: KernelRecord) =>
    k.error ??
    (k.weakBaseline
      ? 'one worker in the all-cores run beat the 1-core run, so the 1-core number (and scaling) is too low'
      : k.noisy
        ? `fastest samples differ by more than ${NOISY_SPREAD * 100} %`
        : '');
</script>

{#snippet cells(list: Column[], k: KernelRecord)}
  {#each list as c (c.head)}
    <td class:r={c.num} class:num={c.num} title={c.tip?.(k) ?? ''} data-testid={c.testid}>
      {c.cell(k)}{#if c.sub}{' '}<span class="muted">{c.sub(k)}</span>{/if}
    </td>
  {/each}
{/snippet}

<table data-testid={testid}>
  <thead>
    <tr>
      {#each before as c (c.head)}<th class:r={c.num} title={c.title}>{c.head}</th>{/each}
      {#each refs as r (r.name)}<th class="r">{r.name}</th>{/each}
      {#each after as c (c.head)}<th class:r={c.num} title={c.title}>{c.head}</th>{/each}
      <th>Check</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as k (rowid(k))}
      <tr data-testid={rowid(k)} class:noisy={k.valid && k.noisy}>
        {@render cells(before, k)}
        {#each refs as r (r.name)}<td class="r num ref">{ref?.(r, k) ?? '—'}</td>{/each}
        {@render cells(after, k)}
        <td
          data-testid="checksum"
          data-ok={k.valid || k.hidden}
          data-valid={k.valid}
          data-noisy={k.noisy}
          data-weak-baseline={k.weakBaseline}
          title={why(k)}
        >
          {status(k)}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
