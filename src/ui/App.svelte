<script lang="ts">
  import { tick } from 'svelte';
  import { components } from '../lib/bench/components.ts';
  import type { ComponentId, KernelDef, SizeId } from '../lib/bench/types.ts';
  import {
    Cancelled,
    startRun,
    type KernelOutcome,
    type RunMode,
  } from '../lib/harness/orchestrator.ts';
  import { startMultiRun, type MultiOutcome } from '../lib/harness/multi.ts';
  import MultiResults from './MultiResults.svelte';
  import Results from './Results.svelte';

  const isolated = globalThis.crossOriginIsolated === true;
  const dev = import.meta.env.DEV;
  // `?smoke` selects the tiny sizes used by automated tests (docs/SPEC.md, section 3).
  const size: SizeId = new URLSearchParams(location.search).has('smoke') ? 'smoke' : 'standard';

  let selected: Record<ComponentId, boolean> = $state({
    'cpu-single': true,
    'cpu-multi': false,
    memory: false,
    gpu: false,
    storage: false,
  });
  let mode: RunMode = $state('quick');
  const cores = Math.max(1, navigator.hardwareConcurrency || 1);
  let workers: number = $state(cores);

  type Phase =
    | { kind: 'idle' }
    | { kind: 'running'; index: number; total: number; current: string }
    | { kind: 'done' }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string };

  let phase: Phase = $state({ kind: 'idle' });
  let outcomes: KernelOutcome[] = $state([]);
  let multiOutcomes: MultiOutcome[] = $state([]);
  let active: { cancel(): void } | undefined;
  let cancelRequested = false;

  const toRun = $derived(components.filter((c) => selected[c.id] && c.kernels.length > 0));
  const totalKernels = $derived(toRun.reduce((n, c) => n + c.kernels.length, 0));

  /** Lets Svelte flush and the browser paint before the next kernel starts. */
  async function settle(): Promise<void> {
    await tick();
    await new Promise<void>((resolve) => {
      // rAF never fires in a hidden tab; the timeout keeps the run moving and
      // cancels the frame so it cannot fire later, mid-measurement.
      const frame = requestAnimationFrame(() =>
        setTimeout(() => {
          clearTimeout(fallback);
          resolve();
        }, 0),
      );
      const fallback = setTimeout(() => {
        cancelAnimationFrame(frame);
        resolve();
      }, 100);
    });
  }

  async function run() {
    const plan = toRun;
    const total = totalKernels;
    if (total === 0) return;
    outcomes = [];
    multiOutcomes = [];
    cancelRequested = false;
    phase = { kind: 'running', index: 0, total, current: 'starting' };
    let offset = 0;
    try {
      for (const c of plan) {
        if (cancelRequested) throw new Cancelled();
        const base = offset;
        const beforeKernel = async (index: number, def: KernelDef) => {
          phase = { kind: 'running', index: base + index, total, current: `${c.name}: ${def.name}` };
          await settle();
        };
        if (c.id === 'cpu-multi') {
          const r = startMultiRun({
            kernels: c.kernels,
            size,
            mode,
            workers,
            beforeKernel,
            afterKernel: (_i, o) => void multiOutcomes.push(o),
          });
          active = r;
          await r.done;
        } else {
          const r = startRun({
            kernels: c.kernels,
            size,
            mode,
            beforeKernel,
            afterKernel: (_i, o) => void outcomes.push(o),
          });
          active = r;
          await r.done;
        }
        offset += c.kernels.length;
      }
      phase = { kind: 'done' };
    } catch (err) {
      phase =
        err instanceof Cancelled
          ? { kind: 'cancelled' }
          : { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      active = undefined;
    }
  }

  function cancel() {
    cancelRequested = true;
    active?.cancel();
  }
</script>

{#if dev}
  <p class="banner" data-testid="dev-banner">Dev build. Scores are not valid.</p>
{/if}

<h1>browser-bench</h1>

{#if !isolated}
  <section class="blocked" data-testid="not-isolated">
    <h2>This page is not cross-origin isolated</h2>
    <p>
      Benchmarks need the <code>Cross-Origin-Opener-Policy</code> and
      <code>Cross-Origin-Embedder-Policy</code> headers. Serve the app with
      <code>npm run preview</code> or <code>npm run dev</code>, not by opening the file.
    </p>
  </section>
{:else}
  <p class="muted" data-testid="isolated">Cross-origin isolated: yes{size === 'smoke' ? ' · smoke sizes' : ''}</p>

  <fieldset disabled={phase.kind === 'running'}>
    <legend>Components</legend>
    {#each components as c (c.id)}
      <label class:off={c.kernels.length === 0}>
        <input
          type="checkbox"
          bind:checked={selected[c.id]}
          disabled={c.kernels.length === 0}
          data-testid="component-{c.id}"
        />
        {c.name}
        {#if c.kernels.length === 0}<span class="muted">(not built yet)</span>{/if}
      </label>
      {#if c.id === 'cpu-multi' && selected['cpu-multi']}
        <label class="sub">
          Workers
          <input
            type="number"
            min="1"
            max={cores * 2}
            bind:value={workers}
            data-testid="workers"
          />
          <span class="muted">(this browser reports {cores} logical cores)</span>
        </label>
      {/if}
    {/each}
  </fieldset>

  <fieldset disabled={phase.kind === 'running'}>
    <legend>Mode</legend>
    <label><input type="radio" bind:group={mode} value="quick" data-testid="mode-quick" /> Quick</label>
    <label><input type="radio" bind:group={mode} value="full" data-testid="mode-full" /> Full</label>
  </fieldset>

  <p>
    {#if phase.kind === 'running'}
      <button onclick={cancel} data-testid="cancel">Cancel</button>
      <span data-testid="progress">
        {phase.index + 1} / {phase.total} · {phase.current}
      </span>
    {:else}
      <button onclick={run} disabled={totalKernels === 0 || !(workers >= 1)} data-testid="run"
        >Run</button
      >
      {#if phase.kind === 'done'}<span data-testid="status">Done</span>{/if}
      {#if phase.kind === 'cancelled'}<span data-testid="status">Cancelled</span>{/if}
    {/if}
  </p>

  {#if phase.kind === 'error'}
    <p class="error" data-testid="error">{phase.message}</p>
  {/if}

  {#if outcomes.length > 0}
    <h2>CPU — single core</h2>
    <Results {outcomes} />
  {/if}

  {#if multiOutcomes.length > 0}
    <h2>CPU — all cores</h2>
    <MultiResults outcomes={multiOutcomes} />
  {/if}

  <p class="muted note">
    These are browser scores: this PC's speed through this browser. For steady numbers, keep
    this window in front, plug in a laptop, and use the best-performance power mode.
  </p>
{/if}

<style>
  .banner {
    background: #b45309;
    color: #fff;
    padding: 0.4rem 0.8rem;
    margin: -1.5rem -1.5rem 1rem;
  }
  .blocked,
  .error {
    border-left: 4px solid #dc2626;
    padding-left: 0.8rem;
  }
  fieldset {
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    margin: 0 0 0.75rem;
  }
  label {
    display: block;
  }
  .sub {
    margin-left: 1.6rem;
  }
  .sub input {
    width: 4rem;
  }
  h2 {
    font-size: 1.1rem;
    margin: 1.25rem 0 0.5rem;
  }
  .off,
  .muted {
    opacity: 0.6;
  }
</style>
