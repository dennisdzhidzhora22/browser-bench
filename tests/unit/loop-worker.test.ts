// The Endurance / Stress loop in runner.worker.ts (docs/SPEC.md, 4, "Loop"), driven in-process with a fake clock and a fake
// kernel module (no thread, no wasm): which slices run, what lands in `out` (mean rate) and `best` (fastest rep), the
// fallback to the mean when the fastest rep reads 0 ms, the missed-slice counter, and Stop. Nothing asserts on speed:
// every "time" here is a number the test sets.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOP, type FromWorker, type LoopKernel, type ToWorker } from '../../src/lib/harness/protocol.ts';

const EXPECTED = 0xabcd;

/**
 * Loads the worker with a fake wasm module and a fake `performance`. `run()` of a kernel advances the clock by
 * `warm` ms while the kernel is being warmed up (its first `prepare`), and afterwards by the next entry of `steps`
 * (then 40 ms when the list is empty). `hook` runs inside `run()` once the loop proper has started.
 */
async function harness(o: { steps?: number[]; warm?: number; wrong?: boolean; hook?: (control: Int32Array) => void } = {}) {
  vi.resetModules();
  let t = 0;
  vi.stubGlobal('performance', { timeOrigin: 0, now: () => t });
  const steps = [...(o.steps ?? [])];
  const prepares: Record<string, number> = {};
  let control: Int32Array | undefined;
  const kernel = (id: string) => ({
    prepare: () => {
      prepares[id] = (prepares[id] ?? 0) + 1;
      return 0;
    },
    run: () => {
      if (prepares[id] === 1) t += o.warm ?? 200; // warm-up: one rep is enough to end it
      else {
        t += steps.shift() ?? 40;
        if (control) o.hook?.(control);
      }
      return o.wrong && prepares[id]! > 1 ? EXPECTED + 1 : EXPECTED;
    },
  });
  vi.doMock('../../src/lib/harness/wasm.ts', () => ({
    instantiateKernels: async () => ({ abi_version: () => 1, kernel }),
  }));
  const replies: FromWorker[] = [];
  const fake: { postMessage(m: FromWorker): void; onmessage?: (e: { data: ToWorker }) => Promise<void> } = {
    postMessage: (m) => void replies.push(m),
  };
  vi.stubGlobal('self', fake);
  await import('../../src/workers/runner.worker.ts');
  const send = (data: ToWorker) => fake.onmessage!({ data });
  await send({ type: 'init', spinMs: 0, module: {} as WebAssembly.Module });
  return {
    replies,
    at: (ms: number) => void (t = ms),
    /** Runs a loop of `ids.length` kernels; window 0 starts at `start`. */
    async loop(ids: string[], start: number, windowMs: number, windows: number) {
      const c = new Int32Array(new SharedArrayBuffer(LOOP.LENGTH * 4));
      control = c;
      const size = windows * ids.length;
      const out = new Float64Array(new SharedArrayBuffer(size * 8)).fill(NaN);
      const best = new Float64Array(new SharedArrayBuffer(size * 8)).fill(NaN);
      const kernels: LoopKernel[] = ids.map((k) => ({ kernel: k, seed: 1, size: 10, expected: EXPECTED }));
      await send({ type: 'loop', id: 7, kernels, start, windowMs, windows, control: c, out, best });
      return { control: c, out, best, done: Atomics.load(c, LOOP.DONE), missed: Atomics.load(c, LOOP.MISSED) };
    },
  };
}

