<script lang="ts">
  import { tick } from 'svelte';
  import { components } from '../lib/bench/components.ts';
  import type { ComponentId, KernelDef, SizeId } from '../lib/bench/types.ts';
  import {
    Cancelled,
    createGpuWorker,
    createStorageWorker,
    startRun,
    type KernelOutcome,
    type RunMode,
    type RunOptions,
  } from '../lib/harness/orchestrator.ts';
  import {
    newRunDir,
    planStorage,
    removeRunDir,
    storageDefsFor,
    sweepRunDirs,
    withRunLock,
    type StoragePlan,
  } from '../lib/bench/storage/index.ts';
  import StorageResults from './StorageResults.svelte';
  import {
    fallbackKernels,
    planGpus,
    webgpuKernels,
    type GpuApi,
    type GpuChoice,
    type GpuPlan,
    type GpuTarget,
  } from '../lib/bench/gpu/index.ts';
  import GpuResults from './GpuResults.svelte';
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
  import Points from './Points.svelte';
  import History from './History.svelte';
  import { collectSystemInfo } from '../lib/sysinfo/index.ts';
  import { buildRecord, kernelRecord, multiRecord, type RunView } from '../lib/store/record.ts';
  import { HISTORY_CAP, loadHistory, mergeRuns, saveHistory } from '../lib/store/history.ts';
  import type { ComponentRecord, KernelRecord, RunRecord } from '../lib/store/schema.ts';
  import { excluded, refsFor } from '../lib/scoring/score.ts';

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
  let gpuChoice: GpuChoice = $state('high-performance');
  /** One entry per GPU tested, in run order. */
  let gpuRuns: { target: GpuTarget; info: Record<string, string>; outcomes: KernelOutcome[] }[] =
    $state([]);
  let gpuPlan: GpuPlan | undefined = $state();
  let storagePlan: StoragePlan | undefined = $state();
  let storageOutcomes: KernelOutcome[] = $state([]);
  let storageError: string | undefined = $state();
  /** True once this run's OPFS directory is gone; false if removal kept failing. */
  let storageCleanup: boolean | undefined = $state();
  let active: { cancel(): void } | undefined;

  /** The record shown above the results: this run's once it finished, or one opened from history. */
  let view: RunRecord | undefined = $state();
  let viewSaved = $state(false);
  const loaded = loadHistory();
  let history: RunRecord[] = $state(loaded.runs);
  let historyMessage: string | undefined = $state(loaded.error);

  /** Replaces the history and saves it (after a run, never during one). */
  function setHistory(runs: RunRecord[], note?: string) {
    history = runs;
    historyMessage = saveHistory(runs) ?? note;
  }

  /** What the results tables show: the live run's outcomes, converted as each kernel finishes, or a saved run's. */
  interface Rows {
    single: KernelRecord[];
    multi: KernelRecord[];
    memory: KernelRecord[];
    /** One list per entry of gpuRuns. */
    gpu: KernelRecord[][];
    storage: KernelRecord[];
  }
  const kernelsOf = (r: RunRecord, id: ComponentId) => r.components.find((c) => c.id === id)?.kernels ?? [];
  const rows: Rows = $derived(
    view && viewSaved
      ? {
          single: kernelsOf(view, 'cpu-single'),
          multi: kernelsOf(view, 'cpu-multi'),
          memory: kernelsOf(view, 'memory'),
          gpu: view.components.filter((c) => c.id === 'gpu' && c.gpu).map((c) => c.kernels),
          storage: kernelsOf(view, 'storage'),
        }
      : {
          single: outcomes.map(kernelRecord),
          multi: multiOutcomes.map(multiRecord),
          memory: [...memOutcomes.map(kernelRecord), ...memMulti.map(multiRecord)],
          gpu: gpuRuns.map((g) => g.outcomes.map(kernelRecord)),
          storage: storageOutcomes.map(kernelRecord),
        },
  );

  /** Shows a saved run: its record drives the tables and the GPU and storage headers. */
  function open(r: RunRecord) {
    outcomes = [];
    multiOutcomes = [];
    memOutcomes = [];
    memMulti = [];
    storageOutcomes = [];
    const gpus = r.components.filter((c) => c.id === 'gpu');
    gpuPlan = gpus.length
      ? { api: gpus[0]!.gpu?.api ?? 'none', targets: [], sameGpu: gpus.some((c) => c.sameGpu) }
      : undefined;
    gpuRuns = gpus.flatMap((c) =>
      c.gpu ? [{ target: { preference: c.gpu.preference, label: c.gpu.label }, info: c.gpu.info, outcomes: [] }] : [],
    );
    const st = r.components.find((c) => c.id === 'storage');
    storagePlan = !st
      ? undefined
      : st.fileBytes === undefined
        ? { ok: false, message: st.error ?? 'not run' }
        : { ok: true, fileBytes: st.fileBytes, scaled: st.scaled ?? false };
    storageError = st?.fileBytes === undefined ? undefined : st.error;
    storageCleanup = undefined;
    view = r;
    viewSaved = true;
    phase = { kind: 'idle' };
  }

  /** An import that would push saved runs out, waiting for the user to confirm. */
  let pendingImport: { runs: RunRecord[]; lost: number; question: string } | undefined = $state();

  function imported(x: RunRecord[] | string, confirmed = 0) {
    pendingImport = undefined;
    if (typeof x === 'string') {
      historyMessage = x;
      return;
    }
    const m = mergeRuns(history, x);
    // `confirmed` is the count the user agreed to lose; ask again if it grew.
    if (m.dropped > confirmed) {
      pendingImport = {
        runs: x,
        lost: m.dropped,
        question: `Only the newest ${HISTORY_CAP} runs are kept: importing would remove ${m.dropped} of your saved run${m.dropped === 1 ? '' : 's'}. Import anyway?`,
      };
      return;
    }
    const skipped = x.length - m.added - m.tooOld;
    const s = (n: number) => (n === 1 ? '' : 's');
    setHistory(
      m.runs,
      `Imported ${m.added} run${s(m.added)}` +
        (skipped ? ` (${skipped} already in history)` : '') +
        (m.dropped ? `; ${m.dropped} oldest saved run${s(m.dropped)} dropped (limit ${HISTORY_CAP})` : '') +
        (m.tooOld ? `; ${m.tooOld} too old to keep (limit ${HISTORY_CAP})` : '') +
        '.',
    );
  }

  /** References to show beside a component's raw numbers: none when not comparable. */
  const refsOf = (c: ComponentRecord | undefined) =>
    view && c && !excluded(c, view.size, view.system.cores) ? refsFor(view.scoreVersion) : [];
  const comp = (id: ComponentId, pref?: string) =>
    view?.components.find((c) => c.id === id && (!pref || c.gpu?.preference === pref));

  // Test files from runs that crashed or were closed mid-run (SPEC 3.5).
  // run() awaits this before measuring, so it never overlaps a measurement.
  let sweeping: Promise<void> = isolated ? sweepRunDirs() : Promise.resolve();
  let cancelRequested = false;
  /** True while a storage run (or its cleanup) is in progress. */
  let inStorage = false;

  /** Kernels run on several workers: the all-cores CPU test, and all-cores copy. */
  const multiKernels = (id: ComponentId): readonly KernelDef[] =>
    id === 'memory' ? [memCopyMulti] : [];
  /** GPU tests for the API this browser offers. */
  const gpuKernelsFor = (api: GpuApi | undefined) =>
    api === 'webgpu' ? webgpuKernels : api === 'webgl2' ? fallbackKernels : [];
  /** Steps a component adds to the progress count. */
  const stepsFor = (id: ComponentId, all: readonly KernelDef[], p: GpuPlan | undefined) =>
    id === 'gpu'
      ? gpuKernelsFor(p?.api).length * (p?.targets.length ?? 0)
      : id === 'storage' && storagePlan?.ok === false
        ? 0
        : all.length + multiKernels(id).length;
  const toRun = $derived(components.filter((c) => selected[c.id] && c.kernels.length > 0));
  const anySelected = $derived(toRun.length > 0);
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
    const chosen = toRun;
    if (chosen.length === 0) return;
    pendingImport = undefined; // history changes during a run; the user can import again after
    outcomes = [];
    multiOutcomes = [];
    memOutcomes = [];
    memMulti = [];
    gpuRuns = [];
    gpuPlan = undefined;
    storagePlan = undefined;
    storageOutcomes = [];
    storageError = undefined;
    storageCleanup = undefined;
    view = undefined;
    viewSaved = false;
    cancelRequested = false;
    phase = { kind: 'running', index: 0, total: 0, current: 'starting' };
    // Before any measurement: finish the load-time sweep (and re-sweep when
    // storage runs, so same-tab leftovers go and the quota estimate is right),
    // then the API and the distinct GPUs decide the GPU steps, and the quota
    // left decides the storage file size.
    phase = { kind: 'running', index: 0, total: 0, current: 'Removing old test files' };
    await sweeping;
    if (chosen.some((c) => c.id === 'storage')) await (sweeping = sweepRunDirs());
    if (cancelRequested) {
      phase = { kind: 'cancelled' };
      return;
    }
    if (chosen.some((c) => c.id === 'gpu')) gpuPlan = await planGpus(gpuChoice);
    if (chosen.some((c) => c.id === 'storage')) storagePlan = await planStorage(size);
    // System info is read once, before any measurement (SPEC 3.6).
    const system = await collectSystemInfo();
    const total = chosen.reduce((n, c) => n + stepsFor(c.id, c.kernels, gpuPlan), 0);
    phase = { kind: 'running', index: 0, total, current: 'starting' };
    let offset = 0;
    const hook = (name: string) => {
      const base = offset;
      return async (index: number, def: KernelDef) => {
        phase = { kind: 'running', index: base + index, total, current: `${name}: ${def.name}` };
        await settle();
      };
    };
    const single = async (
      name: string,
      kernels: readonly KernelDef[],
      out: KernelOutcome[],
      extra: Partial<RunOptions> = {},
    ) => {
      if (kernels.length === 0) return;
      const r = startRun({
        kernels,
        size,
        mode,
        beforeKernel: hook(name),
        afterKernel: (_i, o) => void out.push(o),
        ...extra,
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
    /**
     * All files go in one fresh OPFS directory, removed afterwards on every
     * path: done, failed or cancelled (Worker.terminate() gives the worker no
     * chance to clean up). A worker failure stops only the storage tests.
     */
    const runStorage = async (name: string, fileBytes: number) => {
      const dir = newRunDir();
      await withRunLock(dir, async () => {
        inStorage = true;
        try {
          await single(name, storageDefsFor(size, fileBytes), storageOutcomes, {
            makeWorker: createStorageWorker,
            storage: { dir },
          });
        } catch (err) {
          if (err instanceof Cancelled || cancelRequested) throw err;
          storageError = err instanceof Error ? err.message : String(err);
        } finally {
          if (phase.kind === 'running') {
            phase = {
              ...phase,
              current: cancelRequested ? 'Cancelling: removing test files' : `${name}: removing test files`,
            };
          }
          storageCleanup = await removeRunDir(dir);
          inStorage = false;
        }
      });
    };
    try {
      for (const c of chosen) {
        if (cancelRequested) throw new Cancelled();
        if (c.id === 'cpu-multi') await multi(c.name, c.kernels, multiOutcomes);
        else if (c.id === 'memory') {
          await single(c.name, c.kernels, memOutcomes);
          if (cancelRequested) throw new Cancelled();
          await multi(c.name, multiKernels('memory'), memMulti);
        } else if (c.id === 'gpu') {
          for (const target of gpuPlan?.targets ?? []) {
            if (cancelRequested) throw new Cancelled();
            gpuRuns.push({ target, info: {}, outcomes: [] });
            const entry = gpuRuns[gpuRuns.length - 1]!;
            await single(`GPU (${target.label})`, gpuKernelsFor(gpuPlan?.api), entry.outcomes, {
              makeWorker: createGpuWorker,
              gpu: {
                preference: target.preference,
                api: gpuPlan?.api === 'webgl2' ? 'webgl2' : 'webgpu',
              },
              onReady: (info) => (entry.info = info),
            });
          }
        } else if (c.id === 'storage') {
          if (!storagePlan?.ok) continue; // StorageResults shows why
          await runStorage(c.name, storagePlan.fileBytes);
        } else await single(c.name, c.kernels, outcomes);
      }
      phase = { kind: 'done' };
    } catch (err) {
      phase =
        err instanceof Cancelled
          ? { kind: 'cancelled' }
          : { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    } finally {
      active = undefined;
    }
    // Scoring and saving happen after the last measurement (SPEC 7). A failure
    // here is reported in History; the run itself stays done.
    try {
      const live: RunView = {
        outcomes,
        multiOutcomes,
        memOutcomes,
        memMulti,
        gpuPlan,
        gpuRuns,
        storagePlan,
        storageOutcomes,
        storageError,
      };
      view = buildRecord(live, chosen.map((c) => c.id), mode, size, system);
      setHistory(mergeRuns(history, [view]).runs);
    } catch (err) {
      historyMessage = `This run could not be scored or saved: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function cancel() {
    cancelRequested = true;
    active?.cancel();
    // Removing a cancelled storage run's files can take seconds (file lock).
    if (phase.kind === 'running' && inStorage) {
      phase = { ...phase, current: 'Cancelling: removing test files' };
    }
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
    {#if selected.gpu}
      <div class="workers" data-testid="gpu-choice">
        GPU to test:
        <label class="inline">
          <input type="radio" bind:group={gpuChoice} value="high-performance" data-testid="gpu-fast" />
          Fast
        </label>
        <label class="inline">
          <input type="radio" bind:group={gpuChoice} value="low-power" data-testid="gpu-low" />
          Power-saving
        </label>
        <label class="inline">
          <input type="radio" bind:group={gpuChoice} value="both" data-testid="gpu-both" />
          Both
        </label>
        <span class="muted">
          (browsers pick the GPU for each; on PCs with two GPUs this is usually the dedicated one
          and the built-in one)
        </span>
      </div>
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
      <button onclick={run} disabled={!anySelected || (needsWorkers && workerCount === undefined)} data-testid="run"
        >Run</button
      >
      {#if phase.kind === 'done'}<span data-testid="status">Done</span>{/if}
      {#if phase.kind === 'cancelled'}<span data-testid="status">Cancelled</span>{/if}
    {/if}
  </p>

  {#if phase.kind === 'error'}
    <p class="error" data-testid="error">{phase.message}</p>
  {/if}

  {#if view}
    <Points run={view} saved={viewSaved} />
  {/if}

  {#if rows.single.length > 0}
    <h2>CPU — single core</h2>
    <Results kernels={rows.single} refs={refsOf(comp('cpu-single'))} prefix="cpu-single" />
  {/if}

  {#if rows.multi.length > 0}
    <h2>CPU — all cores</h2>
    <MultiResults kernels={rows.multi} refs={refsOf(comp('cpu-multi'))} />
  {/if}

  {#if rows.memory.length > 0}
    <h2>Memory</h2>
    <MemoryResults
      kernels={rows.memory}
      smoke={(view?.size ?? size) === 'smoke'}
      refs={refsOf(comp('memory'))}
      cores={view?.system.cores}
    />
  {/if}

  {#if gpuPlan}
    <h2>GPU</h2>
    {#if gpuPlan.api === 'none'}
      <GpuResults kernels={[]} info={{}} api="none" />
    {/if}
    {#if gpuPlan.sameGpu}
      <div class="muted" data-testid="gpu-same">
        <p>
          Both choices gave what the browser reports as the same GPU, so it was tested once. If this PC has a second GPU,
          the browser chose not to use it: web pages can only ask, and Chrome on Windows uses one
          GPU for everything. To test the other GPU:
        </p>
        <ul>
          <li>
            Turn on <code>chrome://flags/#force-high-performance-gpu</code> and restart Chrome, or
          </li>
          <li>
            Windows Settings → System → Display → Graphics → your browser → "High performance"
            (or "Power saving"), then restart it.
          </li>
          <li>
            To compare both, set one browser (e.g. Chrome) to one GPU and another (e.g. Edge) to
            the other. <code>chrome://gpu</code> shows which GPU a browser is using.
          </li>
        </ul>
      </div>
    {/if}
    {#each gpuRuns as g, i (g.target.preference)}
      <h3 data-testid="gpu-run-{g.target.preference}">
        {g.target.preference === 'high-performance' ? 'Fast GPU' : 'Power-saving GPU'}
      </h3>
      <GpuResults
        kernels={rows.gpu[i] ?? []}
        info={g.info}
        api={gpuPlan.api}
        refs={refsOf(comp('gpu', g.target.preference))}
      />
    {/each}
  {/if}

  {#if storagePlan}
    <h2>Storage</h2>
    <StorageResults
      kernels={rows.storage}
      plan={storagePlan}
      error={storageError}
      cleanup={storageCleanup}
      refs={refsOf(comp('storage'))}
    />
  {/if}

  <History
    runs={history}
    message={historyMessage}
    disabled={phase.kind === 'running'}
    onopen={open}
    onchange={(runs) => setHistory(runs)}
    onimport={imported}
    pending={pendingImport?.question}
    onconfirm={(yes) =>
      yes && pendingImport ? imported(pendingImport.runs, pendingImport.lost) : (pendingImport = undefined)}
  />

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
  .workers input[type='number'] {
    width: 4rem;
  }
  .inline {
    display: inline;
    margin-right: 0.75rem;
  }
  .off {
    opacity: 0.6;
  }
</style>
