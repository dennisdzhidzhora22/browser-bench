// The real all-cores barrier (src/workers/runner.worker.ts, measureGroup) on real threads:
// Node worker_threads share SharedArrayBuffer and Atomics like browser workers do. The worker
// file is loaded unchanged through tests/unit/worker-shim.mjs.
//
// The threads run in a child process (tests/unit/barrier-runner.mjs), so a deadlock is caught
// by a timeout and a crash is an ordinary failure, not a dead vitest worker.
//
// Structure only: no assertion depends on how fast anything ran.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { MIX_EXPECTED } from '../../src/lib/bench/mix.ts';
import {
  BARRIER_TIMEOUT_MS,
  CTRL,
  ERROR_GEN,
  groupMsPerRep,
  SLOT,
  type MeasureRequest,
} from '../../src/lib/harness/protocol.ts';

const RUNNER = fileURLToPath(new URL('./barrier-runner.mjs', import.meta.url));
const DEADLOCK_MS = 20_000;
/** An aborted group must answer well before the 30 s barrier timeout. */
const ABORT_REPLY_MS = 5_000;

type Plan = Partial<Pick<MeasureRequest, 'minSamples' | 'maxSamples' | 'targetSpread' | 'maxMs'>>;

interface Scenario {
  threads: number;
  groups: Array<{ count: number; windowMs?: number; spinMs?: number; plan?: Plan }>;
  skipPrepare?: number[];
  kernel?: { id: string; seed: number; size: number };
}

interface Reply {
  type: string;
  id?: number;
  checksumConsistent?: boolean;
  message?: string;
}

interface Group {
  count: number;
  maxSamples: number;
  windowMs: number;
  elapsedMs: number;
  replies: Reply[];
  control: number[];
  times: number[];
}

interface Outcome {
  init: string[];
  prepared: Array<{ type: string; checksum?: number }>;
  groups: Group[];
}

function run(scenario: Scenario): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, JSON.stringify(scenario)],
      { timeout: DEADLOCK_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const hung = err.killed ? ` (killed after ${DEADLOCK_MS} ms: deadlock?)` : '';
          return reject(new Error(`barrier runner failed${hung}: ${err.message}\n${stderr}`));
        }
        resolve(JSON.parse(stdout) as Outcome);
      },
    );
  });
}

const at = (g: Group, s: number, w: number) => (s * g.count + w) * SLOT;

/** Checks everything that must hold for any finished group; returns the sample count. */
function expectWellFormed(g: Group, min: number, max: number): number {
  for (const r of g.replies) expect(r).toEqual({ type: 'measured', id: 7, checksumConsistent: true });
  const n = g.control[CTRL.SAMPLES]!;
  expect(n).toBeGreaterThanOrEqual(min);
  expect(n).toBeLessThanOrEqual(max);
  expect(g.control[CTRL.STOP]).toBe(1);
  expect(g.control[CTRL.ARRIVED]).toBe(0);
  expect(g.control[CTRL.READY]).toBe(g.count);
  expect(g.control[CTRL.GEN], 'no error bump').toBeLessThan(ERROR_GEN);

  for (let s = 0; s < n; s++) {
    for (let w = 0; w < g.count; w++) {
      const k = at(g, s, w);
      const [t0, t1, reps] = [g.times[k]!, g.times[k + 1]!, g.times[k + 2]!];
      expect(t0, `sample ${s} worker ${w} t0 written`).toBeGreaterThan(0);
      expect(t1, `sample ${s} worker ${w} t1 >= t0`).toBeGreaterThanOrEqual(t0);
      expect(Number.isInteger(reps) && reps >= 1, `sample ${s} worker ${w} reps >= 1`).toBe(true);
      expect(t1 - t0, `sample ${s} worker ${w} ran for the whole window`).toBeGreaterThanOrEqual(g.windowMs);
    }
    // The coordinator's score is finite and positive when time passed.
    const perRep = groupMsPerRep(Float64Array.from(g.times), s, g.count);
    expect(Number.isFinite(perRep)).toBe(true);
    expect(perRep).toBeGreaterThanOrEqual(0);
  }
  // Slots past the last sample were never touched.
  for (let s = n; s < g.maxSamples; s++) {
    for (let w = 0; w < g.count; w++) {
      for (let i = 0; i < SLOT; i++) expect(g.times[at(g, s, w) + i]).toBe(0);
    }
  }
  return n;
}

