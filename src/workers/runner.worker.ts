/// <reference lib="webworker" />
// CPU benchmark worker. Owns one wasm instance. Timing happens here, not on
// the page, so page work never lands inside a measurement.

import {
  BARRIER_TIMEOUT_MS,
  CTRL,
  ERROR_GEN,
  groupMsPerRep,
  LOOP,
  type LoopRequest,
  SLOT,
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
  // Warm-up call: tiers the code up and gives the checksum. Its time is info only.
  const t0 = performance.now();
  const checksum = fns.run() >>> 0;
  const runMs = performance.now() - t0;
  prepared = { fns, checksum };
  reply({ type: 'prepared', id: req.id, checksum, runMs });
}

/** Waits until GEN > s. Throws if a peer failed or nothing moves for BARRIER_TIMEOUT_MS. */
function waitForSample(control: Int32Array, s: number): void {
  let gen = Atomics.load(control, CTRL.GEN);
  while (gen <= s) {
    if (Atomics.wait(control, CTRL.GEN, gen, BARRIER_TIMEOUT_MS) === 'timed-out') {
      throw new Error('barrier timed out: another worker stopped responding');
    }
    gen = Atomics.load(control, CTRL.GEN);
  }
  if (gen >= ERROR_GEN) throw new Error('another worker failed');
}

/** Wakes every peer and tells them to stop. Used when this worker fails. */
function abortGroup(control: Int32Array): void {
  Atomics.store(control, CTRL.STOP, 1);
  Atomics.add(control, CTRL.GEN, ERROR_GEN);
  Atomics.notify(control, CTRL.GEN);
}

function measureGroup(m: KernelModule, req: MeasureRequest): void {
  const { control } = req.group;
  try {
    measureLoop(m, req);
  } catch (err) {
    abortGroup(control);
    throw err;
  }
}

function measureLoop(m: KernelModule, req: MeasureRequest): void {
  if (!prepared) throw new Error('measure before prepare');
  const { control, times, index, count } = req.group;
  const run = prepared.fns.run;
  const expected = prepared.checksum;
  const windowMs = req.windowMs;
  let consistent = true;
  // Preallocated so the coordinator allocates nothing between samples.
  const perRep = new Float64Array(req.maxSamples);
  const scratch = new Float64Array(req.maxSamples);

  // `mix` keeps no arena buffers, so spinning on it leaves the prepared kernel intact.
  spin(m, req.spinMs);

  // Start barrier: the last worker to arrive releases everyone.
  if (Atomics.add(control, CTRL.READY, 1) + 1 === count) {
    // compareExchange: never overwrite an ERROR_GEN a failed peer already set.
    Atomics.compareExchange(control, CTRL.GEN, 0, 1);
    Atomics.notify(control, CTRL.GEN);
  }

  for (let s = 0; s < req.maxSamples; s++) {
    waitForSample(control, s);
    if (Atomics.load(control, CTRL.STOP) !== 0) break;

    const t0 = now();
    let reps = 0;
    let t1: number;
    do {
      if (run() >>> 0 !== expected) consistent = false;
      reps++;
      t1 = now();
    } while (t1 - t0 < windowMs);
    if (count > 1) {
      // Keep working until every worker has passed the window (busy tail).
      Atomics.add(control, CTRL.PASSED, 1);
      while (Atomics.load(control, CTRL.PASSED) < count) {
        if (Atomics.load(control, CTRL.GEN) >= ERROR_GEN) throw new Error('another worker failed');
        if (t1 - t0 > windowMs + BARRIER_TIMEOUT_MS) {
          throw new Error('barrier timed out: another worker stopped responding');
        }
        if (run() >>> 0 !== expected) consistent = false;
        reps++;
        t1 = now();
      }
    }
    // Outside the timed region from here on.
    const slot = (s * count + index) * SLOT;
    times[slot] = t0;
    times[slot + 1] = t1;
    times[slot + 2] = reps;

    if (Atomics.add(control, CTRL.ARRIVED, 1) + 1 === count) {
      // Last to finish this sample: coordinate.
      // Every peer has left its busy tail (it arrived), so PASSED can be reset.
      Atomics.store(control, CTRL.ARRIVED, 0);
      Atomics.store(control, CTRL.PASSED, 0);
      perRep[s] = groupMsPerRep(times, s, count);
      const n = s + 1;
      Atomics.store(control, CTRL.SAMPLES, n);
      let firstStart = Infinity;
      for (let w = 0; w < count; w++) firstStart = Math.min(firstStart, times[w * SLOT]!);
      const stop =
        n >= req.maxSamples ||
        (n >= req.minSamples &&
          (fastestSpread(perRep, n, req.minSamples, scratch) <= req.targetSpread ||
            t1 - firstStart > req.maxMs));
      if (stop) Atomics.store(control, CTRL.STOP, 1);
      Atomics.add(control, CTRL.GEN, 1);
      Atomics.notify(control, CTRL.GEN);
    }
  }
  reply({ type: 'measured', id: req.id, checksumConsistent: consistent });
}

