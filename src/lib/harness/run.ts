// Page-side helper: start a worker, run one kernel, return the result, end
// the worker. M1 replaces this with the full orchestrator.

import type { FromWorker, RunRequest, RunResult } from './protocol.ts';

export function runInWorker(req: Omit<RunRequest, 'type'>): Promise<RunResult> {
  const worker = new Worker(new URL('../../workers/runner.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise<RunResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      worker.terminate();
      const msg = event.data;
      if (msg.type === 'result') resolve(msg);
      else reject(new Error(msg.message));
    };
    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error('worker reply could not be read'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'worker failed to start'));
    };
    worker.postMessage({ type: 'run', ...req } satisfies RunRequest);
  });
}
