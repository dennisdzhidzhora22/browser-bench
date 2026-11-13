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
import { MIX_EXPECTED } from '../../src/lib/bench/mix.ts';
import { CTRL, type MeasureRequest } from '../../src/lib/harness/protocol.ts';

const RUNNER = fileURLToPath(new URL('./barrier-runner.mjs', import.meta.url));
const DEADLOCK_MS = 20_000;

type Plan = Partial<Pick<MeasureRequest, 'minSamples' | 'maxSamples' | 'targetSpread' | 'maxMs'>>;

interface Scenario {
  threads: number;
  groups: Array<{ count: number; reps: number; plan?: Plan }>;
  prepare?: boolean;
}

interface Group {
  count: number;
  maxSamples: number;
  replies: Array<{ type: string; id: number; checksumConsistent?: boolean; message?: string }>;
  control: number[];
  times: number[];
}

interface Outcome {
  init: string[];
  prepared: Array<{ type: string; checksum: number }>;
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

const slot = (g: Group, s: number, w: number) => (s * g.count + w) * 2;

/** Checks everything that must hold for any finished group; returns the sample count. */
function expectWellFormed(g: Group, min: number, max: number): number {
  for (const r of g.replies) expect(r).toEqual({ type: 'measured', id: 7, checksumConsistent: true });
  const n = g.control[CTRL.SAMPLES]!;
  expect(n).toBeGreaterThanOrEqual(min);
  expect(n).toBeLessThanOrEqual(max);
  expect(g.control[CTRL.STOP]).toBe(1);
  expect(g.control[CTRL.ARRIVED]).toBe(0);
  expect(g.control[CTRL.READY]).toBe(g.count);

  for (let s = 0; s < n; s++) {
    for (let w = 0; w < g.count; w++) {
      const t0 = g.times[slot(g, s, w)]!;
      const t1 = g.times[slot(g, s, w) + 1]!;
      expect(t0, `sample ${s} worker ${w} t0 written`).toBeGreaterThan(0);
      expect(t1, `sample ${s} worker ${w} t1 >= t0`).toBeGreaterThanOrEqual(t0);
    }
  }
  // Slots past the last sample were never touched.
  for (let s = n; s < g.maxSamples; s++) {
    for (let w = 0; w < g.count; w++) {
      expect(g.times[slot(g, s, w)]).toBe(0);
      expect(g.times[slot(g, s, w) + 1]).toBe(0);
    }
  }
  return n;
}

const single = (count: number, reps = 2_000, plan?: Plan): Scenario => ({
  threads: count,
  groups: [{ count, reps, ...(plan ? { plan } : {}) }],
});

describe('all-cores barrier on real threads (mix kernel)', () => {
  it('the runner hard-codes the same control layout as the protocol', () => {
    expect(CTRL).toEqual({ GEN: 0, ARRIVED: 1, STOP: 2, READY: 3, SAMPLES: 4, LENGTH: 8 });
  });

  it('4 workers: no deadlock, sample count within the plan, every slot written', { timeout: 30_000 }, async () => {
    const out = await run(single(4));
    expect(out.init).toEqual(['ready', 'ready', 'ready', 'ready']);
    for (const p of out.prepared) expect(p).toMatchObject({ type: 'prepared', checksum: MIX_EXPECTED.smoke });
    expectWellFormed(out.groups[0]!, 3, 9);
  });

  it('is released together: no worker starts sample s+1 before every worker finished sample s', { timeout: 30_000 }, async () => {
    const out = await run(single(4, 2_000, { minSamples: 5, maxSamples: 5 }));
    const g = out.groups[0]!;
    const n = expectWellFormed(g, 5, 5);
    // The threads share one clock (timeOrigin + now); allow a little skew between them.
    const SKEW_MS = 2;
    for (let s = 1; s < n; s++) {
      let prevEnd = -Infinity;
      for (let w = 0; w < g.count; w++) prevEnd = Math.max(prevEnd, g.times[slot(g, s - 1, w) + 1]!);
      for (let w = 0; w < g.count; w++) {
        expect(g.times[slot(g, s, w)]!, `sample ${s} worker ${w}`).toBeGreaterThanOrEqual(prevEnd - SKEW_MS);
      }
    }
  });

  it('maxSamples is a hard stop', { timeout: 30_000 }, async () => {
    // targetSpread -1 can never be met and maxMs is huge, so only maxSamples ends the run.
    const out = await run(single(3, 2_000, { minSamples: 2, maxSamples: 4, targetSpread: -1, maxMs: 1e9 }));
    expect(expectWellFormed(out.groups[0]!, 4, 4)).toBe(4);
  });

  it('stops at minSamples once the spread target is met', { timeout: 30_000 }, async () => {
    // Any spread satisfies a huge target, so the run ends right at minSamples.
    const out = await run(single(3, 2_000, { minSamples: 3, maxSamples: 9, targetSpread: 1e9 }));
    expect(expectWellFormed(out.groups[0]!, 3, 3)).toBe(3);
  });

  it('stops at minSamples once maxMs has passed', { timeout: 30_000 }, async () => {
    // Spread target unreachable, but maxMs is 0: out of time as soon as minSamples is reached.
    const out = await run(single(2, 2_000, { minSamples: 3, maxSamples: 9, targetSpread: -1, maxMs: 0 }));
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
        { count: 1, reps: 500, plan },
        { count: 3, reps: 500, plan },
      ],
    });
    expect(out.groups).toHaveLength(2);
    expectWellFormed(out.groups[0]!, 3, 3);
    expectWellFormed(out.groups[1]!, 3, 3);
  });

  it('measure before prepare is an error reply, not a hang', { timeout: 30_000 }, async () => {
    const out = await run({ threads: 1, prepare: false, groups: [{ count: 1, reps: 1 }] });
    expect(out.groups[0]!.replies[0]).toMatchObject({
      type: 'error',
      id: 7,
      message: 'measure before prepare',
    });
  });
});
