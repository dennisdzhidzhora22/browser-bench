// Shared shapes for GPU tests (docs/SPEC.md, 3.4). Each test lives in its own
// file and exports a KernelDef plus a factory for a GpuKernel.
//
// GPU float results differ slightly between GPUs and drivers, so GPU tests do
// not use bit-exact checksums. Instead each test reads back part of its output
// after the last timed batch and checks it against a CPU reference within a
// tolerance (`validate`). The worker reports checksum 1 when that passes and 0
// when it fails, so every GPU KernelDef has expected = 1 at every size.

export interface GpuContext {
  /** Present for WebGPU tests. */
  device?: GPUDevice;
  /** Present for the WebGL2 fallback test. */
  gl?: WebGL2RenderingContext;
}

export interface GpuKernel {
  /**
   * Create buffers, textures and pipelines for `size`, upload inputs. Untimed.
   * Throw on any failure (the worker reports it as this test's error).
   */
  prepare(ctx: GpuContext, seed: number, size: number): Promise<void>;
  /**
   * Encode and submit `reps` iterations, then resolve when the GPU has finished
   * all of them (WebGPU: queue.onSubmittedWorkDone(); WebGL2: a 1-pixel
   * readPixels). The worker times this call. Do no readback or validation here.
   */
  runBatch(reps: number): Promise<void>;
  /** Read back and check the output of the last batch. Untimed. */
  validate(): Promise<{ ok: boolean; detail?: string }>;
  /** Free GPU resources. Must not throw. */
  dispose(): void;
}

export type GpuKernelFactory = () => GpuKernel;

/** Expected value meaning "output validated" (see the note at the top). */
export const GPU_VALID = 1;

/** Target length of one timed GPU sample, standard sizes. Smoke sizes use 0 (one iteration). */
export const GPU_TARGET_MS = 200;
