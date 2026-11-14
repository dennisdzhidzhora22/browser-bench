<script lang="ts">
  import { formatBytes, latencyNs } from '../lib/bench/memory/index.ts';
  import { defKey } from '../lib/bench/types.ts';
  import type { MultiOutcome } from '../lib/harness/multi.ts';
  import type { KernelOutcome } from '../lib/harness/orchestrator.ts';

  let { outcomes, multi }: { outcomes: KernelOutcome[]; multi: MultiOutcome[] } = $props();

  const bandwidth = $derived(outcomes.filter((o) => o.def.id !== 'mem_latency'));
  const latency = $derived(
    outcomes
      .filter((o) => o.def.id === 'mem_latency')
      .map((o) => ({
        o,
        size: Number(o.def.variant),
        ns: o.valid ? latencyNs(o.throughput) : undefined,
      })),
  );

  function fmt(n: number | undefined, digits = 1): string {
    if (n === undefined || !Number.isFinite(n)) return '—';
    return n >= 100 ? n.toFixed(0) : n.toFixed(digits);
  }

  function status(o: { hidden: boolean; checksumOk: boolean; noisy: boolean; error?: string }) {
    if (o.hidden) return 'hidden';
    if (!o.checksumOk) return o.error ?? 'failed';
    return o.noisy ? 'noisy' : 'ok';
  }

  let canvas: HTMLCanvasElement | undefined = $state();

  // Hand-drawn chart (no chart library, SPEC section 7). x: log2 of the
  // working-set size; y: log10 of ns per access. Steps show cache levels.
  $effect(() => {
    const points = latency.filter((p) => p.ns !== undefined) as { size: number; ns: number }[];
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const fg = getComputedStyle(c).color;
    const pad = { l: 44, r: 30, t: 10, b: 28 };
    const x0 = 14; // 16 KB
    const x1 = 28; // 256 MB
    const y0 = 0; // 1 ns
    const y1 = 3; // 1000 ns
    const px = (size: number) => pad.l + ((Math.log2(size) - x0) / (x1 - x0)) * (w - pad.l - pad.r);
    const py = (ns: number) =>
      h - pad.b - ((Math.log10(Math.max(ns, 1)) - y0) / (y1 - y0)) * (h - pad.t - pad.b);

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = fg;
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 1;
    for (const ns of [1, 10, 100, 1000]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, py(ns));
      ctx.lineTo(w - pad.r, py(ns));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.7;
    ctx.textAlign = 'right';
    for (const ns of [1, 10, 100, 1000]) ctx.fillText(`${ns} ns`, pad.l - 6, py(ns) + 4);
    ctx.textAlign = 'center';
    for (const e of [14, 16, 18, 20, 22, 24, 26, 28]) {
      ctx.fillText(formatBytes(2 ** e), px(2 ** e), h - 8);
    }

    if (points.length === 0) return;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(px(p.size), py(p.ns));
      else ctx.lineTo(px(p.size), py(p.ns));
    });
    ctx.stroke();
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(px(p.size), py(p.ns), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
</script>

<table data-testid="memory-results">
  <thead>
    <tr>
      <th>Test</th>
      <th class="r">Result</th>
      <th>Unit</th>
      <th class="r">Spread</th>
      <th>Check</th>
    </tr>
  </thead>
  <tbody>
    {#each bandwidth as o (defKey(o.def))}
      <tr data-testid="mem-row-{o.def.id}">
        <td>{o.def.name} <span class="muted">1 core · {o.def.stresses}</span></td>
        <td class="r num" data-testid="value">{o.valid ? fmt(o.throughput) : '—'}</td>
        <td>{o.def.unit}</td>
        <td class="r num">{o.stats ? `${(o.stats.spread * 100).toFixed(1)} %` : '—'}</td>
        <td data-testid="checksum" data-ok={o.checksumOk} data-valid={o.valid}>{status(o)}</td>
      </tr>
    {/each}
    {#each multi as o (defKey(o.def))}
      <tr data-testid="mem-row-{o.def.id}-multi">
        <td>{o.def.name} <span class="muted">{o.workers} workers · {o.def.stresses}</span></td>
        <td class="r num" data-testid="value">{o.valid ? fmt(o.all?.throughput) : '—'}</td>
        <td>{o.def.unit}</td>
        <td class="r num">{o.all ? `${(o.all.stats.spread * 100).toFixed(1)} %` : '—'}</td>
        <td data-testid="checksum" data-ok={o.checksumOk} data-valid={o.valid}>{status(o)}</td>
      </tr>
    {/each}
  </tbody>
</table>

{#if latency.length > 0}
  <h3>Latency by working-set size</h3>
  <canvas bind:this={canvas} class="chart" data-testid="latency-chart"></canvas>
  <table>
    <thead>
      <tr>
        <th>Size</th>
        <th class="r">ns per access</th>
        <th>Check</th>
      </tr>
    </thead>
    <tbody>
      {#each latency as p (p.size)}
        <tr data-testid="latency-row-{p.size}">
          <td>{formatBytes(p.size)}</td>
          <td class="r num" data-testid="value">{fmt(p.ns, 2)}</td>
          <td data-testid="checksum" data-ok={p.o.checksumOk} data-valid={p.o.valid}>
            {status(p.o)}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="muted">
    Each step up is the working set leaving a cache level (L1, L2, L3, then RAM). Large sizes
    also include address-translation misses, which is what random access really costs.
  </p>
{/if}

<style>
  table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.75rem;
  }
  th,
  td {
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    text-align: left;
  }
  .r {
    text-align: right;
  }
  .muted {
    font-size: 0.85em;
    opacity: 0.6;
  }
  h3 {
    font-size: 1rem;
    margin: 1rem 0 0.4rem;
  }
  .chart {
    display: block;
    width: 100%;
    height: 240px;
  }
</style>
