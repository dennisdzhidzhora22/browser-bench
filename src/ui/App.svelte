<script lang="ts">
  import { runInWorker } from '../lib/harness/run.ts';
  import { summarize, type SampleStats } from '../lib/harness/stats.ts';
  import { MIX_EXPECTED, MIX_SEED, MIX_SIZES, type MixSize } from '../lib/bench/mix.ts';

  const isolated = globalThis.crossOriginIsolated === true;
  const dev = import.meta.env.DEV;
  // `?smoke` selects the tiny size used by automated tests (docs/SPEC.md, section 3).
  const size: MixSize = new URLSearchParams(location.search).has('smoke') ? 'smoke' : 'standard';

  type State =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; checksumOk: boolean; stats: SampleStats; miterPerSec: number }
    | { kind: 'error'; message: string };

  let state: State = $state({ kind: 'idle' });

  async function run() {
    state = { kind: 'running' };
    try {
      const iterations = MIX_SIZES[size];
      const res = await runInWorker({ kernel: 'mix', seed: MIX_SEED, size: iterations, samples: 3 });
      const stats = summarize(res.times);
      state = {
        kind: 'done',
        checksumOk: res.checksumConsistent && res.checksum === MIX_EXPECTED[size],
        stats,
        miterPerSec: stats.median > 0 ? iterations / stats.median / 1000 : 0,
      };
    } catch (err) {
      state = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
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
  <p data-testid="isolated">Cross-origin isolated: yes</p>

  <button onclick={run} disabled={state.kind === 'running'} data-testid="run">
    {state.kind === 'running' ? 'Running…' : `Run smoke kernel (${size})`}
  </button>

  {#if state.kind === 'done'}
    <dl data-testid="result">
      <dt>Checksum</dt>
      <dd data-testid="checksum" data-ok={state.checksumOk}>{state.checksumOk ? 'ok' : 'MISMATCH'}</dd>
      <dt>Median</dt>
      <dd class="num">{state.stats.median.toFixed(2)} ms</dd>
      <dt>Throughput</dt>
      <dd class="num">{state.miterPerSec.toFixed(1)} M iter/s</dd>
      <dt>Spread</dt>
      <dd class="num">{(state.stats.spread * 100).toFixed(1)} %</dd>
    </dl>
  {:else if state.kind === 'error'}
    <p class="error" data-testid="error">{state.message}</p>
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
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
  }
  dd {
    margin: 0;
  }
</style>
