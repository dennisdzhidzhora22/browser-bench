import { afterEach, describe, expect, it } from 'vitest';
import type { KernelDef } from '../../src/lib/bench/types.ts';
import {
  Cancelled,
  NOISY_SPREAD,
  resultToOutcome,
  SAMPLING,
  SPIN_MS,
  startRun,
  type KernelOutcome,
  type RunMode,
  type RunOptions,
} from '../../src/lib/harness/orchestrator.ts';
import type {
  FromWorker,
  InitRequest,
  RunRequest,
  RunResult,
  ToWorker,
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

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    type: 'result',
    id: 0,
    kernel: 'k',
    checksum: 111,
    checksumConsistent: true,
    prepareMs: 1,
    times: Float64Array.of(100, 200, 300),
    ...over,
  };
}

// quick keeps the 3 fastest samples; these three are exactly those.
const quick = (def: KernelDef, r: RunResult, hidden = false, size = 10) =>
  resultToOutcome(def, size, 'smoke', 'quick', r, hidden);

describe('SAMPLING / constants', () => {
  it('quick takes 3..9 samples, full takes 7..21 (docs/SPEC.md, section 5)', () => {
    expect(SAMPLING.quick.minSamples).toBe(3);
    expect(SAMPLING.quick.maxSamples).toBe(9);
    expect(SAMPLING.full.minSamples).toBe(7);
    expect(SAMPLING.full.maxSamples).toBe(21);
  });
  it('is internally consistent for each mode', () => {
    for (const mode of ['quick', 'full'] as const) {
      const p = SAMPLING[mode];
      expect(p.maxSamples).toBeGreaterThanOrEqual(p.minSamples);
      expect(p.targetSpread).toBeGreaterThan(0);
      expect(p.targetSpread).toBeLessThan(NOISY_SPREAD);
      expect(p.maxMs).toBeGreaterThan(0);
    }
    expect(SAMPLING.full.minSamples).toBeGreaterThan(SAMPLING.quick.minSamples);
  });
  it('NOISY_SPREAD is 10% and SPIN_MS is positive', () => {
    expect(NOISY_SPREAD).toBe(0.1);
    expect(SPIN_MS).toBeGreaterThan(0);
  });
});

