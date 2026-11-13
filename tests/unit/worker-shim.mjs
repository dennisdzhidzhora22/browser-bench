// Runs src/workers/runner.worker.ts unchanged inside a Node worker_thread.
// The worker file expects a browser DedicatedWorkerGlobalScope: `self.postMessage` and an
// assignable `self.onmessage`. This shim provides both on top of `parentPort`.
import { parentPort, workerData } from 'node:worker_threads';

let handler;
globalThis.self = {
  postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer),
  set onmessage(fn) {
    handler = fn;
  },
  get onmessage() {
    return handler;
  },
};

await import(workerData.workerUrl);
parentPort.on('message', (data) => handler({ data }));
parentPort.postMessage({ type: 'shim-ready' });
