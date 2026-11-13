import { describe, expect, it } from 'vitest';
import type { KernelDef } from '../../src/lib/bench/types.ts';
import {
  Cancelled,
  resultToOutcome,
  SAMPLES,
  startRun,
  type KernelOutcome,
} from '../../src/lib/harness/orchestrator.ts';
import type { FromWorker, RunRequest, RunResult, ToWorker } from '../../src/lib/harness/protocol.ts';

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

describe('resultToOutcome', () => {
  it('computes throughput as work / median seconds', () => {
    // median 200 ms = 0.2 s; work(10) = 20 -> 100 units/s
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result());
    expect(o.checksumOk).toBe(true);
    expect(o.error).toBeUndefined();
    expect(o.stats).toEqual({ median: 200, min: 100, max: 300, spread: 1 });
    expect(o.throughput).toBeCloseTo(100, 9);
  });

  it('uses the median, not the mean or the best sample', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result({ times: Float64Array.of(1000, 50, 100) }));
    expect(o.stats?.median).toBe(100);
    expect(o.throughput).toBeCloseTo(20 / 0.1, 9);
  });

  it('averages the middle pair for an even sample count', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result({ times: Float64Array.of(100, 300) }));
    expect(o.stats?.median).toBe(200);
    expect(o.throughput).toBeCloseTo(100, 9);
  });

  it('passes the size through to def.work', () => {
    const o = resultToOutcome(
      fakeDef('k', { work: (s) => s / 4 }),
      1000,
      'standard',
      result({ checksum: 222, times: Float64Array.of(500) }),
    );
    expect(o.throughput).toBeCloseTo(250 / 0.5, 9);
  });

  it('checks the checksum against expected for the size id used', () => {
    expect(resultToOutcome(fakeDef('k'), 10, 'smoke', result({ checksum: 111 })).checksumOk).toBe(true);
    expect(resultToOutcome(fakeDef('k'), 1000, 'standard', result({ checksum: 222 })).checksumOk).toBe(true);
    // smoke checksum reported for a standard run is wrong
    expect(resultToOutcome(fakeDef('k'), 1000, 'standard', result({ checksum: 111 })).checksumOk).toBe(false);
  });

  it('marks a checksum mismatch invalid', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result({ checksum: 112 }));
    expect(o.checksumOk).toBe(false);
    expect(o.error).toMatch(/checksum mismatch/);
  });

  it('marks inconsistent samples invalid even when the warm-up checksum is right', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result({ checksumConsistent: false }));
    expect(o.checksumOk).toBe(false);
    expect(o.error).toMatch(/checksum mismatch/);
  });

  it('compares checksums as unsigned 32-bit values', () => {
    const def = fakeDef('k', { expected: { smoke: 0xdeadbeef, standard: 0xffffffff } });
    expect(resultToOutcome(def, 10, 'smoke', result({ checksum: 0xdeadbeef })).checksumOk).toBe(true);
    expect(resultToOutcome(def, 10, 'standard', result({ checksum: 0xffffffff })).checksumOk).toBe(true);
    // A worker reporting a signed i32 view of the same bits would be a bug on its side;
    // expected is normalised with >>> 0, the reported value is compared as-is.
    expect(resultToOutcome(def, 10, 'smoke', result({ checksum: 0xdeadbeef + 1 })).checksumOk).toBe(false);
  });

  it('has no throughput when the median time is zero', () => {
    const o = resultToOutcome(fakeDef('k'), 10, 'smoke', result({ times: Float64Array.of(0, 0, 0) }));
    expect(o.throughput).toBeUndefined();
    expect(o.stats?.median).toBe(0);
  });

  it('carries the def through unchanged', () => {
    const def = fakeDef('k');
    expect(resultToOutcome(def, 10, 'smoke', result()).def).toBe(def);
  });
});

