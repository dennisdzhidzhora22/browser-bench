/// <reference lib="webworker" />
// CPU benchmark worker. Owns one wasm instance. Timing happens here, not on
// the page, so page work never lands inside a measurement.

import kernelsUrl from '../generated/kernels.wasm?url';
import type { FromWorker, RunRequest, ToWorker } from '../lib/harness/protocol.ts';
import { instantiateKernels, type KernelModule } from '../lib/harness/wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let mod: KernelModule | undefined;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function run(m: KernelModule, req: RunRequest): void {
  const k = m.kernel(req.kernel);
  const run = k.run;

  const p0 = performance.now();
  const status = k.prepare(req.seed, req.size);
  const prepareMs = performance.now() - p0;
  if (status !== 0) {
    const why = status === 1 ? 'out of memory' : `status ${status}`;
    throw new Error(`prepare failed (${why})`);
  }

  // Warm-up: lets the engine tier up the code. Not recorded.
  const checksum = run() >>> 0;
  let checksumConsistent = true;

  const times = new Float64Array(req.samples);
  for (let i = 0; i < req.samples; i++) {
    const t0 = performance.now();
    const c = run();
    const t1 = performance.now();
    times[i] = t1 - t0;
    // Compared after t1, so it is outside the timed region.
    if (c >>> 0 !== checksum) checksumConsistent = false;
  }

  reply(
    {
      type: 'result',
      id: req.id,
      kernel: req.kernel,
      checksum,
      checksumConsistent,
      prepareMs,
      times,
    },
    [times.buffer],
  );
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const req = event.data;
  if (req.type === 'init') {
    try {
      const m = (mod ??= await WebAssembly.compileStreaming(fetch(kernelsUrl)).then(
        instantiateKernels,
      ));
      reply({ type: 'ready', abi: m.abi_version() });
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
