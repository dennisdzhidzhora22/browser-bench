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
  import {
    clampWorkers,
    MAX_WORKERS_PER_CORE,
    startMultiRun,
    type MultiOutcome,
  } from '../lib/harness/multi.ts';
  import { memCopyMulti } from '../lib/bench/memory/index.ts';
  import MemoryResults from './MemoryResults.svelte';
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
  const maxWorkers = cores * MAX_WORKERS_PER_CORE;
  let workers: number = $state(cores);
  const workerCount = $derived(clampWorkers(workers, maxWorkers));

  type Phase =
    | { kind: 'idle' }
    | { kind: 'running'; index: number; total: number; current: string }
    | { kind: 'done' }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string };

  let phase: Phase = $state({ kind: 'idle' });
  let outcomes: KernelOutcome[] = $state([]);
  let multiOutcomes: MultiOutcome[] = $state([]);
  let memOutcomes: KernelOutcome[] = $state([]);
  let memMulti: MultiOutcome[] = $state([]);
  let active: { cancel(): void } | undefined;
  let cancelRequested = false;

  /** Kernels run on several workers: the all-cores CPU test, and all-cores copy. */
  const multiKernels = (id: ComponentId): readonly KernelDef[] =>
    id === 'memory' ? [memCopyMulti] : [];
  const steps = (id: ComponentId, kernels: readonly KernelDef[]) =>
    kernels.length + multiKernels(id).length;
  const toRun = $derived(components.filter((c) => selected[c.id] && c.kernels.length > 0));
  const totalKernels = $derived(toRun.reduce((n, c) => n + steps(c.id, c.kernels), 0));
  const needsWorkers = $derived(selected['cpu-multi'] || selected.memory);

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
    memOutcomes = [];
    memMulti = [];
    cancelRequested = false;
    phase = { kind: 'running', index: 0, total, current: 'starting' };
    let offset = 0;
    const hook = (name: string) => {
      const base = offset;
      return async (index: number, def: KernelDef) => {
        phase = { kind: 'running', index: base + index, total, current: `${name}: ${def.name}` };
        await settle();
      };
    };
    const single = async (name: string, kernels: readonly KernelDef[], out: KernelOutcome[]) => {
      const r = startRun({
        kernels,
        size,
        mode,
        beforeKernel: hook(name),
        afterKernel: (_i, o) => void out.push(o),
      });
      active = r;
      await r.done;
      offset += kernels.length;
    };
    const multi = async (name: string, kernels: readonly KernelDef[], out: MultiOutcome[]) => {
      const r = startMultiRun({
        kernels,
        size,
        mode,
        workers: workerCount ?? 0,
        maxWorkers,
        beforeKernel: hook(name),
        afterKernel: (_i, o) => void out.push(o),
      });
      active = r;
      await r.done;
      offset += kernels.length;
    };
    try {
      for (const c of plan) {
        if (cancelRequested) throw new Cancelled();
        if (c.id === 'cpu-multi') await multi(c.name, c.kernels, multiOutcomes);
        else if (c.id === 'memory') {
          await single(c.name, c.kernels, memOutcomes);
          if (cancelRequested) throw new Cancelled();
          await multi(c.name, multiKernels('memory'), memMulti);
        } else await single(c.name, c.kernels, outcomes);
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
    {/each}
    {#if needsWorkers}
      <label class="workers">
        Workers for all-cores tests
        <input
            type="number"
            min="1"
            max={maxWorkers}
            step="1"
            bind:value={workers}
            onblur={() => {
              if (workerCount !== undefined) workers = workerCount;
            }}
            data-testid="workers"
          />
        <span class="muted">(this browser reports {cores} logical cores)</span>
      </label>
    {/if}
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
      <button onclick={run} disabled={totalKernels === 0 || (needsWorkers && workerCount === undefined)} data-testid="run"
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

  {#if memOutcomes.length > 0 || memMulti.length > 0}
    <h2>Memory</h2>
    <MemoryResults outcomes={memOutcomes} multi={memMulti} smoke={size === 'smoke'} />
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
  .workers {
    margin-top: 0.5rem;
  }
  .workers input {
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