const single = (count: number, windowMs = 2, plan?: Plan): Scenario => ({
  threads: count,
  groups: [{ count, windowMs, ...(plan ? { plan } : {}) }],
});

describe('all-cores barrier on real threads (mix kernel)', () => {
  it('the runner hard-codes the same layout as the protocol', () => {
    expect(CTRL).toEqual({ GEN: 0, ARRIVED: 1, STOP: 2, READY: 3, SAMPLES: 4, LENGTH: 8 });
    expect(SLOT).toBe(3);
    expect(ERROR_GEN).toBeGreaterThan(1_000);
    expect(BARRIER_TIMEOUT_MS).toBe(30_000);
  });

  it('4 workers: no deadlock, sample count within the plan, every slot written', { timeout: 30_000 }, async () => {
    const out = await run(single(4));
    expect(out.init).toEqual(['ready', 'ready', 'ready', 'ready']);
    for (const p of out.prepared) expect(p).toMatchObject({ type: 'prepared', checksum: MIX_EXPECTED.smoke });
    expectWellFormed(out.groups[0]!, 3, 9);
  });

  it('windowMs > 0: every worker does at least one rep and runs at least windowMs per sample', { timeout: 30_000 }, async () => {
    const out = await run(single(3, 25, { minSamples: 3, maxSamples: 3 }));
    const g = out.groups[0]!;
    expect(expectWellFormed(g, 3, 3)).toBe(3);
    // mix at smoke size takes microseconds, so a 25 ms window holds many reps.
    for (let s = 0; s < 3; s++) {
      for (let w = 0; w < 3; w++) {
        expect(g.times[at(g, s, w) + 2]!).toBeGreaterThan(1);
        expect(g.times[at(g, s, w) + 1]! - g.times[at(g, s, w)]!).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('windowMs = 0: exactly one run() per sample', { timeout: 30_000 }, async () => {
    const out = await run(single(2, 0, { minSamples: 3, maxSamples: 3 }));
    const g = out.groups[0]!;
    expectWellFormed(g, 3, 3);
    for (let s = 0; s < 3; s++) for (let w = 0; w < 2; w++) expect(g.times[at(g, s, w) + 2]).toBe(1);
  });

  // The spin runs the `mix` kernel on the same wasm instance. Measuring a different kernel after
  // it must still give the prepared checksum every time (spin must not disturb its state).
  it.each(['sha256', 'matmul', 'sort_u32', 'lz'])(
    'spinMs: %s keeps its prepared state and checksum through the spin',
    { timeout: 30_000 },
    async (id) => {
      const def = cpuKernels.find((d) => d.id === id)!;
      const out = await run({
        threads: 3,
        kernel: { id, seed: def.seed, size: def.sizes.smoke },
        groups: [{ count: 3, windowMs: 2, spinMs: 40 }],
      });
      for (const p of out.prepared) expect(p).toMatchObject({ type: 'prepared', checksum: def.expected.smoke });
      expectWellFormed(out.groups[0]!, 3, 9);
    },
  );

  it('is released together: no worker starts sample s+1 before every worker finished sample s', { timeout: 30_000 }, async () => {
    const out = await run(single(4, 5, { minSamples: 5, maxSamples: 5 }));
    const g = out.groups[0]!;
    const n = expectWellFormed(g, 5, 5);
    // The threads share one clock (timeOrigin + now); allow a little skew between them.
    const SKEW_MS = 2;
    for (let s = 1; s < n; s++) {
      let prevEnd = -Infinity;
      for (let w = 0; w < g.count; w++) prevEnd = Math.max(prevEnd, g.times[at(g, s - 1, w) + 1]!);
      for (let w = 0; w < g.count; w++) {
        expect(g.times[at(g, s, w)]!, `sample ${s} worker ${w}`).toBeGreaterThanOrEqual(prevEnd - SKEW_MS);
      }
    }
  });

  it('maxSamples is a hard stop', { timeout: 30_000 }, async () => {
    // targetSpread -1 can never be met and maxMs is huge, so only maxSamples ends the run.
    const out = await run(single(3, 2, { minSamples: 2, maxSamples: 4, targetSpread: -1, maxMs: 1e9 }));
    expect(expectWellFormed(out.groups[0]!, 4, 4)).toBe(4);
  });

  it('stops at minSamples once the spread target is met', { timeout: 30_000 }, async () => {
    // Any spread satisfies a huge target, so the run ends right at minSamples.
    const out = await run(single(3, 2, { minSamples: 3, maxSamples: 9, targetSpread: 1e9 }));
    expect(expectWellFormed(out.groups[0]!, 3, 3)).toBe(3);
  });

  it('stops at minSamples once maxMs has passed', { timeout: 30_000 }, async () => {
    // Spread target unreachable, but maxMs is 0: out of time as soon as minSamples is reached.
    const out = await run(single(2, 2, { minSamples: 3, maxSamples: 9, targetSpread: -1, maxMs: 0 }));
    expect(expectWellFormed(out.groups[0]!, 3, 3)).toBe(3);
  });

  it('a single worker works (the baseline group)', { timeout: 30_000 }, async () => {
    const out = await run(single(1));
    expectWellFormed(out.groups[0]!, 3, 9);
  });

  it('two groups on the same threads, one after the other (baseline then all)', { timeout: 30_000 }, async () => {
    const plan = { minSamples: 3, maxSamples: 3, targetSpread: 0.05, maxMs: 3_000 };
    const out = await run({
      threads: 3,
      groups: [
        { count: 1, windowMs: 3, plan },
        { count: 3, windowMs: 3, plan },
      ],
    });
    expect(out.groups).toHaveLength(2);
    expectWellFormed(out.groups[0]!, 3, 3);
    expectWellFormed(out.groups[1]!, 3, 3);
  });

  describe('a worker failing mid-measure', () => {
    it('measure before prepare on the only worker is an error reply, not a hang', { timeout: 30_000 }, async () => {
      const out = await run({ threads: 1, skipPrepare: [0], groups: [{ count: 1, windowMs: 2 }] });
      expect(out.groups[0]!.replies[0]).toMatchObject({
        type: 'error',
        id: 7,
        message: 'measure before prepare',
      });
    });

    it('one of 4 workers failing releases the other 3 within seconds', { timeout: 30_000 }, async () => {
      const out = await run({ threads: 4, skipPrepare: [2], groups: [{ count: 4, windowMs: 2 }] });
      const g = out.groups[0]!;
      // Nobody waited for the barrier timeout.
      expect(g.elapsedMs).toBeLessThan(ABORT_REPLY_MS);
      expect(g.elapsedMs).toBeLessThan(BARRIER_TIMEOUT_MS);

      // Thread 2 reports its own error, the other three report the group failure.
      expect(g.replies).toHaveLength(4);
      for (const r of g.replies) expect(r).toMatchObject({ type: 'error', id: 7 });
      expect(g.replies[2]!.message).toBe('measure before prepare');
      for (const i of [0, 1, 3]) expect(g.replies[i]!.message).toBe('another worker failed');

      // The abort left its mark on the shared control block.
      expect(g.control[CTRL.STOP]).toBe(1);
      expect(g.control[CTRL.GEN]).toBeGreaterThanOrEqual(ERROR_GEN);
      expect(g.control[CTRL.SAMPLES]).toBe(0);
    });

    it('the failing worker may be the first or the last of the group', { timeout: 30_000 }, async () => {
      for (const bad of [0, 3]) {
        const out = await run({ threads: 4, skipPrepare: [bad], groups: [{ count: 4, windowMs: 2 }] });
        const g = out.groups[0]!;
        expect(g.elapsedMs).toBeLessThan(ABORT_REPLY_MS);
        expect(g.replies.map((r) => r.message)).toEqual(
          [0, 1, 2, 3].map((i) => (i === bad ? 'measure before prepare' : 'another worker failed')),
        );
      }
    });

    it('a failure is reported even when peers are still spinning before the barrier', { timeout: 30_000 }, async () => {
      const out = await run({
        threads: 3,
        skipPrepare: [1],
        groups: [{ count: 3, windowMs: 2, spinMs: 150 }],
      });
      const g = out.groups[0]!;
      expect(g.elapsedMs).toBeLessThan(ABORT_REPLY_MS);
      expect(g.replies.map((r) => r.message)).toEqual([
        'another worker failed',
        'measure before prepare',
        'another worker failed',
      ]);
    });
  });
});