describe('runner.worker loop (fake clock)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/lib/harness/wasm.ts');
    vi.resetModules();
  });

  it('writes the mean rate to `out` and the fastest rep\'s rate to `best` for every window, and finishes with `looped`', async () => {
    // one kernel, 100 ms windows, window 0 at t = 200 (where the warm-up leaves the clock)
    // window 0: reps of 30, 5, 30, 30 ms: t1 = 295; a 5th would end past the slice end (300) by more than half a rep
    const h = await harness({ steps: [30, 5, 30, 30] });
    const r = await h.loop(['mix'], 200, 100, 2);
    expect(r.out[0]).toBeCloseTo(4 / 95, 12); // 4 reps in 95 ms
    expect(r.best[0]).toBeCloseTo(1 / 5, 12); // the 5 ms rep
    // window 1 (the rest are 40 ms reps): 3 reps in 120 ms; every rep equal, so fastest = mean
    expect(r.out[1]).toBeCloseTo(3 / 120, 12);
    expect(r.best[1]).toBeCloseTo(1 / 40, 12);
    for (let i = 0; i < 2; i++) expect(r.best[i]!).toBeGreaterThanOrEqual(r.out[i]!);
    expect(r.done).toBe(2);
    expect(r.missed).toBe(0);
    expect(h.replies.at(-1)).toEqual({ type: 'looped', id: 7 });
  });

  it('a fastest rep that reads 0 ms (below the timer resolution) stores the mean in `best`, not Infinity or NaN', async () => {
    const h = await harness({ steps: [0, 150] }); // rep 1: 0 ms, rep 2 ends the slice
    const r = await h.loop(['mix'], 200, 100, 1);
    expect(r.out[0]).toBeCloseTo(2 / 150, 12);
    expect(r.best[0]).toBe(r.out[0]);
    expect(Number.isFinite(r.best[0]!)).toBe(true);
    expect(r.best[0]!).toBeGreaterThan(0);
    expect(r.done).toBe(1);
  });

  it('does not start a rep it expects to end more than half a rep past the slice end', async () => {
    // reps of 30 ms from t = 200, slice end 300: after 3 reps t1 = 290; a 4th would end at 320, 20 ms over (> 15)
    const h = await harness({ steps: [30, 30, 30, 30] });
    const r = await h.loop(['mix'], 200, 100, 1);
    expect(r.out[0]).toBeCloseTo(3 / 90, 12);
  });

  it('a slice always runs at least one rep, even when one rep is longer than the slice', async () => {
    const h = await harness({ steps: [500] });
    const r = await h.loop(['mix'], 200, 100, 2);
    expect(r.out[0]).toBeCloseTo(1 / 500, 12);
    expect(r.best[0]).toBe(r.out[0]);
    // the next window (t = 700 by now, its slice ended at 400) is over: skipped as a missed slice, not read as slow
    expect(r.out[1]).toBeNaN();
    expect(r.best[1]).toBeNaN();
    expect(r.missed).toBe(1);
    expect(r.done).toBe(2);
  });

  it('a slice reached more than a whole slice late stays NaN and counts in MISSED; windows already over are skipped and counted', async () => {
    // two kernels, 100 ms windows (50 ms slices). The warm-up leaves the clock at 400, but window 0 started at 100:
    // slice 0 ended at 150 (+50 = 200 < 400) and slice 1 at 200: both missed. Window 1 (200..300) is over too: 2 more.
    const h = await harness({});
    const r = await h.loop(['mix', 'crc'], 100, 100, 2);
    expect(Array.from(r.out).every(Number.isNaN)).toBe(true);
    expect(Array.from(r.best).every(Number.isNaN)).toBe(true);
    expect(r.missed).toBe(4);
    expect(r.done).toBe(2); // the loop still reaches the end: the page counts windows, the series decides validity
    expect(h.replies.at(-1)).toEqual({ type: 'looped', id: 7 });
  });

  it('a slice that is merely late (less than a whole slice) still runs', async () => {
    // two kernels, 100 ms windows; the warm-up leaves the clock at 400 and window 0 starts at 350:
    // slice 0 ends at 400 (now 400 < 450): runs, in 40 ms reps; at least one rep
    const h = await harness({});
    const r = await h.loop(['mix', 'crc'], 350, 100, 1);
    expect(Number.isNaN(r.out[0]!)).toBe(false);
    expect(r.out[0]!).toBeGreaterThan(0);
    expect(r.missed).toBe(0);
  });

  it('Stop during a slice: the window cut short is not counted (DONE stays), and the worker still replies `looped`', async () => {
    const h = await harness({ hook: (c) => Atomics.store(c, LOOP.STOP, 1) });
    const r = await h.loop(['mix'], 200, 100, 3);
    expect(r.done).toBe(0);
    expect(r.missed).toBe(0);
    expect(h.replies.at(-1)).toEqual({ type: 'looped', id: 7 });
  });

  it('a wrong checksum in a slice fails the loop with an error naming the kernel, and no window is counted', async () => {
    const h = await harness({ wrong: true });
    const r = await h.loop(['mix'], 200, 100, 2);
    expect(r.done).toBe(0);
    const last = h.replies.at(-1)!;
    expect(last.type).toBe('error');
    expect((last as { message: string }).message).toMatch(/checksum mismatch in mix/);
  });

  it('a window is counted only after every kernel slice of it was written', async () => {
    const h = await harness({});
    const r = await h.loop(['mix', 'crc'], 400, 100, 2);
    // all four slices measured, rates positive, DONE = windows
    expect(Array.from(r.out).every((x) => x > 0)).toBe(true);
    expect(Array.from(r.best).every((x) => x > 0)).toBe(true);
    expect(r.done).toBe(2);
  });
});
