/// <reference lib="webworker" />
// GPU benchmark worker. Same init/run protocol as runner.worker.ts, but it
// drives WebGPU (or WebGL2 for the fallback test) instead of wasm kernels.
// The `module` in the init message is ignored.

import { gpuFactories, isSoftware } from '../lib/bench/gpu/index.ts';
import type { GpuContext, GpuKernel } from '../lib/bench/gpu/types.ts';
import type {
  FromWorker,
  GpuInit,
  RunRequest,
  ToWorker,
} from '../lib/harness/protocol.ts';
import { fastestSpread } from '../lib/harness/stats.ts';

declare const self: DedicatedWorkerGlobalScope;

/** Upper bound on repetitions per sample, so a broken timing cannot stall a run. */
const MAX_REPS = 100_000;

let ctx: GpuContext | undefined;
let lost: string | undefined;
/** First uncaptured WebGPU error (e.g. a timed submit that failed validation and did no work). */
let gpuError: string | undefined;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function init(gpu: GpuInit): Promise<Record<string, string>> {
  const pref = gpu.preference;
  const info: Record<string, string> = { preference: pref };
  if (gpu.api === 'webgpu') {
    // The page planned WebGPU, so a missing adapter here is an error, not a
    // silent switch to the (not comparable) WebGL2 test.
    const adapter = await self.navigator.gpu?.requestAdapter({ powerPreference: pref });
    if (!adapter) throw new Error('the page found a WebGPU adapter but this worker did not');
    const device = await adapter.requestDevice();
    device.lost.then((l) => {
      lost = `GPU device lost: ${l.message || l.reason}`;
    });
    device.addEventListener('uncapturederror', (e) => {
      gpuError ??= `WebGPU error: ${(e as GPUUncapturedErrorEvent).error.message}`;
    });
    ctx = { device };
    const a = adapter.info;
    info['api'] = 'WebGPU';
    for (const k of ['vendor', 'architecture', 'device', 'description'] as const) {
      if (a[k]) info[k] = a[k];
    }
    if (isSoftware(adapter)) info['software'] = 'software adapter (runs on the CPU)';
    return info;
  }
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
    antialias: false,
    depth: false,
    powerPreference: pref,
  });
  if (!gl) throw new Error('neither WebGPU nor WebGL2 is available');
  ctx = { gl };
  info['api'] = 'WebGL2 (fallback)';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  info['renderer'] = String(
    gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? 'unknown',
  );
  return info;
}

async function timeBatch(k: GpuKernel, reps: number): Promise<number> {
  const t0 = performance.now();
  await k.runBatch(reps);
  const dt = performance.now() - t0;
  if (lost) throw new Error(lost);
  if (gpuError) throw new Error(gpuError);
  return dt;
}

async function run(c: GpuContext, req: RunRequest): Promise<void> {
  const factory = gpuFactories[req.kernel];
  if (!factory) throw new Error(`GPU test "${req.kernel}" not found`);
  const k = factory();
  try {
    const p0 = performance.now();
    await k.prepare(c, req.seed, req.size);
    const prepareMs = performance.now() - p0;

    // Warm-up: the first batch pays lazy pipeline compilation on some drivers,
    // so it is never used for calibration. Then calibrate reps so each sample
    // lasts about targetMs. A single rep includes the fixed submit/readback
    // latency and overstates the per-rep cost, so double the batch until it
    // takes at least a quarter of the target, then scale.
    await timeBatch(k, 1);
    const target = req.targetMs ?? 0;
    let reps = 1;
    let short = false;
    if (target > 0) {
      let probe = 1;
      let dt = await timeBatch(k, probe);
      while (dt < target / 4 && probe < MAX_REPS) {
        probe = Math.min(MAX_REPS, probe * 2);
        dt = await timeBatch(k, probe);
      }
      reps = dt > 0 ? Math.min(MAX_REPS, Math.max(1, Math.round((target * probe) / dt))) : MAX_REPS;
      short = reps === MAX_REPS && dt * (reps / probe) < target / 2;
      await timeBatch(k, reps); // warm at the real batch size too
    }

    const times = new Float64Array(req.maxSamples);
    const scratch = new Float64Array(req.maxSamples);
    const start = performance.now();
    let n = 0;
    while (n < req.maxSamples) {
      times[n++] = await timeBatch(k, reps);
      if (n < req.minSamples) continue;
      if (fastestSpread(times, n, req.minSamples, scratch) <= req.targetSpread) break;
      if (performance.now() - start > req.maxMs) break;
    }

    const check = await k.validate();
    const taken = times.slice(0, n);
    reply(
      {
        type: 'result',
        id: req.id,
        kernel: req.kernel,
        checksum: check.ok ? 1 : 0,
        checksumConsistent: true,
        prepareMs,
        times: taken,
        reps,
        ...(short ? { short } : {}),
        ...(check.ok || !check.detail ? {} : { detail: check.detail }),
      },
      [taken.buffer],
    );
  } finally {
    k.dispose();
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const req = event.data;
  if (req.type === 'init') {
    try {
      const info = ctx
        ? {}
        : await init(req.gpu ?? { preference: 'high-performance', api: 'webgpu' });
      reply({ type: 'ready', abi: 0, info });
    } catch (err) {
      reply({ type: 'error', message: errorText(err) });
    }
    return;
  }
  if (req.type !== 'run') {
    reply({ type: 'error', id: req.id, message: `GPU worker does not support "${req.type}"` });
    return;
  }
  try {
    if (!ctx) throw new Error('worker not initialised');
    if (lost) throw new Error(lost);
    await run(ctx, req);
  } catch (err) {
    reply({ type: 'error', id: req.id, kernel: req.kernel, message: errorText(err) });
  }
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
