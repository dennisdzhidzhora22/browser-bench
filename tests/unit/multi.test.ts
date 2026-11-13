import { afterEach, describe, expect, it } from 'vitest';
import type { KernelDef } from '../../src/lib/bench/types.ts';
import {
  Cancelled,
  NOISY_SPREAD,
  SAMPLING,
  type RunMode,
} from '../../src/lib/harness/orchestrator.ts';
import {
  BASELINE_MAX_MS,
  clampWorkers,
  defaultMaxWorkers,
  MAX_WORKERS_PER_CORE,
  MEASURE_SPIN_MS,
  multiSize,
  startMultiRun,
  WINDOW_MS,
  type MultiOptions,
} from '../../src/lib/harness/multi.ts';
import {
  CTRL,
  groupMsPerRep,
  SLOT,
  type FromWorker,
  type InitRequest,
  type MeasureRequest,
  type PrepareRequest,
  type ToWorker,
} from '../../src/lib/harness/protocol.ts';

function fakeDef(id: string, over: Partial<KernelDef> = {}): KernelDef {
  return {
    id,
    name: `Kernel ${id}`,
    stresses: 'nothing',
    unit: 'units/s',
    seed: 7,
    sizes: { smoke: 10, standard: 1000 },
    expected: { smoke: 111, standard: 222 },
    work: (size) => size * 2,
    ...over,
  };
}

// ───────────────────────────── multiSize ─────────────────────────────

describe('multiSize', () => {
  const plain = fakeDef('p');
  const reduced = fakeDef('r', { multi: { size: 500, expected: 333 } });

  it('smoke uses the smoke size and checksum, even when a multi size exists', () => {
    expect(multiSize(plain, 'smoke')).toEqual({ size: 10, expected: 111 });
    expect(multiSize(reduced, 'smoke')).toEqual({ size: 10, expected: 111 });
  });

  it('standard falls back to the standard size when there is no multi size', () => {
    expect(multiSize(plain, 'standard')).toEqual({ size: 1000, expected: 222 });
  });

  it('standard uses the multi size and its own checksum when defined', () => {
    expect(multiSize(reduced, 'standard')).toEqual({ size: 500, expected: 333 });
  });
});

// ───────────────────────────── clampWorkers ─────────────────────────────

describe('clampWorkers', () => {
  it('truncates to a whole number', () => {
    expect(clampWorkers(2.5, 8)).toBe(2);
    expect(clampWorkers(2.999, 8)).toBe(2);
    expect(clampWorkers(1.2, 8)).toBe(1);
    expect(clampWorkers(4, 8)).toBe(4);
  });

  it('is undefined when there is no usable count: below 1, negative, NaN, infinite', () => {
    expect(clampWorkers(0, 8)).toBeUndefined();
    expect(clampWorkers(0.9, 8)).toBeUndefined();
    expect(clampWorkers(-3, 8)).toBeUndefined();
    expect(clampWorkers(NaN, 8)).toBeUndefined();
    expect(clampWorkers(Infinity, 8)).toBeUndefined();
    expect(clampWorkers(-Infinity, 8)).toBeUndefined();
  });

  it('caps at max', () => {
    expect(clampWorkers(9, 8)).toBe(8);
    expect(clampWorkers(8, 8)).toBe(8);
    expect(clampWorkers(1_000_000, 8)).toBe(8);
    expect(clampWorkers(20, 8.9)).toBe(8);
  });

  it('a max below 1 still allows one worker', () => {
    expect(clampWorkers(5, 0)).toBe(1);
    expect(clampWorkers(5, -2)).toBe(1);
  });
});

describe('constants', () => {
  it('windows are per mode and Full is longer; the baseline is capped at 1 s', () => {
    expect(WINDOW_MS.quick).toBeGreaterThan(0);
    expect(WINDOW_MS.full).toBeGreaterThan(WINDOW_MS.quick);
    expect(BASELINE_MAX_MS).toBe(1_000);
    expect(MEASURE_SPIN_MS).toBeGreaterThan(0);
    expect(MAX_WORKERS_PER_CORE).toBeGreaterThanOrEqual(1);
  });

  it('defaultMaxWorkers is a whole multiple of MAX_WORKERS_PER_CORE', () => {
    const n = defaultMaxWorkers();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(MAX_WORKERS_PER_CORE);
    expect(n % MAX_WORKERS_PER_CORE).toBe(0);
  });
});

