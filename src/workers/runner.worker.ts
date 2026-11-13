/// <reference lib="webworker" />
// CPU benchmark worker. Owns one wasm instance. Timing happens here, not on
// the page, so page work never lands inside a measurement.

import type { FromWorker, InitRequest, RunRequest, ToWorker } from '../lib/harness/protocol.ts';
import { fastestSpread } from '../lib/harness/stats.ts';
import { instantiateKernels, type KernelModule } from '../lib/harness/wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let mod: KernelModule | undefined;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/** Keeps the core busy so the OS schedules this thread on a fast core at full clock. */
function spin(m: KernelModule, ms: number): void {
  if (ms <= 0) return;
  const k = m.kernel('mix');
  k.prepare(1, 200_000);
  const end = performance.now() + ms;
  while (performance.now() < end) k.run();
}

async function init(req: InitRequest): Promise<void> {
  const m = mod ?? (await instantiateKernels(req.module));
  mod = m;
  spin(m, req.spinMs);
  reply({ type: 'ready', abi: m.abi_version() });
}

function run(m: KernelModule, req: RunRequest): void {
  const k = m.kernel(req.kernel);
  const run = k.run;

  const p0 = performance.now();
  const status = k.prepare(req.seed, req.size);
  const prepareMs = performance.now() - p0;
  if (status !== 0) {
    const why =
      status === 1 ? 'out of memory' : status === 2 ? 'invalid size' : `status ${status}`;
    throw new Error(`prepare failed (${why})`);
  }

  // Warm-up: lets the engine tier up the code. Not recorded.
  const checksum = run() >>> 0;
  let checksumConsistent = true;

  const times = new Float64Array(req.maxSamples);
  const scratch = new Float64Array(req.maxSamples);
  const start = performance.now();
  let n = 0;
  while (n < req.maxSamples) {
    const t0 = performance.now();
    const c = run();
    const t1 = performance.now();
    times[n++] = t1 - t0;
    // Everything below is after t1, so outside the timed region.
    if (c >>> 0 !== checksum) checksumConsistent = false;
    if (n < req.minSamples) continue;
    if (fastestSpread(times, n, req.minSamples, scratch) <= req.targetSpread) break;
    if (t1 - start > req.maxMs) break;
  }

  const taken = times.slice(0, n);
  reply(
    {
      type: 'result',
      id: req.id,
      kernel: req.kernel,
      checksum,
      checksumConsistent,
      prepareMs,
      times: taken,
    },
    [taken.buffer],
  );
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const req = event.data;
  if (req.type === 'init') {
    try {
      await init(req);
    } catch (err) {
      reply({ type: 'error', message: errorText(err) });
    }
    return;
  }
  try {
    if (!mod) throw new Error('worker not initialised');
    run(mod, req);
  } catch (err) {
    reply({ type: 'error', id: req.id, kernel: req.kernel, message: errorText(err) });
  }
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