describe('resultToOutcome', () => {
  it('computes throughput as work / median seconds', () => {
    // median 200 ms = 0.2 s; work(10) = 20 -> 100 units/s
    const o = quick(fakeDef('k'), result());
    expect(o.checksumOk).toBe(true);
    expect(o.valid).toBe(true);
    expect(o.hidden).toBe(false);
    expect(o.error).toBeUndefined();
    expect(o.stats).toEqual({ median: 200, min: 100, max: 300, spread: 1 });
    expect(o.throughput).toBeCloseTo(100, 9);
    expect(o.samples).toBe(3);
  });

  it('reports how many samples were taken, not how many were used', () => {
    const o = quick(fakeDef('k'), result({ times: Float64Array.of(5, 4, 3, 2, 1, 9, 8) }));
    expect(o.samples).toBe(7);
  });

  it('uses only the minSamples fastest samples: slow outliers do not move the median', () => {
    // quick uses 3 fastest of 6: [10, 11, 12]; the 500/900/1000 interference is ignored.
    const o = quick(fakeDef('k'), result({ times: Float64Array.of(900, 11, 500, 10, 1000, 12) }));
    expect(o.stats).toEqual({ median: 11, min: 10, max: 12, spread: (12 - 10) / 11 });
    expect(o.throughput).toBeCloseTo(20 / 0.011, 6);
  });

  it('the fastest-k selection depends on the mode (quick 3, full 7)', () => {
    const times = Float64Array.of(10, 11, 12, 13, 14, 15, 16, 400, 500, 600);
    const q = resultToOutcome(fakeDef('k'), 10, 'smoke', 'quick', result({ times }));
    const f = resultToOutcome(fakeDef('k'), 10, 'smoke', 'full', result({ times }));
    expect(q.stats).toMatchObject({ median: 11, min: 10, max: 12 });
    expect(f.stats).toMatchObject({ median: 13, min: 10, max: 16 });
  });

  it('with fewer samples than minSamples it uses all of them', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', 'full', result({ times: Float64Array.of(100, 300) }));
    expect(o.stats?.median).toBe(200);
    expect(o.samples).toBe(2);
  });

  it('passes the size through to def.work', () => {
    const o = resultToOutcome(
      fakeDef('k', { work: (s) => s / 4 }),
      1000,
      'standard',
      'quick',
      result({ checksum: 222, times: Float64Array.of(500) }),
    );
    expect(o.throughput).toBeCloseTo(250 / 0.5, 9);
  });

  it('checks the checksum against expected for the size id used', () => {
    const d = fakeDef('k');
    expect(resultToOutcome(d, 10, 'smoke', 'quick', result({ checksum: 111 })).checksumOk).toBe(true);
    expect(resultToOutcome(d, 1000, 'standard', 'quick', result({ checksum: 222 })).checksumOk).toBe(true);
    expect(resultToOutcome(d, 1000, 'standard', 'quick', result({ checksum: 111 })).checksumOk).toBe(false);
  });

  it('marks a checksum mismatch invalid', () => {
    const o = quick(fakeDef('k'), result({ checksum: 112 }));
    expect(o.checksumOk).toBe(false);
    expect(o.valid).toBe(false);
    expect(o.error).toMatch(/checksum mismatch/);
  });

  it('marks inconsistent samples invalid even when the warm-up checksum is right', () => {
    const o = quick(fakeDef('k'), result({ checksumConsistent: false }));
    expect(o.checksumOk).toBe(false);
    expect(o.valid).toBe(false);
    expect(o.error).toMatch(/checksum mismatch/);
  });

  it('compares checksums as unsigned 32-bit values', () => {
    const def = fakeDef('k', { expected: { smoke: 0xdeadbeef, standard: 0xffffffff } });
    expect(resultToOutcome(def, 10, 'smoke', 'quick', result({ checksum: 0xdeadbeef })).checksumOk).toBe(true);
    expect(resultToOutcome(def, 10, 'standard', 'quick', result({ checksum: 0xffffffff })).checksumOk).toBe(true);
    expect(resultToOutcome(def, 10, 'smoke', 'quick', result({ checksum: 0xdeadbeef + 1 })).checksumOk).toBe(false);
  });

  it('has no throughput when the median time is zero', () => {
    const o = quick(fakeDef('k'), result({ times: Float64Array.of(0, 0, 0) }));
    expect(o.throughput).toBeUndefined();
    expect(o.stats?.median).toBe(0);
    expect(o.noisy).toBe(false);
  });

  it('carries the def through unchanged', () => {
    const def = fakeDef('k');
    expect(quick(def, result()).def).toBe(def);
  });

  describe('noisy', () => {
    it('is false when the fastest samples agree within NOISY_SPREAD', () => {
      // spread of 3 fastest = (104 - 100) / 102 ≈ 3.9 %
      const o = quick(fakeDef('k'), result({ times: Float64Array.of(100, 102, 104, 900) }));
      expect(o.stats!.spread).toBeLessThan(NOISY_SPREAD);
      expect(o.noisy).toBe(false);
      expect(o.valid).toBe(true);
    });

    it('is true above NOISY_SPREAD, but the result stays valid', () => {
      // spread = (120 - 100) / 110 ≈ 18 %
      const o = quick(fakeDef('k'), result({ times: Float64Array.of(100, 110, 120) }));
      expect(o.stats!.spread).toBeGreaterThan(NOISY_SPREAD);
      expect(o.noisy).toBe(true);
      expect(o.checksumOk).toBe(true);
      expect(o.valid).toBe(true);
      expect(o.error).toBeUndefined();
    });

    it('is judged on the fastest samples only, so slow outliers do not make a row noisy', () => {
      const o = quick(fakeDef('k'), result({ times: Float64Array.of(100, 101, 102, 5000, 9000) }));
      expect(o.noisy).toBe(false);
    });

    it('flips between a 9% and an 11% spread', () => {
      // median 100: spread (104.5 - 95.5) / 100 = 9 %, (105.5 - 94.5) / 100 = 11 %
      expect(quick(fakeDef('k'), result({ times: Float64Array.of(95.5, 100, 104.5) })).noisy).toBe(false);
      expect(quick(fakeDef('k'), result({ times: Float64Array.of(94.5, 100, 105.5) })).noisy).toBe(true);
    });
  });

  describe('hidden', () => {
    it('hidden=true makes the outcome invalid while the checksum is still ok', () => {
      const o = quick(fakeDef('k'), result(), true);
      expect(o.checksumOk).toBe(true);
      expect(o.hidden).toBe(true);
      expect(o.valid).toBe(false);
      expect(o.error).toMatch(/hidden/);
      // Timing data is kept for inspection.
      expect(o.stats).toBeDefined();
    });

    it('hidden defaults to false', () => {
      const o = resultToOutcome(fakeDef('k'), 10, 'smoke', 'quick', result());
      expect(o.hidden).toBe(false);
      expect(o.valid).toBe(true);
    });

    it('a checksum mismatch is reported as such even when hidden', () => {
      const o = quick(fakeDef('k'), result({ checksum: 1 }), true);
      expect(o.valid).toBe(false);
      expect(o.hidden).toBe(true);
      expect(o.checksumOk).toBe(false);
      expect(o.error).toMatch(/checksum mismatch/);
    });
  });
});