describe('SAMPLES', () => {
  it('is 3 for quick and 7 for full (docs/SPEC.md, section 5)', () => {
    expect(SAMPLES).toEqual({ quick: 3, full: 7 });
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
}

/** A worker that answers init with ready and every run with a correct result. */
function wellBehaved(
  defs: readonly KernelDef[],
  size: 'smoke' | 'standard' = 'smoke',
): (msg: ToWorker) => FromWorker {
  return (msg) => {
    if (msg.type === 'init') return { type: 'ready', abi: 3 };
    const def = defs.find((d) => d.id === msg.kernel)!;
    return result({
      id: msg.id,
      kernel: msg.kernel,
      checksum: def.expected[size],
      times: Float64Array.of(10, 20, 30),
    });
  };
}

const asWorker = (w: FakeWorker) => (() => w as unknown as Worker);

describe('startRun', () => {
  const defs = [fakeDef('a'), fakeDef('b'), fakeDef('c')];

  it('runs every kernel in order and returns one outcome each', async () => {
    const w = new FakeWorker(wellBehaved(defs));
    const events: string[] = [];
    const run = startRun(
      {
        kernels: defs,
        size: 'smoke',
        mode: 'quick',
        beforeKernel: (i, d) => void events.push(`before ${i} ${d.id}`),
        afterKernel: (i, o) => void events.push(`after ${i} ${o.def.id} ${o.checksumOk}`),
      },
      asWorker(w),
    );
    const outcomes = await run.done;
    expect(outcomes.map((o) => o.def.id)).toEqual(['a', 'b', 'c']);
    expect(outcomes.every((o) => o.checksumOk && o.error === undefined)).toBe(true);
    expect(events).toEqual([
      'before 0 a',
      'after 0 a true',
      'before 1 b',
      'after 1 b true',
      'before 2 c',
      'after 2 c true',
    ]);
    expect(w.received[0]).toEqual({ type: 'init' });
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it('posts run requests built from the def, size id and mode', async () => {
    const w = new FakeWorker(wellBehaved(defs, 'standard'));
    await startRun({ kernels: [defs[0]!, defs[1]!], size: 'standard', mode: 'full' }, asWorker(w)).done;
    expect(w.runs).toEqual([
      { type: 'run', id: 0, kernel: 'a', seed: 7, size: 1000, samples: 7 },
      { type: 'run', id: 1, kernel: 'b', seed: 7, size: 1000, samples: 7 },
    ]);
    const q = new FakeWorker(wellBehaved(defs));
    await startRun({ kernels: [defs[0]!], size: 'smoke', mode: 'quick' }, asWorker(q)).done;
    expect(q.runs).toEqual([{ type: 'run', id: 0, kernel: 'a', seed: 7, size: 10, samples: 3 }]);
  });

  it('awaits beforeKernel before posting that kernel', async () => {
    const w = new FakeWorker(wellBehaved(defs));
    let seenAtBefore = -1;
    await startRun(
      {
        kernels: [defs[0]!],
        size: 'smoke',
        mode: 'quick',
        beforeKernel: async () => {
          await new Promise((r) => setTimeout(r, 20));
          seenAtBefore = w.runs.length;
        },
      },
      asWorker(w),
    ).done;
    expect(seenAtBefore).toBe(0);
    expect(w.runs).toHaveLength(1);
  });

  it('rejects when the worker fails to initialise, without running anything', async () => {
    const w = new FakeWorker((msg) =>
      msg.type === 'init' ? { type: 'error', message: 'kernel ABI mismatch: module has 2, page expects 3' } : undefined,
    );
    const run = startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w));
    await expect(run.done).rejects.toThrow(/worker init failed: kernel ABI mismatch/);
    expect(w.runs).toHaveLength(0);
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it('a per-kernel error does not stop later kernels', async () => {
    const w = new FakeWorker((msg, self) => {
      if (msg.type === 'run' && msg.kernel === 'b') {
        return { type: 'error', id: msg.id, kernel: msg.kernel, message: 'prepare failed (out of memory)' };
      }
      return wellBehaved(defs)(msg);
    });
    const after: KernelOutcome[] = [];
    const outcomes = await startRun(
      { kernels: defs, size: 'smoke', mode: 'quick', afterKernel: (_i, o) => void after.push(o) },
      asWorker(w),
    ).done;
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.checksumOk).toBe(true);
    expect(outcomes[1]!.checksumOk).toBe(false);
    expect(outcomes[1]!.error).toBe('prepare failed (out of memory)');
    expect(outcomes[1]!.stats).toBeUndefined();
    expect(outcomes[1]!.throughput).toBeUndefined();
    expect(outcomes[2]!.checksumOk).toBe(true);
    expect(w.runs.map((r) => r.kernel)).toEqual(['a', 'b', 'c']);
    expect(after).toHaveLength(3);
  });

  it('a reply for the wrong run id is reported as an error outcome', async () => {
    const w = new FakeWorker((msg, self) => {
      const r = wellBehaved(defs)(msg);
      return r && r.type === 'result' ? { ...r, id: r.id + 100 } : r;
    });
    const outcomes = await startRun({ kernels: [defs[0]!], size: 'smoke', mode: 'quick' }, asWorker(w)).done;
    expect(outcomes[0]!.checksumOk).toBe(false);
    expect(outcomes[0]!.error).toMatch(/unexpected reply/);
  });

  it('a wrong checksum from the worker yields an invalid outcome, not a rejection', async () => {
    const w = new FakeWorker((msg, self) => {
      const r = wellBehaved(defs)(msg);
      return r && r.type === 'result' ? { ...r, checksum: 1 } : r;
    });
    const outcomes = await startRun({ kernels: [defs[0]!], size: 'smoke', mode: 'quick' }, asWorker(w)).done;
    expect(outcomes[0]!.checksumOk).toBe(false);
    expect(outcomes[0]!.error).toMatch(/checksum mismatch/);
  });

  describe('cancel', () => {
    it('rejects with Cancelled while a kernel is in flight and terminates the worker', async () => {
      const w = new FakeWorker((msg) => (msg.type === 'run' ? 'hang' : wellBehaved(defs)(msg)));
      const run = startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w));
      // Let init complete and the first run request go out.
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
      expect(w.runs).toHaveLength(1); // nothing more was sent
    });

    it('rejects with Cancelled when cancelled before init completes', async () => {
      const w = new FakeWorker(() => 'hang');
      const run = startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w));
      run.cancel();
      await expect(run.done).rejects.toBeInstanceOf(Cancelled);
      expect(w.runs).toHaveLength(0);
      expect(w.terminated).toBeGreaterThanOrEqual(1);
    });

    it('cancelling from beforeKernel stops before that kernel is posted', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const holder: { run?: ReturnType<typeof startRun> } = {};
      holder.run = startRun(
        {
          kernels: defs,
          size: 'smoke',
          mode: 'quick',
          beforeKernel: (i) => {
            if (i === 1) holder.run!.cancel();
          },
        },
        asWorker(w),
      );
      await expect(holder.run.done).rejects.toBeInstanceOf(Cancelled);
      expect(w.runs.map((r) => r.kernel)).toEqual(['a']);
    });

    it('is safe to call twice and after completion', async () => {
      const w = new FakeWorker(wellBehaved(defs));
      const run = startRun({ kernels: [defs[0]!], size: 'smoke', mode: 'quick' }, asWorker(w));
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
      const run = startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w));
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
      await expect(startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w)).done).rejects.toThrow(
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
      await expect(startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w)).done).rejects.toThrow(
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
      await expect(startRun({ kernels: defs, size: 'smoke', mode: 'quick' }, asWorker(w)).done).rejects.toThrow(
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
      const run = startRun(
        { kernels: defs, size: 'smoke', mode: 'quick', afterKernel: (_i, o) => void seen.push(o.def.id) },
        asWorker(w),
      );
      await expect(run.done).rejects.toThrow(/oom killed/);
      expect(seen).toEqual(['a']);
      expect(w.runs.map((r) => r.kernel)).toEqual(['a', 'b']); // c never sent
    });
  });
});
