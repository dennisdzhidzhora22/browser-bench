<script lang="ts">
  import { isFallback, type GpuApi } from '../lib/bench/gpu/index.ts';
  import type { Reference } from '../lib/scoring/score.ts';
  import type { KernelRecord } from '../lib/store/schema.ts';
  import Results from './Results.svelte';

  let {
    kernels,
    info,
    api,
    refs = [],
  }: {
    kernels: KernelRecord[];
    info: Record<string, string>;
    api: GpuApi | undefined;
    refs?: Reference[];
  } = $props();

  const fallback = $derived(kernels.some((k) => isFallback(k.key)));
  const described = $derived(
    Object.entries(info)
      .filter(([k]) => k !== 'api' && k !== 'preference')
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
  <Results {kernels} {refs} prefix="gpu" />
  <p class="muted">
    GPU tests draw to an off-screen texture, so the display refresh rate does not cap them.
    Each result is checked by reading part of the output back and comparing it with a CPU
    reference.
  </p>
{/if}

