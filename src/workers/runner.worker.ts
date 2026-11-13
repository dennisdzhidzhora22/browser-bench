/// <reference lib="webworker" />
// CPU benchmark worker. Owns one wasm instance. Timing happens here, not on
// the page, so page work never lands inside a measurement.

import {
  CTRL,
  type FromWorker,
  type InitRequest,
  type MeasureRequest,
  type PrepareRequest,
  type RunRequest,
  type ToWorker,
} from '../lib/harness/protocol.ts';
import { fastestSpread } from '../lib/harness/stats.ts';
import { instantiateKernels, type KernelFns, type KernelModule } from '../lib/harness/wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let mod: KernelModule | undefined;

/** Kernel prepared by the last `prepare` message (all-cores test). */
let prepared: { fns: KernelFns; checksum: number } | undefined;

/** Absolute time in ms, comparable across workers (each has its own timeOrigin). */
function now(): number {
  return performance.timeOrigin + performance.now();
}

function prepareStatus(status: number): void {
  if (status === 0) return;
  const why = status === 1 ? 'out of memory' : status === 2 ? 'invalid size' : `status ${status}`;
  throw new Error(`prepare failed (${why})`);
}

function prepareGroup(m: KernelModule, req: PrepareRequest): void {
  prepared = undefined;
  const fns = m.kernel(req.kernel);
  prepareStatus(fns.prepare(req.seed, req.size));
  // First call tiers the code up; the second gives a fair time for sizing windows.
  const checksum = fns.run() >>> 0;
  const t0 = performance.now();
  fns.run();
  const runMs = performance.now() - t0;
  prepared = { fns, checksum };
  reply({ type: 'prepared', id: req.id, checksum, runMs });
}

function measureGroup(req: MeasureRequest): void {
  if (!prepared) throw new Error('measure before prepare');
  const { control, times, index, count } = req.group;
  const run = prepared.fns.run;
  const expected = prepared.checksum;
  const reps = req.reps;
  let consistent = true;
  // Preallocated so the coordinator allocates nothing between samples.
  const walls = new Float64Array(req.maxSamples);
  const scratch = new Float64Array(req.maxSamples);

  // Start barrier: the last worker to arrive releases everyone.
  if (Atomics.add(control, CTRL.READY, 1) + 1 === count) {
    Atomics.store(control, CTRL.GEN, 1);
    Atomics.notify(control, CTRL.GEN);
  }

  for (let s = 0; s < req.maxSamples; s++) {
    let gen = Atomics.load(control, CTRL.GEN);
    while (gen <= s) {
      Atomics.wait(control, CTRL.GEN, gen);
      gen = Atomics.load(control, CTRL.GEN);
    }
    if (Atomics.load(control, CTRL.STOP) !== 0) break;

    const t0 = now();
    for (let r = 0; r < reps; r++) {
      if (run() >>> 0 !== expected) consistent = false;
    }
    const t1 = now();
    // Outside the timed region from here on.
    const slot = (s * count + index) * 2;
    times[slot] = t0;
    times[slot + 1] = t1;

    if (Atomics.add(control, CTRL.ARRIVED, 1) + 1 === count) {
      // Last to finish this sample: coordinate.
      Atomics.store(control, CTRL.ARRIVED, 0);
      let start = Infinity;
      let end = -Infinity;
      for (let w = 0; w < count; w++) {
        const k = (s * count + w) * 2;
        start = Math.min(start, times[k]!);
        end = Math.max(end, times[k + 1]!);
      }
      walls[s] = end - start;
      const n = s + 1;
      Atomics.store(control, CTRL.SAMPLES, n);
      let firstStart = Infinity;
      for (let w = 0; w < count; w++) firstStart = Math.min(firstStart, times[w * 2]!);
      const stop =
        n >= req.maxSamples ||
        (n >= req.minSamples &&
          (fastestSpread(walls, n, req.minSamples, scratch) <= req.targetSpread ||
            end - firstStart > req.maxMs));
      if (stop) Atomics.store(control, CTRL.STOP, 1);
      Atomics.add(control, CTRL.GEN, 1);
      Atomics.notify(control, CTRL.GEN);
    }
  }
  reply({ type: 'measured', id: req.id, checksumConsistent: consistent });
}

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
  prepareStatus(status);

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
    if (req.type === 'run') run(mod, req);
    else if (req.type === 'prepare') prepareGroup(mod, req);
    else measureGroup(req);
  } catch (err) {
    const kernel = req.type === 'measure' ? undefined : req.kernel;
    reply({ type: 'error', id: req.id, ...(kernel ? { kernel } : {}), message: errorText(err) });
  }
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
