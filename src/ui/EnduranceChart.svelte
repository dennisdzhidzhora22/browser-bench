<script lang="ts">
  // Throughput over time, drawn by hand on a canvas (no chart library, SPEC 7).
  // x: minutes; y: throughput relative to each part's minute 2 (100%, chartBase).
  // Grey bands: windows overlapping a hidden-tab period; hatched bands: another
  // window was in front. Neither is measured.
  import { chartBase } from '../lib/harness/drop.ts';

  let {
    parts,
    windows,
    hidden,
    unfocused = [],
    windowMs,
  }: {
    parts: { label: string; values: (number | null)[] }[];
    /** Width of the x axis in windows (planned length, or so far for Stress). */
    windows: number;
    hidden: number[];
    unfocused?: number[];
    windowMs: number;
  } = $props();

  const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed'];
  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    const c = canvas;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bases = parts.map((p) => chartBase(p.values));
    // Range in 10% steps around the data, always showing 100%. A loop, not
    // Math.min(...all): a 12 h Stress run has tens of thousands of values.
    let min = 1;
    let max = 1;
    parts.forEach((p, k) => {
      for (const v of p.values) {
        if (v === null) continue;
        const y = v / bases[k]!;
        if (y < min) min = y;
        if (y > max) max = y;
      }
    });
    const lo = Math.max(0, Math.floor((min - 0.02) * 10) / 10);
    const hi = Math.ceil((max + 0.02) * 10) / 10;
    const n = Math.max(windows, 1);
    const L = 44, R = 22, T = 8, B = 24;
    const px = (i: number) => L + (i / n) * (w - L - R);
    const py = (v: number) => h - B - ((v - lo) / (hi - lo)) * (h - T - B);
    const fg = getComputedStyle(c).color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.15;
    for (const i of hidden) ctx.fillRect(px(i), T, px(i + 1) - px(i), h - T - B);
    // Unfocused: diagonal hatching, so it reads differently from hidden.
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    const ph = h - T - B;
    for (const i of unfocused) {
      const x0 = px(i);
      const x1 = px(i + 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, T, x1 - x0, ph);
      ctx.clip();
      ctx.beginPath();
      for (let x = x0 - ph; x < x1; x += 6) {
        ctx.moveTo(x, h - B);
        ctx.lineTo(x + ph, T);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.textAlign = 'right';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) {
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.moveTo(L, py(v));
      ctx.lineTo(w - R, py(v));
      ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.fillText(`${Math.round(v * 100)}%`, L - 6, py(v) + 4);
    }
    ctx.textAlign = 'center';
    const mins = (n * windowMs) / 60_000;
    const step = Math.max(1, Math.ceil(mins / 10));
    for (let m = 0; m <= mins; m += step) ctx.fillText(`${m} min`, px((m * 60_000) / windowMs), h - 6);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    parts.forEach((p, k) => {
      const b = bases[k]!;
      ctx.strokeStyle = COLORS[k % COLORS.length]!;
      ctx.beginPath();
      let pen = false;
      p.values.forEach((v, i) => {
        if (v === null) pen = false;
        else {
          // Each window is drawn at its middle.
          if (pen) ctx.lineTo(px(i + 0.5), py(v / b));
          else ctx.moveTo(px(i + 0.5), py(v / b));
          pen = true;
        }
      });
      ctx.stroke();
      // A window with no valid neighbour has no line: mark it with a dot.
      ctx.fillStyle = ctx.strokeStyle;
      p.values.forEach((v, i) => {
        if (v !== null && p.values[i - 1] == null && p.values[i + 1] == null) ctx.fillRect(px(i + 0.5) - 2, py(v / b) - 2, 4, 4);
      });
    });
  });
</script>

<!-- Inline size: a lazy chunk with CSS would pull a preload helper into the page bundle. -->
<canvas bind:this={canvas} style="display:block;width:100%;height:220px" data-testid="endurance-chart"></canvas>
<p class="muted">
  {#each parts as p, k (k)}<span style:color={COLORS[k % COLORS.length]}>■</span> {p.label} &nbsp;{/each}
  · 100% = minute 2 (middle third under 3 min)
  {#if hidden.length}<span data-testid="endurance-hidden-note">· grey: tab hidden, not measured</span>{/if}
  {#if unfocused.length}<span data-testid="endurance-unfocused-note">· hatched: another window in front, not measured</span>{/if}
</p>
