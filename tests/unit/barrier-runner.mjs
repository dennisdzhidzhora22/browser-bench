// Child process for tests/unit/barrier.test.ts. Runs the real barrier
// (src/workers/runner.worker.ts, measureGroup) on Node worker_threads and prints one JSON line.
//
// Usage: node barrier-runner.mjs '<json scenario>'
//   scenario = { threads, groups: [{ count, reps, plan }], prepare?: false }
//
// It lives in its own process because Node worker_threads inside the vitest fork crashed the
// fork now and then (exit 0xC0000005, about 1 run in 15 on Windows); here a hang or crash is
// reported by the parent as a normal test failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const scenario = JSON.parse(process.argv[2]);

// Same layout as CTRL in src/lib/harness/protocol.ts (the parent test asserts they agree).
const CTRL = { GEN: 0, ARRIVED: 1, STOP: 2, READY: 3, SAMPLES: 4, LENGTH: 8 };

const wasm = new WebAssembly.Module(readFileSync(here('../../src/generated/kernels.wasm')));
const workerUrl = pathToFileURL(here('../../src/workers/runner.worker.ts')).href;

const nextMessage = (w) =>
  new Promise((resolve, reject) => {
    w.once('message', resolve);
    w.once('error', reject);
  });
const threads = [];
const send = (w, msg) => {
  const reply = nextMessage(w);
  w.postMessage(msg);
  return reply;
};

try {
  // Started one at a time: starting several together makes Node (26.8.1, Windows) segfault now and then.
  for (let i = 0; i < scenario.threads; i++) {
    const w = new Worker(here('./worker-shim.mjs'), { workerData: { workerUrl } });
    threads.push(w);
    await nextMessage(w); // shim-ready
  }
  const init = await Promise.all(threads.map((w) => send(w, { type: 'init', module: wasm, spinMs: 0 })));
  const out = { init: init.map((r) => r.type), prepared: [], groups: [] };

  if (scenario.prepare !== false) {
    out.prepared = await Promise.all(
      threads.map((w) => send(w, { type: 'prepare', id: 0, kernel: 'mix', seed: 1, size: 1000 })),
    );
  }

  for (const g of scenario.groups) {
    const plan = { minSamples: 3, maxSamples: 9, targetSpread: 0.05, maxMs: 3000, ...g.plan };
    const control = new Int32Array(new SharedArrayBuffer(CTRL.LENGTH * 4));
    const times = new Float64Array(new SharedArrayBuffer(plan.maxSamples * g.count * 2 * 8));
    const replies = await Promise.all(
      threads.slice(0, g.count).map((w, index) =>
        send(w, {
          type: 'measure',
          id: 7,
          group: { control, times, index, count: g.count },
          reps: g.reps,
          ...plan,
        }),
      ),
    );
    out.groups.push({
      count: g.count,
      maxSamples: plan.maxSamples,
      replies,
      control: Array.from(control),
      times: Array.from(times),
    });
  }
  console.log(JSON.stringify(out));
} finally {
  await Promise.all(threads.map((w) => w.terminate()));
}