// ──────────────────────── startRun with a fake Worker ────────────────────────

type Handler = (msg: ToWorker, w: FakeWorker) => FromWorker | 'hang' | undefined;

class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = 0;
  readonly received: ToWorker[] = [];

  constructor(private readonly handler: Handler) {}

  postMessage(msg: ToWorker): void {
    this.received.push(msg);
    const reply = this.handler(msg, this);
    if (reply === undefined || reply === 'hang') return;
    queueMicrotask(() => this.emit(reply));
  }

  terminate(): void {
    this.terminated++;
  }

  emit(data: FromWorker): void {
    this.onmessage?.({ data } as MessageEvent<FromWorker>);
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }

  get runs(): RunRequest[] {
    return this.received.filter((m): m is RunRequest => m.type === 'run');
  }
  get inits(): InitRequest[] {
    return this.received.filter((m): m is InitRequest => m.type === 'init');
  }
}

/** A worker that answers init with ready and every run with a correct result. */
function wellBehaved(
  defs: readonly KernelDef[],
  size: 'smoke' | 'standard' = 'smoke',
): (msg: ToWorker) => FromWorker {
  return (msg) => {
    if (msg.type === 'init') return { type: 'ready', abi: 4 };
    const def = defs.find((d) => d.id === msg.kernel)!;
    return result({
      id: msg.id,
      kernel: msg.kernel,
      checksum: def.expected[size],
      times: Float64Array.of(10, 20, 30),
    });
  };
}

/** Fake compiled module: the orchestrator only passes it through. */
const FAKE_MODULE = { fake: 'module' } as unknown as WebAssembly.Module;

type Opts = Pick<RunOptions, 'kernels' | 'size' | 'mode'> & Partial<RunOptions>;

/** startRun with the fake worker and an instant fake module loader. */
function start(w: FakeWorker, opts: Opts) {
  return startRun({
    loadModule: () => Promise.resolve(FAKE_MODULE),
    spinMs: 0,
    ...opts,
    makeWorker: () => w as unknown as Worker,
  });
}