describe('groupMsPerRep (summed rates)', () => {
  const slots = (...w: Array<[t0: number, t1: number, reps: number]>) => Float64Array.from(w.flat());

  it('one worker: (t1 - t0) / reps', () => {
    expect(groupMsPerRep(slots([0, 100, 10]), 0, 1)).toBeCloseTo(10, 12);
  });

  it('two workers: rates add, so 10 reps/100 ms + 5 reps/100 ms = 0.15 reps/ms', () => {
    expect(groupMsPerRep(slots([0, 100, 10], [0, 100, 5]), 0, 2)).toBeCloseTo(1 / 0.15, 12);
  });

  it('is not the wall time: a worker with a longer window and proportional reps adds the same rate', () => {
    expect(groupMsPerRep(slots([0, 100, 10], [20, 320, 30]), 0, 2)).toBeCloseTo(5, 12);
  });

  it('reads the right sample, and uses SLOT entries per worker', () => {
    expect(SLOT).toBe(3);
    const t = slots([0, 100, 10], [0, 100, 10], /* sample 1 */ [0, 50, 10], [0, 50, 10]);
    expect(groupMsPerRep(t, 0, 2)).toBeCloseTo(5, 12);
    expect(groupMsPerRep(t, 1, 2)).toBeCloseTo(2.5, 12);
  });

  it('is 0 when no worker has a positive duration', () => {
    expect(groupMsPerRep(slots([5, 5, 3], [7, 7, 1]), 0, 2)).toBe(0);
    expect(groupMsPerRep(slots([0, 0, 0]), 0, 1)).toBe(0);
  });

  it('ignores a worker with a non-positive duration instead of dividing by zero', () => {
    expect(groupMsPerRep(slots([0, 100, 10], [5, 5, 9]), 0, 2)).toBeCloseTo(10, 12);
  });
});

// ─────────────────────── startMultiRun with fake workers ───────────────────────

/** One worker's sample: start, end (ms) and reps done. `reps` defaults to 10. */
type Timing = (
  count: number,
  index: number,
  sample: number,
) => { t0: number; t1: number; reps?: number };

interface Behaviour {
  /** Checksum answered to `prepare`. Default: the expected checksum for the size asked. */
  checksum?: (req: PrepareRequest, worker: FakeWorker) => number;
  runMs?: number;
  /** Samples a measure group takes. */
  samples?: number;
  timing?: Timing;
  checksumConsistent?: (req: MeasureRequest, worker: FakeWorker) => boolean;
  /** Per-message override; return undefined to fall through to the default. */
  override?: (msg: ToWorker, worker: FakeWorker) => FromWorker | 'hang' | undefined;
}

/** Every worker does 10 reps in 100 ms (0.1 reps/ms), alone or in a group: perfect scaling. */
const defaultTiming: Timing = (_count, _index, s) => ({ t0: s * 1_000, t1: s * 1_000 + 100, reps: 10 });

class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = 0;
  readonly received: ToWorker[] = [];

  constructor(
    readonly number: number,
    private readonly behaviour: Behaviour,
    private readonly defs: readonly KernelDef[],
    private readonly sizeId: 'smoke' | 'standard',
  ) {}

  postMessage(msg: ToWorker): void {
    this.received.push(msg);
    const reply = this.handle(msg);
    if (reply === undefined || reply === 'hang') return;
    queueMicrotask(() => {
      if (this.terminated === 0) this.onmessage?.({ data: reply } as MessageEvent<FromWorker>);
    });
  }

  terminate(): void {
    this.terminated++;
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }

  private handle(msg: ToWorker): FromWorker | 'hang' | undefined {
    const b = this.behaviour;
    const over = b.override?.(msg, this);
    if (over !== undefined) return over;
    switch (msg.type) {
      case 'init':
        return { type: 'ready', abi: 4 };
      case 'prepare': {
        const def = this.defs.find((d) => d.id === msg.kernel)!;
        const expected = (def.multi && this.sizeId === 'standard'
          ? def.multi.expected
          : def.expected[this.sizeId]) as number;
        return {
          type: 'prepared',
          id: msg.id,
          checksum: b.checksum ? b.checksum(msg, this) : expected,
          runMs: b.runMs ?? 100,
        };
      }
      case 'measure': {
        // Simulates the shared barrier synchronously: write every sample's start, end and reps
        // into this worker's slots, then publish the sample count.
        const { control, times, index, count } = msg.group;
        const n = b.samples ?? msg.minSamples;
        const timing = b.timing ?? defaultTiming;
        for (let s = 0; s < n; s++) {
          const { t0, t1, reps } = timing(count, index, s);
          const slot = (s * count + index) * SLOT;
          times[slot] = t0;
          times[slot + 1] = t1;
          times[slot + 2] = reps ?? 10;
        }
        Atomics.store(control, CTRL.SAMPLES, n);
        return {
          type: 'measured',
          id: msg.id,
          checksumConsistent: b.checksumConsistent ? b.checksumConsistent(msg, this) : true,
        };
      }
      default:
        throw new Error(`unexpected ${msg.type} request`);
    }
  }

  of<T extends ToWorker['type']>(type: T): Extract<ToWorker, { type: T }>[] {
    return this.received.filter((m): m is Extract<ToWorker, { type: T }> => m.type === type);
  }
}

const FAKE_MODULE = { fake: 'module' } as unknown as WebAssembly.Module;

type Opts = Pick<MultiOptions, 'kernels' | 'size'> & Partial<MultiOptions>;