/**
 * Endurance / Stress loop (protocol.ts, LoopRequest). Each slice prepares its
 * kernel (untimed: the arena holds one kernel at a time), then calls `run`
 * until the slice ends. Every call's checksum is checked; a mismatch fails
 * the loop. Only `run`, the checksum compare, the STOP read and timer reads
 * sit between t0 and t1.
 *
 * A slice always runs at least one rep, and does not start a rep it expects
 * to end more than half a rep past the slice end (expected = as long as the
 * last one). Only a slice reached more than a whole slice late is skipped
 * (NaN, counted in LOOP.MISSED). Loop sizes are small (KernelDef.loop) so a
 * rep stays well under a slice even on a slow core under full load.
 */
/** Warm-up per kernel before an Endurance loop starts. */
const LOOP_WARM_MS = 150;
/** The whole warm-up never takes longer than this (the page's start delay is 3 s). */
const LOOP_WARM_BUDGET_MS = 1_500;

function loop(m: KernelModule, req: LoopRequest): void {
  const { control, out, best, kernels, windowMs, windows, start } = req;
  const nk = kernels.length;
  const fns = kernels.map((k) => m.kernel(k.kernel));
  const slice = windowMs / nk;
  const stopped = () => Atomics.load(control, LOOP.STOP) !== 0;
  // Warm-up before window 0 (inside the page's start delay): without it the
  // first window runs on baseline-tier code at about half speed. Also checks
  // every kernel's checksum once up front. Each kernel gets an equal share of
  // what is left of the budget, at most LOOP_WARM_MS, and at least one rep.
  const warmEnd = performance.now() + LOOP_WARM_BUDGET_MS;
  for (let k = 0; k < nk; k++) {
    const def = kernels[k]!;
    prepareStatus(fns[k]!.prepare(def.seed, def.size));
    const t = performance.now();
    const until = t + Math.min(LOOP_WARM_MS, (warmEnd - t) / (nk - k));
    do {
      if (fns[k]!.run() >>> 0 !== def.expected >>> 0) throw new Error(`checksum mismatch in ${def.kernel}: result invalid`);
    } while (performance.now() < until && !stopped());
  }
  while (now() < start) {
    if (stopped()) return;
  }
  let missed = 0;
  let w = 0;
  while (w < windows) {
    const ws = start + w * windowMs;
    for (let k = 0; k < nk; k++) {
      const end = ws + (k + 1) * slice;
      if (now() >= end + slice) {
        // A real stall: this slice stays NaN.
        Atomics.store(control, LOOP.MISSED, ++missed);
        if (stopped()) return;
        continue;
      }
      const def = kernels[k]!;
      prepareStatus(fns[k]!.prepare(def.seed, def.size));
      const run = fns[k]!.run;
      const expected = def.expected >>> 0;
      let reps = 0;
      let bad = false;
      let fastest = Infinity;
      let last: number;
      const t0 = now();
      let t1 = t0;
      do {
        if (run() >>> 0 !== expected) bad = true;
        const t = now();
        last = t - t1;
        if (last < fastest) fastest = last;
        t1 = t;
        reps++;
      } while (t1 + last / 2 < end && !bad && !stopped());
      if (bad) throw new Error(`checksum mismatch in ${def.kernel}: result invalid`);
      const mean = reps / (t1 - t0);
      out[w * nk + k] = mean;
      // A rep under the timer's resolution reads as 0 ms (smoke sizes): use the mean then.
      best[w * nk + k] = fastest > 0 ? Math.max(1 / fastest, mean) : mean;
      if (stopped()) return; // a window cut short by Stop is not counted
    }
    Atomics.store(control, LOOP.DONE, w + 1);
    // Skip windows that are already over (e.g. after a long pause).
    const next = Math.max(w + 1, Math.floor((now() - start) / windowMs));
    if (next > w + 1) {
      missed += (Math.min(next, windows) - w - 1) * nk;
      Atomics.store(control, LOOP.MISSED, missed);
    }
    w = next;
  }
  Atomics.store(control, LOOP.DONE, windows);
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
  if (!mod && !req.module) throw new Error('init without a kernel module');
  const m = mod ?? (await instantiateKernels(req.module!));
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
  // `mix` keeps no arena buffers, so spinning on it leaves the prepared kernel intact.
  spin(m, req.spinMs ?? 0);

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
    if (!mod) {
      if (req.type === 'measure') abortGroup(req.group.control);
      throw new Error('worker not initialised');
    }
    if (req.type === 'run') run(mod, req);
    else if (req.type === 'prepare') prepareGroup(mod, req);
    else if (req.type === 'loop') {
      loop(mod, req);
      reply({ type: 'looped', id: req.id });
    } else measureGroup(mod, req);
  } catch (err) {
    const kernel = req.type === 'measure' || req.type === 'loop' ? undefined : req.kernel;
    reply({ type: 'error', id: req.id, ...(kernel ? { kernel } : {}), message: errorText(err) });
  }
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
