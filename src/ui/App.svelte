<script lang="ts">
  import { tick } from 'svelte';
  import { components } from '../lib/bench/components.ts';
  import type { ComponentId, KernelDef, SizeId } from '../lib/bench/types.ts';
  import {
    Cancelled,
    startRun,
    type KernelOutcome,
    type Run,
    type RunMode,
  } from '../lib/harness/orchestrator.ts';
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

  type Phase =
    | { kind: 'idle' }
    | { kind: 'running'; index: number; total: number; current: string }
    | { kind: 'done' }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string };

  let phase: Phase = $state({ kind: 'idle' });
  let outcomes: KernelOutcome[] = $state([]);
  let active: Run | undefined;

  const kernelsToRun = $derived(
    components.filter((c) => selected[c.id] && c.kernels.length > 0).flatMap((c) => c.kernels),
  );

  /** Lets Svelte flush and the browser paint before the next kernel starts. */
  async function settle(): Promise<void> {
    await tick();
    await new Promise<void>((resolve) => {
      // rAF never fires in a hidden tab; the timeout keeps the run moving.
      const t = setTimeout(resolve, 100);
      requestAnimationFrame(() =>
        setTimeout(() => {
          clearTimeout(t);
          resolve();
        }, 0),
      );
    });
  }

  async function run() {
    const list: readonly KernelDef[] = kernelsToRun;
    if (list.length === 0) return;
    outcomes = [];
    phase = { kind: 'running', index: 0, total: list.length, current: list[0]!.name };
    active = startRun({
      kernels: list,
      size,
      mode,
      beforeKernel: async (index, def) => {
        phase = { kind: 'running', index, total: list.length, current: def.name };
        await settle();
      },
      afterKernel: (_i, outcome) => {
        outcomes.push(outcome);
      },
    });
    try {
      await active.done;
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
      <button onclick={run} disabled={kernelsToRun.length === 0} data-testid="run">Run</button>
      {#if phase.kind === 'done'}<span data-testid="status">Done</span>{/if}
      {#if phase.kind === 'cancelled'}<span data-testid="status">Cancelled</span>{/if}
    {/if}
  </p>

  {#if phase.kind === 'error'}
    <p class="error" data-testid="error">{phase.message}</p>
  {/if}

  {#if outcomes.length > 0}
    <Results {outcomes} />
  {/if}
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
  .off,
  .muted {
    opacity: 0.6;
  }
</style>
