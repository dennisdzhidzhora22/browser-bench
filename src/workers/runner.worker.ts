/// <reference lib="webworker" />
// CPU benchmark worker. Owns one wasm instance. Timing happens here, not on
// the page, so page work never lands inside a measurement.

import kernelsUrl from '../generated/kernels.wasm?url';
import type { FromWorker, ToWorker } from '../lib/harness/protocol.ts';
import { instantiateKernels, type KernelExports } from '../lib/harness/wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let kernels: Promise<KernelExports> | undefined;

function load(): Promise<KernelExports> {
  kernels ??= WebAssembly.compileStreaming(fetch(kernelsUrl)).then(instantiateKernels);
  return kernels;
}

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const req = event.data;
  try {
    const k = await load();
    const kernel = k.kernel_mix;

    // Warm-up: lets the engine tier up the module. Not recorded.
    const checksum = kernel(req.seed, req.size) >>> 0;
    let checksumConsistent = true;

    const times = new Float64Array(req.samples);
    for (let i = 0; i < req.samples; i++) {
      const t0 = performance.now();
      const c = kernel(req.seed, req.size);
      const t1 = performance.now();
      times[i] = t1 - t0;
      // Compared after t1, so it is outside the timed region.
      if (c >>> 0 !== checksum) checksumConsistent = false;
    }

    reply({ type: 'result', kernel: req.kernel, checksum, checksumConsistent, times }, [
      times.buffer,
    ]);
  } catch (err) {
    reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