/** Starts a multi run on fake workers; `workersMade` collects every worker in creation order. */
function start(opts: Opts, behaviour: Behaviour = {}) {
  const workersMade: FakeWorker[] = [];
  const run = startMultiRun({
    mode: 'quick',
    workers: 4,
    loadModule: () => Promise.resolve(FAKE_MODULE),
    spinMs: 0,
    ...opts,
    makeWorker: () => {
      const w = new FakeWorker(workersMade.length, behaviour, opts.kernels, opts.size);
      workersMade.push(w);
      return w as unknown as Worker;
    },
  });
  return { run, workersMade };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

describe('startMultiRun', () => {
  const defs = [fakeDef('a'), fakeDef('b'), fakeDef('c')];

  describe('protocol', () => {
    it('sends init to every worker, then prepare to all, then measure to one worker, then to all', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 3 });
      await run.done;
      expect(workersMade).toHaveLength(3);
      expect(workersMade[0]!.received.map((m) => m.type)).toEqual(['init', 'prepare', 'measure', 'measure']);
      for (const w of workersMade.slice(1)) {
        expect(w.received.map((m) => m.type)).toEqual(['init', 'prepare', 'measure']);
      }
      const inits = workersMade.map((w) => w.of('init')[0] as InitRequest);
      for (const i of inits) {
        expect(i.module).toBe(FAKE_MODULE);
        expect(i.spinMs).toBe(0);
      }
    });

    it('prepare carries kernel, seed and the multi size; smoke uses the smoke size', async () => {
      const multi = fakeDef('m', { multi: { size: 500, expected: 333 } });
      const smoke = start({ kernels: [multi], size: 'smoke', workers: 2 });
      await smoke.run.done;
      expect(smoke.workersMade[0]!.of('prepare')[0]).toMatchObject({ kernel: 'm', seed: 7, size: 10 });

      const std = start({ kernels: [multi], size: 'standard', workers: 2 });
      await std.run.done;
      expect(std.workersMade[0]!.of('prepare')[0]).toMatchObject({ kernel: 'm', seed: 7, size: 500 });
    });

    it('the single baseline is one worker with its own group; the all group spans every worker', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 3 });
      await run.done;
      const [single, all] = workersMade[0]!.of('measure');
      expect(single!.group).toMatchObject({ index: 0, count: 1 });
      expect(all!.group).toMatchObject({ index: 0, count: 3 });
      expect(single!.group.control).not.toBe(all!.group.control);
      expect(single!.group.times).not.toBe(all!.group.times);
      expect(workersMade.map((w) => w.of('measure').at(-1)!.group.index)).toEqual([0, 1, 2]);
      // Every worker of a group shares the same buffers.
      expect(workersMade[1]!.of('measure')[0]!.group.control).toBe(all!.group.control);
      expect(workersMade[2]!.of('measure')[0]!.group.times).toBe(all!.group.times);
      expect(all!.group.control).toBeInstanceOf(Int32Array);
      expect(all!.group.control.length).toBeGreaterThanOrEqual(CTRL.LENGTH);
      expect(all!.group.control.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(all!.group.times.buffer).toBeInstanceOf(SharedArrayBuffer);
    });

    it.each<RunMode>(['quick', 'full'])('measure carries the SAMPLING plan for %s', async (mode) => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', mode, workers: 2 });
      await run.done;
      const [single, all] = workersMade[0]!.of('measure');
      const { maxMs: _planMaxMs, ...rest } = SAMPLING[mode];
      for (const m of [single!, all!]) expect(m).toMatchObject(rest);
      expect(all!.maxMs).toBe(SAMPLING[mode].maxMs);
      // The times buffer has room for maxSamples x workers x SLOT.
      expect(all!.group.times.length).toBe(SAMPLING[mode].maxSamples * 2 * SLOT);
      expect(single!.group.times.length).toBe(SAMPLING[mode].maxSamples * 1 * SLOT);
    });

    it('the baseline carries maxMs <= BASELINE_MAX_MS; the all-workers measure keeps the plan maxMs', async () => {
      for (const mode of ['quick', 'full'] as const) {
        const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', mode, workers: 2 });
        await run.done;
        const [single, all] = workersMade[0]!.of('measure');
        expect(single!.maxMs).toBeLessThanOrEqual(BASELINE_MAX_MS);
        expect(single!.maxMs).toBe(Math.min(SAMPLING[mode].maxMs, BASELINE_MAX_MS));
        expect(all!.maxMs).toBe(SAMPLING[mode].maxMs);
      }
    });

    it('both measures carry windowMs and spinMs; there is no reps field any more', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'standard', workers: 2, mode: 'full' });
      await run.done;
      const measures = workersMade.flatMap((w) => w.of('measure'));
      expect(measures).toHaveLength(3); // baseline on worker 0, then both workers
      for (const m of measures) {
        expect(m.windowMs).toBe(WINDOW_MS.full);
        expect(m.spinMs).toBe(MEASURE_SPIN_MS);
        expect(m).not.toHaveProperty('reps');
      }
    });

    it('windowMs follows the mode at standard size and is 0 for smoke; measureSpinMs overrides the spin', async () => {
      const q = start({ kernels: [defs[0]!], size: 'standard', workers: 1, mode: 'quick', measureSpinMs: 7 });
      await q.run.done;
      for (const m of q.workersMade[0]!.of('measure')) {
        expect(m.windowMs).toBe(WINDOW_MS.quick);
        expect(m.spinMs).toBe(7);
      }
      const smoke = start({ kernels: [defs[0]!], size: 'smoke', workers: 1, measureSpinMs: 0 });
      await smoke.run.done;
      for (const m of smoke.workersMade[0]!.of('measure')) {
        expect(m.windowMs).toBe(0);
        expect(m.spinMs).toBe(0);
      }
    });

    it('runs kernels in order, with the hooks around each', async () => {
      const events: string[] = [];
      const { run } = start({
        kernels: defs,
        size: 'smoke',
        beforeKernel: (i, d) => void events.push(`before ${i} ${d.id}`),
        afterKernel: (i, o) => void events.push(`after ${i} ${o.def.id} ${o.valid}`),
      });
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.def.id)).toEqual(['a', 'b', 'c']);
      expect(events).toEqual([
        'before 0 a',
        'after 0 a true',
        'before 1 b',
        'after 1 b true',
        'before 2 c',
        'after 2 c true',
      ]);
    });

    it('awaits beforeKernel before posting anything for that kernel', async () => {
      let seen = -1;
      const { run, workersMade } = start({
        kernels: [defs[0]!],
        size: 'smoke',
        workers: 2,
        beforeKernel: async () => {
          await sleep(15);
          seen = workersMade.flatMap((w) => w.of('prepare')).length;
        },
      });
      await run.done;
      expect(seen).toBe(0);
    });

    it('reuses one pool across kernels and terminates it at the end', async () => {
      const { run, workersMade } = start({ kernels: defs, size: 'smoke', workers: 3 });
      await run.done;
      expect(workersMade).toHaveLength(3);
      for (const w of workersMade) {
        expect(w.of('init')).toHaveLength(1);
        expect(w.of('prepare')).toHaveLength(3);
        expect(w.terminated).toBeGreaterThanOrEqual(1);
      }
    });

    it('a single worker (workers = 1) works: scaling is all / single of the same worker', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 1 });
      const [o] = await run.done;
      expect(workersMade).toHaveLength(1);
      expect(o!.valid).toBe(true);
      expect(o!.workers).toBe(1);
      expect(o!.scaling).toBeCloseTo(1, 9);
    });
  });

  describe('results', () => {
    it('throughput = work(size) / median ms-per-rep: single 0.1 reps/ms, four workers 0.4 reps/ms', async () => {
      // Smoke: work(10) = 20. One worker: 10 reps / 100 ms -> 10 ms per rep -> 20 / 0.01 = 2000.
      const { run } = start({ kernels: [defs[0]!], size: 'smoke', workers: 4 });
      const [o] = await run.done;
      expect(o!.valid).toBe(true);
      expect(o!.error).toBeUndefined();
      expect(o!.single!.workers).toBe(1);
      expect(o!.all!.workers).toBe(4);
      expect(o!.single!.stats.median).toBeCloseTo(10, 9);
      expect(o!.all!.stats.median).toBeCloseTo(2.5, 9);
      expect(o!.single!.throughput).toBeCloseTo(20 / 0.01, 6);
      expect(o!.all!.throughput).toBeCloseTo(20 / 0.0025, 6);
    });

    it('standard size: uses work(multi.size), not work(standard size)', async () => {
      const multi = fakeDef('m', { multi: { size: 500, expected: 333 } });
      const { run } = start({ kernels: [multi], size: 'standard', workers: 2 });
      const [o] = await run.done;
      expect(o!.valid).toBe(true);
      // work(500) = 1000. Single: 10 ms per rep. Two workers: 5 ms per rep.
      expect(o!.single!.throughput).toBeCloseTo(1000 / 0.01, 6);
      expect(o!.all!.throughput).toBeCloseTo(1000 / 0.005, 6);
    });

    it('scaling = all throughput / single throughput', async () => {
      const { run } = start({ kernels: [defs[0]!], size: 'smoke', workers: 4 });
      const [o] = await run.done;
      expect(o!.scaling).toBeCloseTo(4, 9);
      expect(o!.scaling).toBeCloseTo(o!.all!.throughput! / o!.single!.throughput!, 9);
    });

    it('scaling is below the worker count when each core is slower inside the group', async () => {
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 4 },
        // Alone 10 reps / 100 ms; in a group of 4 each worker only manages 5 reps / 100 ms.
        { timing: (count, _i, s) => ({ t0: s * 1000, t1: s * 1000 + 100, reps: count === 1 ? 10 : 5 }) },
      );
      const [o] = await run.done;
      expect(o!.scaling).toBeCloseTo(2, 9); // 4 x 0.05 / 0.1
    });

    it('summed rates: workers with different rates add up (wall time would not give this)', async () => {
      // Worker 0: 10 reps / 100 ms = 0.10 reps/ms. Worker 1: 5 reps / 100 ms = 0.05 reps/ms.
      // Sum 0.15 -> 6.667 ms per rep -> 20 / 0.006667 = 3000 units/s.
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        {
          timing: (count, index, s) => ({
            t0: s * 1000,
            t1: s * 1000 + 100,
            reps: count === 1 ? 10 : index === 0 ? 10 : 5,
          }),
        },
      );
      const [o] = await run.done;
      expect(o!.all!.throughput).toBeCloseTo(3000, 6);
      expect(o!.single!.throughput).toBeCloseTo(2000, 6);
      expect(o!.scaling).toBeCloseTo(1.5, 9);
    });

    it('summed rates ignore window length: a worker that starts late and runs longer adds its own rate', async () => {
      // Worker 1 starts 20 ms late and runs 300 ms for 30 reps: still 0.1 reps/ms, so the sum
      // is 0.2 reps/ms (a wall-time model would give 40 reps / 320 ms = 0.125 reps/ms).
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        {
          timing: (count, index, s) => {
            const base = s * 10_000;
            if (count === 1 || index === 0) return { t0: base, t1: base + 100, reps: 10 };
            return { t0: base + 20, t1: base + 320, reps: 30 };
          },
        },
      );
      const [o] = await run.done;
      expect(o!.all!.stats.median).toBeCloseTo(5, 9);
      expect(o!.all!.throughput).toBeCloseTo(20 / 0.005, 6);
      expect(o!.scaling).toBeCloseTo(2, 9);
    });

    it('uses the fastest minSamples samples; slow samples are interference', async () => {
      // Window lengths 100, 100, 100, 900, 900 ms for 10 reps each: the last two are 9x slower.
      const dur = [100, 100, 100, 900, 900];
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        {
          samples: 5,
          timing: (_c, _i, s) => ({ t0: s * 10_000, t1: s * 10_000 + dur[s]!, reps: 10 }),
        },
      );
      const [o] = await run.done;
      expect(o!.all!.samples).toBe(5);
      expect(o!.single!.samples).toBe(5);
      // Two workers at 0.1 reps/ms in the fast samples: 5 ms per rep.
      expect(o!.all!.stats).toMatchObject({ median: 5, min: 5, max: 5, spread: 0 });
      expect(o!.noisy).toBe(false);
      expect(o!.valid).toBe(true);
    });

    it('flags noisy (still valid) when the fastest samples spread above NOISY_SPREAD', async () => {
      const dur = [100, 120, 140]; // 10 reps each: 10, 12, 14 ms per rep alone; spread 33 %
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        { timing: (_c, _i, s) => ({ t0: s * 10_000, t1: s * 10_000 + dur[s]!, reps: 10 }) },
      );
      const [o] = await run.done;
      expect(o!.all!.stats.spread).toBeGreaterThan(NOISY_SPREAD);
      expect(o!.noisy).toBe(true);
      expect(o!.valid).toBe(true);
      expect(o!.error).toBeUndefined();
    });

    it('zero duration gives no throughput and no scaling, but is not an error', async () => {
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        { timing: (_c, _i, s) => ({ t0: s, t1: s }) },
      );
      const [o] = await run.done;
      expect(o!.all!.throughput).toBeUndefined();
      expect(o!.single!.throughput).toBeUndefined();
      expect(o!.scaling).toBeUndefined();
      expect(o!.valid).toBe(true);
    });

    it('zero samples recorded fails that kernel only', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        {
          override: (m, w) =>
            m.type === 'measure' && w.number === 0 && m.group.count === 1 && m.id === 1
              ? { type: 'measured', id: m.id, checksumConsistent: true }
              : undefined,
        },
      );
      // The override above short-circuits kernel b's baseline before it writes SAMPLES.
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.error).toMatch(/no samples/);
    });
  });

  describe('checksums', () => {
    it('a prepare checksum mismatch on one worker marks that kernel invalid', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        { checksum: (req, w) => (req.kernel === 'b' && w.number === 2 ? 112 : req.kernel === 'a' ? 111 : 111) },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.checksumOk)).toEqual([true, false, true]);
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.error).toMatch(/checksum mismatch/);
      // The timings are still reported for inspection.
      expect(outcomes[1]!.all).toBeDefined();
    });

    it('a mismatch does not replace the pool: the workers did not fail', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        { checksum: (req) => (req.kernel === 'a' ? 5 : 111) },
      );
      await run.done;
      expect(workersMade).toHaveLength(2);
    });

    it('compares as unsigned 32-bit', async () => {
      const big = fakeDef('big', { expected: { smoke: 0xdeadbeef, standard: 0xffffffff } });
      const { run } = start(
        { kernels: [big], size: 'smoke', workers: 2 },
        { checksum: () => 0xdeadbeef },
      );
      const [o] = await run.done;
      expect(o!.checksumOk).toBe(true);
    });

    it('uses the multi checksum at standard size', async () => {
      const multi = fakeDef('m', { multi: { size: 500, expected: 333 } });
      const wrong = start({ kernels: [multi], size: 'standard', workers: 2 }, { checksum: () => 222 });
      expect((await wrong.run.done)[0]!.checksumOk).toBe(false);
      const right = start({ kernels: [multi], size: 'standard', workers: 2 }, { checksum: () => 333 });
      expect((await right.run.done)[0]!.checksumOk).toBe(true);
    });

    it('an inconsistent timed checksum (measured.checksumConsistent = false) marks it invalid', async () => {
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 3 },
        { checksumConsistent: (m, w) => !(w.number === 1 && m.group.count === 3) },
      );
      const [o] = await run.done;
      expect(o!.checksumOk).toBe(false);
      expect(o!.valid).toBe(false);
      expect(o!.error).toMatch(/checksum mismatch/);
    });

    it('an inconsistency in the single-worker baseline also invalidates', async () => {
      const { run } = start(
        { kernels: [defs[0]!], size: 'smoke', workers: 2 },
        { checksumConsistent: (m) => m.group.count !== 1 },
      );
      const [o] = await run.done;
      expect(o!.checksumOk).toBe(false);
      expect(o!.valid).toBe(false);
    });
  });

  describe('failures', () => {
    it('one worker erroring on prepare fails that kernel only; the next kernel gets a fresh pool', async () => {
      const N = 3;
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: N },
        {
          override: (m, w) =>
            m.type === 'prepare' && m.kernel === 'b' && w.number === 1
              ? { type: 'error', id: m.id, kernel: m.kernel, message: 'prepare failed (out of memory)' }
              : undefined,
        },
      );
      const outcomes = await run.done;

      expect(outcomes).toHaveLength(3);
      expect(outcomes[0]!.valid).toBe(true);
      expect(outcomes[1]!.valid).toBe(false);
      expect(outcomes[1]!.checksumOk).toBe(false);
      expect(outcomes[1]!.noisy).toBe(false);
      expect(outcomes[1]!.error).toBe('prepare failed (out of memory)');
      expect(outcomes[1]!.all).toBeUndefined();
      expect(outcomes[1]!.single).toBeUndefined();
      expect(outcomes[1]!.scaling).toBeUndefined();
      expect(outcomes[1]!.workers).toBe(N);
      expect(outcomes[2]!.valid).toBe(true);
      expect(outcomes[2]!.error).toBeUndefined();

      // Pool for a and b, then a fresh pool for c.
      expect(workersMade).toHaveLength(2 * N);
      const [first, second] = [workersMade.slice(0, N), workersMade.slice(N)];
      for (const w of first) expect(w.terminated).toBeGreaterThanOrEqual(1);
      for (const w of second) {
        expect(w.of('init')).toHaveLength(1);
        expect(w.of('prepare').map((p) => p.kernel)).toEqual(['c']);
        expect(w.terminated).toBeGreaterThanOrEqual(1); // ended with the run
      }
      expect(first.every((w) => w.of('prepare').every((p) => p.kernel !== 'c'))).toBe(true);
    });

    it('a worker crash during measure fails that kernel and the next one still runs', async () => {
      const N = 2;
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: N },
        {
          override: (m, w) => {
            if (m.type === 'measure' && m.id === 1 && m.group.count === N && w.number === 1) {
              queueMicrotask(() => w.crash('Uncaught RuntimeError: unreachable'));
              return 'hang';
            }
            return undefined;
          },
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.error).toMatch(/unreachable/);
      expect(workersMade).toHaveLength(2 * N);
    });

    it('an unexpected reply type fails that kernel only', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        {
          override: (m, w) =>
            m.type === 'prepare' && m.kernel === 'a' && w.number === 0
              ? { type: 'ready', abi: 4 }
              : undefined,
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([false, true, true]);
      expect(outcomes[0]!.error).toMatch(/unexpected reply/);
    });

    it('an error reply to measure fails that kernel only', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        {
          override: (m, w) =>
            m.type === 'measure' && m.id === 0 && w.number === 0
              ? { type: 'error', id: m.id, message: 'measure before prepare' }
              : undefined,
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([false, true, true]);
      expect(outcomes[0]!.error).toBe('measure before prepare');
    });

    it('init failure on any worker rejects the whole run and runs nothing', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        {
          override: (m, w) =>
            m.type === 'init' && w.number === 2
              ? { type: 'error', message: 'kernel ABI mismatch: module has 3, page expects 4' }
              : undefined,
        },
      );
      const result = await settle(run.done);
      expect(result.ok).toBe(false);
      expect((result as { e: Error }).e.message).toMatch(/worker init failed: kernel ABI mismatch/);
      expect((result as { e: unknown }).e).not.toBeInstanceOf(Cancelled);
      expect(workersMade).toHaveLength(3); // no retry with a new pool
      expect(workersMade.flatMap((w) => w.of('prepare'))).toHaveLength(0);
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    // Matches single-core startRun ('a crash during init rejects'). multi.ts currently only treats
    // an init *error reply* as fatal; a crash becomes a per-kernel failure and the pool is rebuilt
    // for every kernel (multi.ts getPool / runKernel catch).
    it('a worker crash during init rejects the run', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        {
          override: (m, w) => {
            if (m.type === 'init') {
              queueMicrotask(() => w.crash('SyntaxError: bad module'));
              return 'hang';
            }
            return undefined;
          },
        },
      );
      await expect(run.done).rejects.toThrow(/bad module/);
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('a loadModule rejection rejects the run before any worker exists', async () => {
      const { run, workersMade } = start({
        kernels: defs,
        size: 'smoke',
        loadModule: () => Promise.reject(new Error('fetch failed: 404')),
      });
      await expect(run.done).rejects.toThrow(/fetch failed: 404/);
      expect(workersMade).toHaveLength(0);
    });

    it.each([0, -1, NaN])('workers = %s rejects and creates no workers', async (workers) => {
      const { run, workersMade } = start({ kernels: defs, size: 'smoke', workers });
      await expect(run.done).rejects.toThrow(/at least 1/);
      expect(workersMade).toHaveLength(0);
    });
  });

  describe('worker count', () => {
    it('a fractional count is truncated: 2.5 starts 2 workers', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 2.5 });
      const [o] = await run.done;
      expect(workersMade).toHaveLength(2);
      expect(o!.workers).toBe(2);
      expect(o!.all!.workers).toBe(2);
    });

    it('a count above maxWorkers is clamped: makeWorker is called max times', async () => {
      const { run, workersMade } = start({ kernels: defs, size: 'smoke', workers: 20, maxWorkers: 6 });
      const outcomes = await run.done;
      expect(workersMade).toHaveLength(6);
      expect(outcomes.every((o) => o.workers === 6 && o.all!.workers === 6)).toBe(true);
      expect(workersMade[0]!.of('measure').at(-1)!.group.count).toBe(6);
    });

    it('a count equal to maxWorkers is kept', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 3, maxWorkers: 3 });
      await run.done;
      expect(workersMade).toHaveLength(3);
    });

    it('without maxWorkers the cap is defaultMaxWorkers()', async () => {
      const { run, workersMade } = start({ kernels: [defs[0]!], size: 'smoke', workers: 100_000 });
      const [o] = await run.done;
      expect(workersMade).toHaveLength(defaultMaxWorkers());
      expect(o!.workers).toBe(defaultMaxWorkers());
    });
  });

  describe('first error wins', () => {
    it('an error reply to prepare from one worker fails the kernel without waiting for the others', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        {
          override: (m, w) => {
            if (m.type !== 'prepare' || m.kernel !== 'a' || w.number > 2) return undefined;
            // The first pool: worker 1 fails at once, workers 0 and 2 never answer.
            return w.number === 1
              ? { type: 'error', id: m.id, kernel: m.kernel, message: 'prepare failed (out of memory)' }
              : 'hang';
          },
        },
      );
      const outcomes = await run.done; // would never settle if it waited for workers 0 and 2
      expect(outcomes.map((o) => o.valid)).toEqual([false, true, true]);
      expect(outcomes[0]!.error).toBe('prepare failed (out of memory)');
      for (const w of workersMade.slice(0, 3)) expect(w.terminated).toBeGreaterThanOrEqual(1);
      expect(workersMade).toHaveLength(6); // a fresh pool for b and c
    });

    it('an error reply to measure from one worker fails the kernel without waiting for the others', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        {
          override: (m, w) => {
            if (m.type !== 'measure' || m.id !== 0 || m.group.count !== 3 || w.number > 2) return undefined;
            return w.number === 2
              ? { type: 'error', id: m.id, message: 'another worker failed' }
              : 'hang';
          },
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([false, true, true]);
      expect(outcomes[0]!.error).toBe('another worker failed');
    });

    it('a crash of one worker while the rest hang rejects that kernel at once', async () => {
      const { run } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        {
          override: (m, w) => {
            if (m.type !== 'measure' || m.id !== 1 || m.group.count !== 3 || w.number > 2) return undefined;
            if (w.number === 0) {
              queueMicrotask(() => w.crash('Uncaught RuntimeError: unreachable'));
            }
            return 'hang';
          },
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.error).toMatch(/unreachable/);
    });

    it('an init error from one worker rejects the run without waiting for the others', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        {
          override: (m, w) =>
            m.type === 'init'
              ? w.number === 1
                ? { type: 'error', message: 'kernel ABI mismatch: module has 3, page expects 4' }
                : 'hang'
              : undefined,
        },
      );
      await expect(run.done).rejects.toThrow(/worker init failed: kernel ABI mismatch/);
      expect(workersMade).toHaveLength(3);
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('a crash during init is fatal and the pool is not rebuilt per kernel', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 2 },
        {
          override: (m, w) => {
            if (m.type === 'init') {
              queueMicrotask(() => w.crash('SyntaxError: bad module'));
              return 'hang';
            }
            return undefined;
          },
        },
      );
      const r = await settle(run.done);
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).toMatch(/worker init failed: .*bad module/);
      expect(workersMade).toHaveLength(2);
    });
  });

  describe('cancel', () => {
    it('rejects with Cancelled during measure and terminates every worker', async () => {
      const N = 4;
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: N },
        { override: (m) => (m.type === 'measure' ? 'hang' : undefined) },
      );
      await sleep(10);
      expect(workersMade).toHaveLength(N);
      expect(workersMade[0]!.of('measure')).toHaveLength(1); // the baseline is in flight
      const settled = settle(run.done);
      run.cancel();
      const r = await settled;
      expect(r.ok).toBe(false);
      expect((r as { e: unknown }).e).toBeInstanceOf(Cancelled);
      expect(workersMade).toHaveLength(N); // no new pool after the cancel
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
      expect(workersMade.flatMap((w) => w.of('prepare')).every((p) => p.kernel === 'a')).toBe(true);
    });

    it('cancel while all workers wait on prepare terminates them and rejects with Cancelled', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        { override: (m) => (m.type === 'prepare' ? 'hang' : undefined) },
      );
      await sleep(10);
      run.cancel();
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('cancel while waiting for init rejects with Cancelled, not "init failed"', async () => {
      const { run, workersMade } = start(
        { kernels: defs, size: 'smoke', workers: 3 },
        { override: (m) => (m.type === 'init' ? 'hang' : undefined) },
      );
      await sleep(10);
      run.cancel();
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
      for (const w of workersMade) expect(w.terminated).toBeGreaterThanOrEqual(1);
      expect(workersMade.flatMap((w) => w.of('prepare'))).toHaveLength(0);
    });

    it('cancel during loadModule rejects with Cancelled and creates no workers', async () => {
      let release!: (m: WebAssembly.Module) => void;
      const { run, workersMade } = start({
        kernels: defs,
        size: 'smoke',
        loadModule: () => new Promise<WebAssembly.Module>((r) => (release = r)),
      });
      await sleep(5);
      run.cancel();
      release(FAKE_MODULE);
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
      expect(workersMade).toHaveLength(0);
    });

    it('cancelling from beforeKernel stops before that kernel is posted', async () => {
      const holder: { run?: ReturnType<typeof startMultiRun> } = {};
      const made: FakeWorker[] = [];
      holder.run = startMultiRun({
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        workers: 2,
        spinMs: 0,
        loadModule: () => Promise.resolve(FAKE_MODULE),
        beforeKernel: (i) => {
          if (i === 1) holder.run!.cancel();
        },
        makeWorker: () => {
          const w = new FakeWorker(made.length, {}, defs, 'smoke');
          made.push(w);
          return w as unknown as Worker;
        },
      });
      await expect(holder.run.done).rejects.toBeInstanceOf(Cancelled);
      expect(made.flatMap((w) => w.of('prepare')).map((p) => p.kernel)).toEqual(['a', 'a']);
      for (const w of made) expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('is safe to call twice and after completion', async () => {
      const { run } = start({ kernels: [defs[0]!], size: 'smoke', workers: 2 });
      await run.done;
      expect(() => {
        run.cancel();
        run.cancel();
      }).not.toThrow();
    });
  });

  describe('tab visibility', () => {
    class FakeDocument extends EventTarget {
      hidden = false;
    }
    const g = globalThis as { document?: unknown };
    const original = g.document;
    afterEach(() => {
      if (original === undefined) delete g.document;
      else g.document = original;
    });

    it('without a document nothing is hidden', async () => {
      delete g.document;
      const { run } = start({ kernels: defs, size: 'smoke' });
      expect((await run.done).every((o) => !o.hidden && o.valid)).toBe(true);
    });

    it('a hide during a measure marks that kernel hidden and invalid', async () => {
      const doc = new FakeDocument();
      g.document = doc;
      const { run } = start(
        { kernels: defs, size: 'smoke' },
        {
          override: (m, w) => {
            if (m.type === 'measure' && m.id === 1 && w.number === 0 && m.group.count > 1) {
              doc.hidden = true;
              doc.dispatchEvent(new Event('visibilitychange'));
              doc.hidden = false;
              doc.dispatchEvent(new Event('visibilitychange'));
            }
            return undefined;
          },
        },
      );
      const outcomes = await run.done;
      expect(outcomes.map((o) => o.hidden)).toEqual([false, true, false]);
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.checksumOk).toBe(true);
      expect(outcomes[1]!.error).toMatch(/hidden/);
    });

    it('a kernel that starts while the tab is hidden is hidden and invalid', async () => {
      const doc = new FakeDocument();
      doc.hidden = true;
      g.document = doc;
      const { run } = start({ kernels: [defs[0]!], size: 'smoke' });
      const [o] = await run.done;
      expect(o!.hidden).toBe(true);
      expect(o!.valid).toBe(false);
    });

    it('removes its visibilitychange listener when the run ends', async () => {
      const doc = new FakeDocument();
      let listeners = 0;
      const add = doc.addEventListener.bind(doc);
      const remove = doc.removeEventListener.bind(doc);
      doc.addEventListener = ((...a: Parameters<typeof add>) => {
        listeners++;
        add(...a);
      }) as typeof add;
      doc.removeEventListener = ((...a: Parameters<typeof remove>) => {
        listeners--;
        remove(...a);
      }) as typeof remove;
      g.document = doc;
      await start({ kernels: defs, size: 'smoke' }).run.done;
      expect(listeners).toBe(0);
    });
  });
});
