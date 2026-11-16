<script lang="ts">
  import { describe } from '../lib/bench/components.ts';
  import { formatBytes } from '../lib/bench/memory/index.ts';
  import { offCores, type Reference } from '../lib/scoring/score.ts';
  import type { KernelRecord } from '../lib/store/schema.ts';
  import { chartColors, look } from './look.svelte.ts';
  import Table, { fmt, pct, value, type Column } from './Table.svelte';

  let {
    kernels,
    smoke = false,
    refs = [],
    cores,
  }: {
    kernels: KernelRecord[];
    smoke?: boolean;
    refs?: Reference[];
    /** The run's core count: an all-cores copy on another worker count gets no reference. */
    cores?: number;
  } = $props();

  const isLatency = (k: KernelRecord) => k.key.startsWith('mem_latency:');
  /** Fill and copy (1 core), then the all-cores copy. */
  const bandwidth = $derived(kernels.filter((k) => !isLatency(k)));
  const latency = $derived(kernels.filter(isLatency));
  const sizeOf = (k: KernelRecord) => Number(k.key.split(':')[1]);
  const refv = (r: Reference, k: KernelRecord) => (offCores(k, cores) ? undefined : r.results[`memory/${k.key}`]);
  const ref = (r: Reference, k: KernelRecord, small = 1) => fmt(refv(r, k), small);

  const bandwidthCols: Column[] = [
    {
      head: 'Test',
      cell: (k) => describe(k.key).name,
      sub: (k) =>
        k.workers === undefined
          ? `1 core · ${describe(k.key).stresses}`
          : `${k.workers} workers · ${describe(k.key).stresses}${k.workers < 8 ? ' · few workers: total may fit in cache' : ''}`,
    },
    { head: 'Result', num: true, cell: (k) => value(k, 1), testid: 'value' },
    { head: 'Unit', cell: (k) => k.unit },
    { head: 'Spread', num: true, cell: (k) => pct(k.ms && k.spread) },
  ];
  const latencyCols: Column[] = [
    { head: 'Size', cell: (k) => `${formatBytes(sizeOf(k))}${smoke ? ' (smoke run: 4 KB)' : ''}` },
    { head: 'ns per access', num: true, cell: (k) => value(k), testid: 'value' },
  ];

  let canvas: HTMLCanvasElement | undefined = $state();

  // Hand-drawn chart (no chart library, SPEC section 7). x: log2 of the
  // working-set size; y: log10 of ns per access. Steps show cache levels. The
  // first reference's curve, when there is one, is drawn dashed. Colours come
  // from the skin's CSS variables, read once per draw (after the run).
  $effect(() => {
    void look.v; // redraw when the skin or theme changes
    const points = latency.filter((k) => k.valid && k.value !== null).map((k) => ({ size: sizeOf(k), ns: k.value! }));
    const r0 = refs[0];
    const refPoints = r0
      ? latency.flatMap((k) => {
          const ns = r0.results[`memory/${k.key}`];
          return ns ? [{ size: sizeOf(k), ns }] : [];
        })
      : [];
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const col = chartColors(c);
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 44, r: 30, t: 10, b: 28 };
    const x0 = 14; // 16 KB
    const x1 = 28; // 256 MB
    const y0 = 0; // 1 ns
    const y1 = 3; // 1000 ns
    const px = (size: number) => pad.l + ((Math.log2(size) - x0) / (x1 - x0)) * (w - pad.l - pad.r);
    const py = (ns: number) => h - pad.b - ((Math.log10(Math.max(ns, 1)) - y0) / (y1 - y0)) * (h - pad.t - pad.b);

    ctx.font = col.font;
    ctx.lineWidth = 1;
    ctx.strokeStyle = col.line;
    for (const ns of [1, 10, 100, 1000]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, py(ns));
      ctx.lineTo(w - pad.r, py(ns));
      ctx.stroke();
    }
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'right';
    for (const ns of [1, 10, 100, 1000]) ctx.fillText(`${ns} ns`, pad.l - 6, py(ns) + 4);
    ctx.textAlign = 'center';
    for (const e of [14, 16, 18, 20, 22, 24, 26, 28]) ctx.fillText(formatBytes(2 ** e), px(2 ** e), h - 8);

    const line = (pts: { size: number; ns: number }[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.size), py(p.ns)) : ctx.lineTo(px(p.size), py(p.ns))));
      ctx.stroke();
    };
    if (refPoints.length) {
      ctx.strokeStyle = col.ref;
      ctx.setLineDash([3, 3]);
      line(refPoints);
      ctx.setLineDash([]);
    }
    if (points.length === 0) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col.plot;
    line(points);
    ctx.fillStyle = col.bg;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(px(p.size), py(p.ns), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  });
</script>

<Table
  rows={bandwidth}
  cols={bandwidthCols}
  rowid={(k) => `mem-row-${k.key}${k.workers === undefined ? '' : '-multi'}`}
  testid="memory-results"
  {refs}
  refAt={3}
  {ref}
  {refv}
/>

{#if latency.length > 0}
  <h3>Latency by working-set size</h3>
  <div class="two">
    <div>
      <canvas bind:this={canvas} class="chart" data-testid="latency-chart"></canvas>
      <div class="legend">
        <span><i></i>This run</span>
        {#if refs[0]}<span><i class="d"></i>{refs[0].name}</span>{/if}
      </div>
      <p class="muted">
        Steps up mostly mark the working set outgrowing a cache level (L1, L2, L3, then RAM). Past a few MB, part of
        each step is address-translation (TLB) misses, which is what random access across that much memory really
        costs.
      </p>
    </div>
    <Table
      rows={latency}
      cols={latencyCols}
      rowid={(k) => `latency-row-${sizeOf(k)}`}
      {refs}
      refAt={2}
      ref={(r, k) => ref(r, k, 2)}
    />
  </div>
{/if}
