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
  import { WINDOW_MS } from '../lib/harness/drop.ts';
  import { holdWakeLock, type WakeState } from '../lib/harness/wakelock.ts';
  import { buildEnduranceRecord } from '../lib/store/record.ts';
  import type { EnduranceRecord } from '../lib/store/schema.ts';
  import type { SystemInfo } from '../lib/sysinfo/index.ts';
  import { SCORE_VERSION } from '../lib/scoring/constants.ts';
  import { webgpuKernels as gpuTests } from '../lib/bench/gpu/index.ts';
  import { freezeLook, look, setLook, SKINS, type Skin, type ThemeChoice } from './look.svelte.ts';

  const isolated = globalThis.crossOriginIsolated === true;
  /** The system strip: read once on load; run() waits for it so it never paints mid-test. */
  let sys: SystemInfo | undefined = $state();
  const sysReady = collectSystemInfo().then((s) => void (sys = s));
  const dev = import.meta.env.DEV;
  // `?smoke` selects the tiny sizes used by automated tests (docs/SPEC.md, section 3).
  const params = new URLSearchParams(location.search);
  const size: SizeId = params.has('smoke') ? 'smoke' : 'standard';
  // Test only: `?endurance=1m` or `?endurance=30s` replaces the 10/30/60-minute choice.
  const testLen = /^(\d+)(s|m)$/.exec(params.get('endurance') ?? '');
  const testMs = testLen ? Number(testLen[1]) * (testLen[2] === 'm' ? 60_000 : 1_000) : undefined;

  let selected: Record<ComponentId, boolean> = $state({
    'cpu-single': true,
    'cpu-multi': false,
    memory: false,
    gpu: false,
    storage: false,
  });
  let mode = $state<RunMode | 'endurance' | 'stress'>('quick');
  let minutes = $state(10);
  const looping = $derived(mode === 'endurance' || mode === 'stress');
  /** "No live updates": the page does not touch the DOM until the run ends. */
  let noLive = $state(false);
  let wake: WakeState | undefined = $state();
  /** Endurance / Stress chart: live, or the one just finished (Stress, cancelled). */
  // Raw: replaced whole once a second, never mutated, so Svelte need not proxy the series.
  let loopView: { rec: EnduranceRecord; windows: number; stress: boolean } | undefined = $state.raw();
  /** Benchmark mode: the window lost focus mid-run (Windows may then move the work to efficiency cores). */
  let focusLost = $state(false);
  let elapsed = $state('');
  let stopLoop: (() => Promise<void>) | undefined = $state();
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
    loopView = undefined;
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
  const toRun = $derived(
    components.filter((c) => selected[c.id] && c.kernels.length > 0 && !(looping && c.id === 'storage')),
  );
  const anySelected = $derived(toRun.length > 0);
  /** The Endurance results view, loaded on first use (SPEC 7 budget). */
  let LoopResults: typeof import('./EnduranceResults.svelte').default | undefined = $state();
  $effect(() => {
    if (shownLoop && !LoopResults) void import('./EnduranceResults.svelte').then((m) => (LoopResults = m.default));
  });
  const shownLoop = $derived(
    view?.endurance
      ? { rec: view.endurance, windows: Math.ceil(view.endurance.durationMs / view.endurance.windowMs), stress: false }
      : loopView,
  );
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
    // Wake Lock for every mode. Benchmark mode does not show its state: a
    // re-acquire after the tab returns must not write to the DOM mid-test.
    const loop = looping;
    await sysReady;
    freezeLook(true);
    const release = holdWakeLock((s) => {
      if (loop) wake = s;
    });
    // Benchmark mode: note a focus loss, shown only after the run (no DOM
    // writes mid-test). Unknown when the window never had focus (automation).
    focusLost = false;
    let focusSeen = document.hasFocus();
    let lost = false;
    const onFocus = () => (focusSeen = true);
    const onBlur = () => (lost ||= focusSeen);
    if (!loop) {
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
    }
    try {
      await (loop ? runLoop(mode === 'stress') : runBenchmark(mode as RunMode));
    } finally {
      release();
      wake = undefined;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      focusLost = lost;
      freezeLook(false);
    }
  }

  const running = $derived((phase as Phase).kind === 'running');
  /** Tests a component adds (the strip in Setup). */
  const testCount = (id: ComponentId, all: readonly KernelDef[]) =>
    (id === 'gpu' ? gpuTests.length : all.length) + multiKernels(id).length;
  const modeName = (m: string) => (m === 'full' ? 'Full' : m === 'endurance' ? 'Endurance' : 'Quick');
  /** "1085 pts · 11 tests · all checks passed" beside a component's heading. */
  function summary(ks: KernelRecord[], c?: ComponentRecord): string {
    const bad = ks.filter((k) => !k.valid).length;
    return (
      (c?.points != null ? `${c.points} pts · ` : '') +
      `${ks.length} test${ks.length === 1 ? '' : 's'} · ` +
      (bad ? `${bad} not valid` : 'all checks passed')
    );
  }
  /** Layout D numbers the sections that are shown, in page order. */
  const order = $derived(
    [
      'setup',
      shownLoop && 'loop',
      view && !view.endurance && 'score',
      rows.single.length && 'cpu-single',
      rows.multi.length && 'cpu-multi',
      rows.memory.length && 'memory',
      gpuPlan && 'gpu',
      storagePlan && 'storage',
      'history',
      'about',
    ].filter(Boolean),
  );
  const n = (key: string) => String(order.indexOf(key) + 1).padStart(2, '0');
  const shownSys = $derived(view?.system ?? sys);
  const gpuNames = $derived(
    view?.system.gpu?.join(' · ') ||
      gpuRuns.map((g) => g.target.label).join(' · ') ||
      (gpuPlan?.api === 'webgl2' ? 'WebGL2' : 'not tested yet'),
  );
  const screenText = (s: string) => s.replace(/^(\d+)x(\d+)@(.+)$/, '$1 × $2 @ $3×');

  async function runBenchmark(mode: RunMode) {
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
    loopView = undefined;
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

  /**
   * Endurance / Stress (SPEC 4, "How it works (M7)"). Every part runs at the
   * same time on its own workers; the page reads their shared arrays at most
   * once a second (never with "no live updates") and once at the end.
   */
  async function runLoop(stress: boolean) {
    const chosen = toRun;
    if (chosen.length === 0) return;
    pendingImport = undefined;
    view = undefined;
    viewSaved = false;
    loopView = undefined;
    outcomes = [];
    multiOutcomes = [];
    memOutcomes = [];
    memMulti = [];
    gpuRuns = [];
    gpuPlan = undefined;
    storagePlan = undefined;
    storageOutcomes = [];
    cancelRequested = false;
    elapsed = '';
    phase = { kind: 'running', index: 0, total: 1, current: 'starting' };
    // Loaded on first use: keeps Endurance and Stress out of the page-load budget (SPEC 7).
    const E = await import('../lib/harness/endurance.ts');
    const { parts, notes } = await E.planParts(chosen, size, workerCount ?? 1, gpuChoice);
    if (cancelRequested || parts.length === 0) {
      phase = cancelRequested ? { kind: 'cancelled' } : { kind: 'error', message: notes.join(' ') || 'nothing to run' };
      return;
    }
    const system = await collectSystemInfo();
    if (cancelRequested) {
      phase = { kind: 'cancelled' };
      return;
    }
    const ms = stress ? E.STRESS_MAX_MS : (testMs ?? minutes * 60_000);
    const runNotes = [...notes];
    const windows = Math.ceil(ms / WINDOW_MS);
    const l = E.startLoops({ parts, windows });
    active = l;
    let stopped = false;
    stopLoop = async () => {
      stopped = true;
      stopLoop = undefined;
      phase = { kind: 'running', index: 0, total: 1, current: 'Stopping' };
      await l.stop();
    };
    const show = (live: boolean) => {
      const rec = E.snapshot(l, ms, runNotes, live);
      let done = 0;
      for (const p of rec.parts) done = Math.max(done, p.values.length);
      loopView = { rec, windows: stress ? Math.max(done, 12) : windows, stress };
    };
    const t0 = performance.now();
    phase = { kind: 'running', index: 0, total: 1, current: stress ? 'Stress' : 'Endurance' };
    // At most one page update per second (SPEC 4); none with "no live updates".
    const timer = setInterval(() => {
      l.checkFocus(); // no DOM work
      if (noLive) return;
      elapsed = E.clock(performance.now() - t0) + (stress ? '' : ` / ${E.clock(ms)}`);
      show(true);
    }, 1_000);
    try {
      await l.done;
    } catch (err) {
      if (!(err instanceof Cancelled)) phase = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearInterval(timer);
      active = undefined;
      stopLoop = undefined;
    }
    show(false);
    if (cancelRequested) {
      phase = { kind: 'cancelled' };
      return;
    }
    if (phase.kind === 'error') return;
    phase = { kind: 'done' };
    if (stress || stopped) return; // Stress runs are shown, not saved
    try {
      view = buildEnduranceRecord(loopView!.rec, size, system);
      viewSaved = false;
      loopView = undefined;
      setHistory(mergeRuns(history, [view]).runs);
    } catch (err) {
      historyMessage = `This run could not be saved: ${err instanceof Error ? err.message : String(err)}`;
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

<div class="wrap">
  <nav class="top">
    <h1 class="brand">browser-bench<sup>score v{SCORE_VERSION}</sup></h1>
    <div class="links"><a href="#setup">Benchmark</a><a href="#history">History</a><a href="#about">About</a></div>
    <div class="right">
      <span class="muted">Nothing leaves this browser</span>
      <!-- Disabled during a run: a skin change restyles the page. -->
      <select
        aria-label="Skin"
        value={look.skin}
        disabled={running}
        onchange={(e) => setLook(e.currentTarget.value as Skin, look.theme)}
        data-testid="skin"
      >
        {#each SKINS as [id, label] (id)}<option value={id}>{label}</option>{/each}
      </select>
      <select
        aria-label="Light or dark"
        value={look.theme}
        disabled={running}
        onchange={(e) => setLook(look.skin, e.currentTarget.value as ThemeChoice)}
        data-testid="theme"
      >
        <option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </div>
  </nav>

  {#if !isolated}
    <section class="sec blocked" data-testid="not-isolated">
      <h2>This page is not cross-origin isolated</h2>
      <p>
        Benchmarks need the <code>Cross-Origin-Opener-Policy</code> and
        <code>Cross-Origin-Embedder-Policy</code> headers. Serve the app with
        <code>npm run preview</code> or <code>npm run dev</code>, not by opening the file.
      </p>
    </section>
  {:else}
    <div class="sys">
      <div><span class="k">Browser</span><b>{shownSys ? `${shownSys.browser} ${shownSys.version.split('.')[0]}` : '…'}</b></div>
      <div><span class="k">CPU</span><b>{shownSys?.cores ?? cores} threads</b></div>
      <div>
        <span class="k">Memory</span><b
          >{shownSys?.deviceMemory ? `${shownSys.deviceMemory >= 8 ? '≥' : '~'} ${shownSys.deviceMemory} GB` : '—'}</b
        >
      </div>
      <div><span class="k">GPU</span><b>{gpuNames}</b></div>
      <div><span class="k">Screen</span><b>{shownSys ? screenText(shownSys.screen) : '…'}</b></div>
      <div class="iso" data-testid="isolated">● Isolated · fine timers on{size === 'smoke' ? ' · smoke sizes' : ''}</div>
    </div>

    <section class="sec" id="setup">
      <div class="sh"><span class="idx">{n('setup')}</span><h2>Setup</h2><span class="aside">Choose components and a mode</span></div>
      <div class="setup">
        <div>
          <fieldset disabled={running} aria-label="Components">
            <div class="opts">
              {#each components as c (c.id)}
                <label class="opt" class:off={c.kernels.length === 0}>
                  <input
                    type="checkbox"
                    bind:checked={selected[c.id]}
                    disabled={c.kernels.length === 0}
                    data-testid="component-{c.id}"
                  />
                  {c.name}
                  <small
                    >{c.kernels.length === 0
                      ? '(not built yet)'
                      : c.id === 'cpu-multi'
                        ? `${testCount(c.id, c.kernels)} tests · ${workerCount ?? '?'} workers`
                        : `${testCount(c.id, c.kernels)} tests`}</small
                  >
                </label>
              {/each}
            </div>
            {#if needsWorkers}
              <div class="extra">
                <label>
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
                </label>
                <span class="muted">this browser reports {cores} logical cores</span>
              </div>
            {/if}
            {#if selected.gpu}
              <div class="extra" data-testid="gpu-choice">
                GPU to test:
                <label><input type="radio" bind:group={gpuChoice} value="high-performance" data-testid="gpu-fast" /> Fast</label>
                <label><input type="radio" bind:group={gpuChoice} value="low-power" data-testid="gpu-low" /> Power-saving</label>
                <label><input type="radio" bind:group={gpuChoice} value="both" data-testid="gpu-both" /> Both</label>
                <span class="muted">
                  (browsers pick the GPU for each; on PCs with two GPUs this is usually the dedicated one and the
                  built-in one)
                </span>
              </div>
            {/if}
          </fieldset>

          <fieldset class="modes" disabled={running} aria-label="Mode">
            <label class="mode"><input type="radio" bind:group={mode} value="quick" data-testid="mode-quick" /> Quick <small>a few min</small></label>
            <label class="mode"><input type="radio" bind:group={mode} value="full" data-testid="mode-full" /> Full <small>longer, steadier</small></label>
            <label class="mode">
              <input type="radio" bind:group={mode} value="endurance" data-testid="mode-endurance" /> Endurance
              {#if testMs}
                <small class="muted">(test length: {testMs / 1000} s)</small>
              {:else}
                <select bind:value={minutes} data-testid="endurance-minutes">
                  <option value={10}>10 min</option><option value={30}>30 min</option><option value={60}>60 min</option>
                </select>
              {/if}
            </label>
            <label class="mode"><input type="radio" bind:group={mode} value="stress" data-testid="mode-stress" /> Stress <small>until stopped</small></label>
          </fieldset>
          {#if looping}
            <p class="muted">
              Loops the selected parts at the same time and shows throughput over time. Memory runs its
              all-cores copy; storage is not looped (it would wear the drive).
              <strong data-testid="focus-hint">Keep this window in front during the run.</strong> On Windows a
              window in the background runs on the slower cores, so those windows are not counted.
            </p>
          {/if}
        </div>

        <div class="go">
          {#if phase.kind === 'running' && looping}
            {#if mode === 'stress'}
              <button class="run" onclick={() => stopLoop?.()} disabled={!stopLoop} data-testid="stop">Stop</button>
            {:else}
              <button class="run" onclick={cancel} data-testid="cancel">Cancel</button>
            {/if}
            <p class="prog">
              <span data-testid="progress">{phase.current}{elapsed ? ` · ${elapsed}` : ''}</span>
              <span class="muted" data-testid="wake">
                {wake === 'on' ? 'screen kept on' : wake ? 'the screen may sleep (no wake lock)' : ''}
              </span>
              <span class="muted">· keep this window in front</span>
            </p>
          {:else if phase.kind === 'running'}
            <button class="run" onclick={cancel} data-testid="cancel">Cancel</button>
            <div class="prog">
              <span data-testid="progress">{phase.index + 1} / {phase.total} · {phase.current}</span>
              {#if phase.total > 0}
                <div class="ticks">{#each { length: phase.total }, i (i)}<b class:d={i < phase.index}></b>{/each}</div>
              {/if}
            </div>
          {:else}
            <button
              class="run"
              onclick={run}
              disabled={!anySelected || (needsWorkers && workerCount === undefined)}
              data-testid="run">Run {mode === 'stress' ? 'stress test' : mode === 'endurance' ? 'endurance' : 'benchmark'}</button
            >
            <div class="prog">
              {#if phase.kind === 'done'}<span data-testid="status">Done</span>{/if}
              {#if phase.kind === 'cancelled'}<span data-testid="status">Cancelled</span>{/if}
              {#if focusLost}
                <span class="muted" data-testid="focus-lost">
                  · The window lost focus during the run: on Windows the work may have moved to slower cores, so
                  some results can be low.
                </span>
              {/if}
            </div>
          {/if}
          {#if phase.kind === 'error'}
            <p class="error" data-testid="error">{phase.message}</p>
          {/if}
          {#if looping || shownLoop}
            <label class="extra"><input type="checkbox" bind:checked={noLive} data-testid="no-live" /> No live updates</label>
          {/if}
        </div>
      </div>
    </section>

    {#if shownLoop}
      <section class="sec" id="loop">
        <div class="sh">
          <span class="idx">{n('loop')}</span><h2>{shownLoop.stress ? 'Stress' : 'Endurance'}</h2>
          <span class="aside">throughput over time</span>
        </div>
        {#if LoopResults}
          <LoopResults run={shownLoop.rec} windows={shownLoop.windows} stress={shownLoop.stress} />
        {/if}
      </section>
    {/if}

    {#if view && !view.endurance}
      <section class="sec" id="score">
        <div class="sh">
          <span class="idx">{n('score')}</span><h2>Score</h2>
          <span class="aside">{modeName(view.mode)} · {new Date(view.time).toLocaleString()}</span>
        </div>
        <Points run={view} saved={viewSaved} />
      </section>
    {/if}

    {#if rows.single.length > 0}
      <section class="sec c-cpu-single">
        <div class="sh">
          <span class="idx">{n('cpu-single')}</span><h2>CPU — single core</h2>
          <span class="aside">{summary(rows.single, comp('cpu-single'))}</span>
        </div>
        <Results kernels={rows.single} refs={refsOf(comp('cpu-single'))} prefix="cpu-single" />
      </section>
    {/if}

    {#if rows.multi.length > 0}
      <section class="sec c-cpu-multi">
        <div class="sh">
          <span class="idx">{n('cpu-multi')}</span><h2>CPU — all cores</h2>
          <span class="aside">{summary(rows.multi, comp('cpu-multi'))}</span>
        </div>
        <MultiResults kernels={rows.multi} refs={refsOf(comp('cpu-multi'))} />
      </section>
    {/if}

    {#if rows.memory.length > 0}
      <section class="sec c-memory">
        <div class="sh">
          <span class="idx">{n('memory')}</span><h2>Memory</h2>
          <span class="aside">{summary(rows.memory, comp('memory'))}</span>
        </div>
        <MemoryResults
          kernels={rows.memory}
          smoke={(view?.size ?? size) === 'smoke'}
          refs={refsOf(comp('memory'))}
          cores={view?.system.cores}
        />
      </section>
    {/if}

    {#if gpuPlan}
      <section class="sec c-gpu">
        <div class="sh">
          <span class="idx">{n('gpu')}</span><h2>GPU</h2>
          <span class="aside">{summary(rows.gpu.flat(), comp('gpu'))}</span>
        </div>
        {#if gpuPlan.api === 'none'}
          <GpuResults kernels={[]} info={{}} api="none" />
        {/if}
        {#if gpuPlan.sameGpu}
          <div class="muted" data-testid="gpu-same">
            <p>
              Both choices gave what the browser reports as the same GPU, so it was tested once. If this PC has a second
              GPU, the browser chose not to use it: web pages can only ask, and Chrome on Windows uses one GPU for
              everything. To test the other GPU:
            </p>
            <ul>
              <li>Turn on <code>chrome://flags/#force-high-performance-gpu</code> and restart Chrome, or</li>
              <li>
                Windows Settings → System → Display → Graphics → your browser → "High performance" (or "Power saving"),
                then restart it.
              </li>
              <li>
                To compare both, set one browser (e.g. Chrome) to one GPU and another (e.g. Edge) to the other.
                <code>chrome://gpu</code> shows which GPU a browser is using.
              </li>
            </ul>
          </div>
        {/if}
        {#each gpuRuns as g, i (g.target.preference)}
          <h3 data-testid="gpu-run-{g.target.preference}">
            {g.target.preference === 'high-performance' ? 'Fast GPU' : 'Power-saving GPU'}
          </h3>
          <GpuResults kernels={rows.gpu[i] ?? []} info={g.info} api={gpuPlan.api} refs={refsOf(comp('gpu', g.target.preference))} />
        {/each}
      </section>
    {/if}

    {#if storagePlan}
      <section class="sec c-storage">
        <div class="sh">
          <span class="idx">{n('storage')}</span><h2>Storage</h2>
          <span class="aside">{summary(rows.storage, comp('storage'))}</span>
        </div>
        <StorageResults
          kernels={rows.storage}
          plan={storagePlan}
          error={storageError}
          cleanup={storageCleanup}
          refs={refsOf(comp('storage'))}
        />
      </section>
    {/if}

    <History
      idx={n('history')}
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

    <section class="sec" id="about">
      <div class="sh"><span class="idx">{n('about')}</span><h2>About</h2></div>
      <p class="muted note">
        These are browser scores: this PC's speed through this browser. WebAssembly reaches roughly 70–95 % of native
        speed, and results move with browser versions, so each run records the browser and its version. For steady
        numbers, keep this window in front, plug in a laptop, and use the best-performance power mode.
      </p>
      <p class="muted">
        Browsers do not expose temperatures, fan speeds, power draw, the exact CPU model or raw disk access, so none
        are shown. Everything runs on this computer: no network requests after the page loads, and results stay in
        this browser unless you export them.
      </p>
    </section>
  {/if}

  <footer><span>Scores measure this PC through this browser.</span><span>score v{SCORE_VERSION}</span></footer>
</div>
