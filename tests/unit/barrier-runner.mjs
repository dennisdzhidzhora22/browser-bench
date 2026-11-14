// Child process for tests/unit/barrier.test.ts. Runs the real barrier
// (src/workers/runner.worker.ts, measureGroup) on Node worker_threads and prints one JSON line.
//
// Usage: node barrier-runner.mjs '<json scenario>'
//   scenario = {
//     threads,                       // threads to start
//     groups: [{ count, windowMs?, spinMs?, plan?, silent?, abortAfterMs? }],
//         // run in order on the first `count` threads. `silent` = thread indexes that never get the
//         // measure message; this process plays them instead: it joins the start barrier for each
//         // (READY) and then never passes a window, so the real peers end up in the busy tail.
//         // `abortAfterMs` makes this process fail the group the way a failing peer does
//         // (STOP, GEN += ERROR_GEN, notify) after that many ms.
//     skipPrepare?: number[],        // thread indexes that never get `prepare`
//     kernel?: { id, seed, size },   // default: mix, seed 1, size 1000
//   }
//
// It lives in its own process because Node worker_threads inside the vitest fork crashed the
// fork now and then (exit 0xC0000005, about 1 run in 15 on Windows); here a hang or crash is
// reported by the parent as a normal test failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const scenario = JSON.parse(process.argv[2]);

// Same layout as CTRL / SLOT in src/lib/harness/protocol.ts (the parent test asserts they agree).
const CTRL = { GEN: 0, ARRIVED: 1, STOP: 2, READY: 3, SAMPLES: 4, PASSED: 5, LENGTH: 8 };
const ERROR_GEN = 1 << 20;
const SLOT = 3;

const wasm = new WebAssembly.Module(readFileSync(here('../../src/generated/kernels.wasm')));
const workerUrl = pathToFileURL(here('../../src/workers/runner.worker.ts')).href;

const nextMessage = (w) =>
  new Promise((resolve, reject) => {
    w.once('message', resolve);
    w.once('error', reject);
  });
const send = (w, msg) => {
  const reply = nextMessage(w);
  w.postMessage(msg);
  return reply;
};

const threads = [];
try {
  // Started one at a time: starting several together makes Node (26.8.1, Windows) segfault now
  // and then, even without any measuring.
  for (let i = 0; i < scenario.threads; i++) {
    const w = new Worker(here('./worker-shim.mjs'), { workerData: { workerUrl } });
    threads.push(w);
    await nextMessage(w); // shim-ready
  }
  const init = await Promise.all(threads.map((w) => send(w, { type: 'init', module: wasm, spinMs: 0 })));
  const out = { init: init.map((r) => r.type), prepared: [], groups: [] };

  const kernel = { kernel: scenario.kernel?.id ?? 'mix', seed: scenario.kernel?.seed ?? 1, size: scenario.kernel?.size ?? 1000 };
  const skip = new Set(scenario.skipPrepare ?? []);
  out.prepared = await Promise.all(
    threads.map((w, i) =>
      skip.has(i)
        ? Promise.resolve({ type: 'skipped' })
        : send(w, { type: 'prepare', id: 0, ...kernel }),
    ),
  );

  for (const g of scenario.groups) {
    const plan = { minSamples: 3, maxSamples: 9, targetSpread: 0.05, maxMs: 3000, ...g.plan };
    const control = new Int32Array(new SharedArrayBuffer(CTRL.LENGTH * 4));
    const times = new Float64Array(new SharedArrayBuffer(plan.maxSamples * g.count * SLOT * 8));
    const started = performance.now();
    const silent = new Set(g.silent ?? []);
    if (silent.size > 0) {
      setTimeout(() => {
        for (let i = 0; i < silent.size; i++) {
          if (Atomics.add(control, CTRL.READY, 1) + 1 === g.count) {
            Atomics.compareExchange(control, CTRL.GEN, 0, 1);
            Atomics.notify(control, CTRL.GEN);
          }
        }
      }, 50);
    }
    if (g.abortAfterMs !== undefined) {
      setTimeout(() => {
        Atomics.store(control, CTRL.STOP, 1);
        Atomics.add(control, CTRL.GEN, ERROR_GEN);
        Atomics.notify(control, CTRL.GEN);
      }, g.abortAfterMs);
    }
    const replies = await Promise.all(
      threads
        .slice(0, g.count)
        .map((w, index) => ({ w, index }))
        .filter(({ index }) => !silent.has(index))
        .map(({ w, index }) =>
          send(w, {
            type: 'measure',
            id: 7,
            group: { control, times, index, count: g.count },
            windowMs: g.windowMs ?? 0,
            spinMs: g.spinMs ?? 0,
            ...plan,
          }),
        ),
    );
    out.groups.push({
      count: g.count,
      maxSamples: plan.maxSamples,
      windowMs: g.windowMs ?? 0,
      elapsedMs: performance.now() - started,
      replies,
      control: Array.from(control),
      times: Array.from(times),
    });
  }
  console.log(JSON.stringify(out));
} finally {
  await Promise.all(threads.map((w) => w.terminate()));
}
