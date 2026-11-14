<script lang="ts">
  import { formatBytes, type StoragePlan } from '../lib/bench/storage/index.ts';
  import type { KernelOutcome } from '../lib/harness/orchestrator.ts';
  import Results from './Results.svelte';

  let {
    outcomes,
    plan,
    error,
    cleanup,
  }: {
    outcomes: KernelOutcome[];
    plan: StoragePlan;
    /** Why the storage tests stopped (e.g. the worker could not start), if they did. */
    error: string | undefined;
    /** Whether the run's test directory was removed afterwards; undefined while running. */
    cleanup: boolean | undefined;
  } = $props();
</script>

{#if !plan.ok}
  <p class="error" data-testid="storage-unavailable">{plan.message}</p>
{:else}
  <p class="muted" data-testid="storage-info" data-bytes={plan.fileBytes}>
    OPFS, sync access handle · test file {formatBytes(plan.fileBytes)}{plan.freeBytes !== undefined
      ? ` · this site may use ${formatBytes(plan.freeBytes)} more`
      : ''}
  </p>
  {#if plan.scaled}
    <p class="warn" data-testid="storage-scaled">
      The test file was made smaller to fit the storage this site may use. Results with a smaller
      file are not comparable with standard-size results.
    </p>
  {/if}
  {#if error}
    <p class="error" data-testid="storage-error">{error}</p>
  {/if}
  <Results {outcomes} />
  <p class="muted" data-testid="storage-caveat">
    OS file cache can inflate reads; the browser sits between the test and the disk. The test
    file is smaller than this PC's memory, so reads (and writes before the flush) may never reach
    the disk. Each result is checked by reading data back and comparing it with what was written.
  </p>
  {#if cleanup === false}
    <p class="warn" data-testid="storage-cleanup" data-removed="false">
      The test files could not be removed yet. They will be removed the next time this page loads.
    </p>
  {:else if cleanup === true}
    <p class="muted" data-testid="storage-cleanup" data-removed="true">Test files removed.</p>
  {/if}
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