describe('startRun', () => {
  const defs = [fakeDef('a'), fakeDef('b'), fakeDef('c')];

  it('runs every kernel in order and returns one outcome each', async () => {
    const w = new FakeWorker(wellBehaved(defs));
    const events: string[] = [];
    const outcomes = await start(w, {
      kernels: defs,
      size: 'smoke',
      mode: 'quick',
      beforeKernel: (i, d) => void events.push(`before ${i} ${d.id}`),
      afterKernel: (i, o) => void events.push(`after ${i} ${o.def.id} ${o.valid}`),
    }).done;
    expect(outcomes.map((o) => o.def.id)).toEqual(['a', 'b', 'c']);
    expect(outcomes.every((o) => o.checksumOk && o.valid && !o.hidden && o.error === undefined)).toBe(true);
    expect(events).toEqual([
      'before 0 a',
      'after 0 a true',
      'before 1 b',
      'after 1 b true',
      'before 2 c',
      'after 2 c true',
    ]);
    expect(w.received[0]!.type).toBe('init');
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  describe('init message', () => {
    it('carries the compiled module from opts.loadModule and spinMs from opts', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const mod = { id: 'my-module' } as unknown as WebAssembly.Module;
      await start(w, {
        kernels: [defs[0]!],
        size: 'smoke',
        mode: 'quick',
        loadModule: () => Promise.resolve(mod),
        spinMs: 123,
      }).done;
      expect(w.inits).toHaveLength(1);
      expect(w.inits[0]!.module).toBe(mod);
      expect(w.inits[0]!.spinMs).toBe(123);
    });

    it('spinMs defaults to SPIN_MS', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      await startRun({
        kernels: [defs[0]!],
        size: 'smoke',
        mode: 'quick',
        loadModule: () => Promise.resolve(FAKE_MODULE),
        makeWorker: () => w as unknown as Worker,
      }).done;
      expect(w.inits[0]!.spinMs).toBe(SPIN_MS);
    });

    it('sends init exactly once, before any run', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      await start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done;
      expect(w.received.map((m) => m.type)).toEqual(['init', 'run', 'run', 'run']);
    });
  });

  describe('run message', () => {
    it.each<RunMode>(['quick', 'full'])('carries the SAMPLING plan for %s mode', async (mode) => {
      const w = new FakeWorker(wellBehaved(defs, 'standard'));
      await start(w, { kernels: [defs[0]!, defs[1]!], size: 'standard', mode }).done;
      const plan = SAMPLING[mode];
      expect(w.runs).toEqual([
        { type: 'run', id: 0, kernel: 'a', seed: 7, size: 1000, ...plan },
        { type: 'run', id: 1, kernel: 'b', seed: 7, size: 1000, ...plan },
      ]);
    });

    it('uses the smoke size for smoke runs', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      await start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' }).done;
      expect(w.runs[0]).toMatchObject({ kernel: 'a', seed: 7, size: 10, ...SAMPLING.quick });
    });
  });

  it('awaits beforeKernel before posting that kernel', async () => {
    const w = new FakeWorker(wellBehaved(defs));
    let seenAtBefore = -1;
    await start(w, {
      kernels: [defs[0]!],
      size: 'smoke',
      mode: 'quick',
      beforeKernel: async () => {
        await new Promise((r) => setTimeout(r, 20));
        seenAtBefore = w.runs.length;
      },
    }).done;
    expect(seenAtBefore).toBe(0);
    expect(w.runs).toHaveLength(1);
  });

  it('computes outcomes from the fastest samples of the reply', async () => {
    const w = new FakeWorker((msg) => {
      if (msg.type === 'init') return { type: 'ready', abi: 4 };
      return result({
        id: msg.id,
        kernel: msg.kernel,
        checksum: 111,
        times: Float64Array.of(900, 10, 700, 11, 12, 800),
      });
    });
    const [o] = await start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' }).done;
    expect(o!.stats).toMatchObject({ median: 11, min: 10, max: 12 });
    expect(o!.samples).toBe(6);
  });

  describe('module loading', () => {
    it('a loadModule rejection rejects the run and posts nothing', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const run = start(w, {
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        loadModule: () => Promise.reject(new Error('fetch failed: 404')),
      });
      await expect(run.done).rejects.toThrow(/fetch failed: 404/);
      await expect(run.done).rejects.not.toBeInstanceOf(Cancelled);
      expect(w.received).toHaveLength(0);
      expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('cancel during loadModule rejects with Cancelled and never posts', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      let release!: (m: WebAssembly.Module) => void;
      const run = start(w, {
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        loadModule: () => new Promise<WebAssembly.Module>((r) => (release = r)),
      });
      await new Promise((r) => setTimeout(r, 5));
      run.cancel();
      const settled = run.done.then(
        () => 'resolved',
        (e: unknown) => e,
      );
      release(FAKE_MODULE); // the load completes after the cancel
      expect(await settled).toBeInstanceOf(Cancelled);
      expect(w.received).toHaveLength(0);
      expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('cancel during loadModule rejects even if loadModule never settles', async () => {
      // The worker is already terminated by cancel(); the run must not hang forever if the
      // loader later resolves, and must not post. (A loader that never settles cannot be
      // observed from here, so settle it after cancel.)
      const w = new FakeWorker(wellBehaved(defs));
      let release!: (m: WebAssembly.Module) => void;
      const run = start(w, {
        kernels: [defs[0]!],
        size: 'smoke',
        mode: 'quick',
        loadModule: () => new Promise<WebAssembly.Module>((r) => (release = r)),
      });
      run.cancel();
      release(FAKE_MODULE);
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
    });
  });

  it('rejects when the worker fails to initialise, without running anything', async () => {
    const w = new FakeWorker((msg) =>
      msg.type === 'init'
        ? { type: 'error', message: 'kernel ABI mismatch: module has 3, page expects 4' }
        : undefined,
    );
    const run = start(w, { kernels: defs, size: 'smoke', mode: 'quick' });
    await expect(run.done).rejects.toThrow(/worker init failed: kernel ABI mismatch/);
    expect(w.runs).toHaveLength(0);
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it('a per-kernel error does not stop later kernels', async () => {
    const w = new FakeWorker((msg) => {
      if (msg.type === 'run' && msg.kernel === 'b') {
        return { type: 'error', id: msg.id, kernel: msg.kernel, message: 'prepare failed (out of memory)' };
      }
      return wellBehaved(defs)(msg);
    });
    const after: KernelOutcome[] = [];
    const outcomes = await start(w, {
      kernels: defs,
      size: 'smoke',
      mode: 'quick',
      afterKernel: (_i, o) => void after.push(o),
    }).done;
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.valid).toBe(true);
    expect(outcomes[1]!.checksumOk).toBe(false);
    expect(outcomes[1]!.valid).toBe(false);
    expect(outcomes[1]!.noisy).toBe(false);
    expect(outcomes[1]!.error).toBe('prepare failed (out of memory)');
    expect(outcomes[1]!.stats).toBeUndefined();
    expect(outcomes[1]!.throughput).toBeUndefined();
    expect(outcomes[2]!.valid).toBe(true);
    expect(w.runs.map((r) => r.kernel)).toEqual(['a', 'b', 'c']);
    expect(after).toHaveLength(3);
  });

  it('a reply for the wrong run id is reported as an error outcome', async () => {
    const w = new FakeWorker((msg) => {
      const r = wellBehaved(defs)(msg);
      return r.type === 'result' ? { ...r, id: r.id + 100 } : r;
    });
    const outcomes = await start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' }).done;
    expect(outcomes[0]!.checksumOk).toBe(false);
    expect(outcomes[0]!.valid).toBe(false);
    expect(outcomes[0]!.error).toMatch(/unexpected reply/);
  });

  it('a wrong checksum from the worker yields an invalid outcome, not a rejection', async () => {
    const w = new FakeWorker((msg) => {
      const r = wellBehaved(defs)(msg);
      return r.type === 'result' ? { ...r, checksum: 1 } : r;
    });
    const outcomes = await start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' }).done;
    expect(outcomes[0]!.checksumOk).toBe(false);
    expect(outcomes[0]!.valid).toBe(false);
    expect(outcomes[0]!.error).toMatch(/checksum mismatch/);
  });

  describe('tab visibility', () => {
    // Node has no document; install a minimal one for these tests only.
    class FakeDocument extends EventTarget {
      hidden = false;
    }
    const g = globalThis as { document?: unknown };
    const original = g.document;
    afterEach(() => {
      if (original === undefined) delete g.document;
      else g.document = original;
    });

    it('without a document nothing is ever hidden', async () => {
      delete g.document;
      const w = new FakeWorker(wellBehaved(defs));
      const outcomes = await start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done;
      expect(outcomes.every((o) => !o.hidden && o.valid)).toBe(true);
    });

    it('marks only the kernel during which the tab was hidden', async () => {
      const doc = new FakeDocument();
      g.document = doc;
      const w = new FakeWorker((msg) => {
        if (msg.type === 'run' && msg.kernel === 'b') {
          // Tab hidden and shown again while kernel b runs.
          doc.hidden = true;
          doc.dispatchEvent(new Event('visibilitychange'));
          doc.hidden = false;
          doc.dispatchEvent(new Event('visibilitychange'));
        }
        return wellBehaved(defs)(msg);
      });
      const outcomes = await start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done;
      expect(outcomes.map((o) => o.hidden)).toEqual([false, true, false]);
      expect(outcomes.map((o) => o.valid)).toEqual([true, false, true]);
      expect(outcomes[1]!.checksumOk).toBe(true);
    });

    it('marks a kernel that starts while the tab is already hidden', async () => {
      const doc = new FakeDocument();
      doc.hidden = true;
      g.document = doc;
      const w = new FakeWorker(wellBehaved(defs));
      const outcomes = await start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' }).done;
      expect(outcomes[0]!.hidden).toBe(true);
      expect(outcomes[0]!.valid).toBe(false);
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
      const w = new FakeWorker(wellBehaved(defs));
      await start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done;
      expect(listeners).toBe(0);
    });
  });

  describe('cancel', () => {
    it('rejects with Cancelled while a kernel is in flight and terminates the worker', async () => {
      const w = new FakeWorker((msg) => (msg.type === 'run' ? 'hang' : wellBehaved(defs)(msg)));
      const run = start(w, { kernels: defs, size: 'smoke', mode: 'quick' });
      await new Promise((r) => setTimeout(r, 10));
      expect(w.runs).toHaveLength(1);
      const settled = run.done.then(
        () => 'resolved',
        (e: unknown) => e,
      );
      run.cancel();
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(Cancelled);
      expect((outcome as Error).message).toBe('cancelled');
      expect(w.terminated).toBeGreaterThanOrEqual(1);
      expect(w.runs).toHaveLength(1);
    });

    it('rejects with Cancelled when cancelled while waiting for init', async () => {
      const w = new FakeWorker(() => 'hang');
      const run = start(w, { kernels: defs, size: 'smoke', mode: 'quick' });
      await new Promise((r) => setTimeout(r, 5)); // init has been posted
      expect(w.inits).toHaveLength(1);
      run.cancel();
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
      expect(w.runs).toHaveLength(0);
      expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('cancelling from beforeKernel stops before that kernel is posted', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const holder: { run?: ReturnType<typeof startRun> } = {};
      holder.run = start(w, {
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        beforeKernel: (i) => {
          if (i === 1) holder.run!.cancel();
        },
      });
      await expect(holder.run.done).rejects.toBeInstanceOf(Cancelled);
      expect(w.runs.map((r) => r.kernel)).toEqual(['a']);
    });

    it('is safe to call twice and after completion', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const run = start(w, { kernels: [defs[0]!], size: 'smoke', mode: 'quick' });
      await run.done;
      expect(() => {
        run.cancel();
        run.cancel();
      }).not.toThrow();
    });
  });

  describe('worker failure', () => {
    it('a crash during a run rejects instead of hanging', async () => {
      const w = new FakeWorker((msg, self) => {
        if (msg.type === 'run') {
          queueMicrotask(() => self.crash('Uncaught RuntimeError: unreachable'));
          return 'hang';
        }
        return wellBehaved(defs)(msg);
      });
      const run = start(w, { kernels: defs, size: 'smoke', mode: 'quick' });
      await expect(run.done).rejects.toThrow(/unreachable/);
      await expect(run.done).rejects.not.toBeInstanceOf(Cancelled);
      expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('a crash with no message still rejects, with a default message', async () => {
      const w = new FakeWorker((msg, self) => {
        if (msg.type === 'init') {
          queueMicrotask(() => self.crash(''));
          return 'hang';
        }
        return undefined;
      });
      await expect(start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done).rejects.toThrow(
        /worker crashed/,
      );
    });

    it('a crash during init rejects', async () => {
      const w = new FakeWorker((msg, self) => {
        if (msg.type === 'init') {
          queueMicrotask(() => self.crash('SyntaxError: bad module'));
          return 'hang';
        }
        return undefined;
      });
      await expect(start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done).rejects.toThrow(
        /bad module/,
      );
      expect(w.runs).toHaveLength(0);
    });

    it('an unreadable reply (messageerror) rejects', async () => {
      const w = new FakeWorker((msg, self) => {
        if (msg.type === 'run') {
          queueMicrotask(() => self.onmessageerror?.({} as MessageEvent));
          return 'hang';
        }
        return wellBehaved(defs)(msg);
      });
      await expect(start(w, { kernels: defs, size: 'smoke', mode: 'quick' }).done).rejects.toThrow(
        /could not be read/,
      );
    });

    it('preserves outcomes already reported via afterKernel when a later kernel crashes', async () => {
      const w = new FakeWorker((msg, self) => {
        if (msg.type === 'run' && msg.kernel === 'b') {
          queueMicrotask(() => self.crash('oom killed'));
          return 'hang';
        }
        return wellBehaved(defs)(msg);
      });
      const seen: string[] = [];
      const run = start(w, {
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        afterKernel: (_i, o) => void seen.push(o.def.id),
      });
      await expect(run.done).rejects.toThrow(/oom killed/);
      expect(seen).toEqual(['a']);
      expect(w.runs.map((r) => r.kernel)).toEqual(['a', 'b']);
    });
  });
});
