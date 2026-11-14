/// <reference lib="webworker" />
// GPU benchmark worker. Same init/run protocol as runner.worker.ts, but it
// drives WebGPU (or WebGL2 for the fallback test) instead of wasm kernels.
// The `module` in the init message is ignored.

import { gpuFactories } from '../lib/bench/gpu/index.ts';
import type { GpuContext, GpuKernel } from '../lib/bench/gpu/types.ts';
import type {
  FromWorker,
  GpuPreference,
  RunRequest,
  ToWorker,
} from '../lib/harness/protocol.ts';
import { fastestSpread } from '../lib/harness/stats.ts';

declare const self: DedicatedWorkerGlobalScope;

/** Upper bound on repetitions per sample, so a broken timing cannot stall a run. */
const MAX_REPS = 100_000;

let ctx: GpuContext | undefined;
let lost: string | undefined;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function init(pref: GpuPreference): Promise<Record<string, string>> {
  const info: Record<string, string> = { preference: pref };
  const adapter = await self.navigator.gpu?.requestAdapter({ powerPreference: pref });
  if (adapter) {
    const device = await adapter.requestDevice();
    device.lost.then((l) => {
      lost = `GPU device lost: ${l.message || l.reason}`;
    });
    ctx = { device };
    const a = adapter.info;
    info['api'] = 'WebGPU';
    for (const k of ['vendor', 'architecture', 'device', 'description'] as const) {
      if (a[k]) info[k] = a[k];
    }
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

    // Warm-up (pipelines compile lazily on some drivers), then calibrate reps
    // from one more single repetition so each sample lasts about targetMs.
    await timeBatch(k, 1);
    const target = req.targetMs ?? 0;
    let reps = 1;
    if (target > 0) {
      const one = await timeBatch(k, 1);
      reps = one > 0 ? Math.min(MAX_REPS, Math.max(1, Math.ceil(target / one))) : MAX_REPS;
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
      const info = ctx ? {} : await init(req.gpuPreference ?? 'high-performance');
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
