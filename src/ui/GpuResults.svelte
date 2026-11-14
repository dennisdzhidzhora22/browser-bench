<script lang="ts">
  import { isFallback, type GpuApi } from '../lib/bench/gpu/index.ts';
  import type { KernelOutcome } from '../lib/harness/orchestrator.ts';
  import Results from './Results.svelte';

  let {
    outcomes,
    info,
    api,
  }: { outcomes: KernelOutcome[]; info: Record<string, string>; api: GpuApi | undefined } =
    $props();

  const fallback = $derived(outcomes.some((o) => isFallback(o.def)));
  const described = $derived(
    Object.entries(info)
      .filter(([k]) => k !== 'api')
      .map(([, v]) => v)
      .join(' · '),
  );
</script>

{#if api === 'none'}
  <p class="error" data-testid="gpu-none">
    This browser offers neither WebGPU nor WebGL2, so the GPU tests cannot run.
  </p>
{:else}
  <p class="muted" data-testid="gpu-info">
    {info['api'] ?? ''}{described ? ` · ${described}` : ''}
  </p>
  {#if fallback}
    <p class="warn" data-testid="gpu-fallback">
      Fallback: WebGPU is not available here, so only the WebGL2 pixel-shading test ran. Its
      numbers are not comparable with WebGPU results.
    </p>
  {/if}
  <Results {outcomes} />
  <p class="muted">
    GPU tests draw to an off-screen texture, so the display refresh rate does not cap them.
    Each result is checked by reading part of the output back and comparing it with a CPU
    reference.
  </p>
{/if}

<style>
  .muted {
    font-size: 0.85em;
    opacity: 0.6;
  }
  .warn {
    border-left: 4px solid #d97706;
    padding-left: 0.8rem;
  }
  .error {
    border-left: 4px solid #dc2626;
    padding-left: 0.8rem;
  }
</style>
