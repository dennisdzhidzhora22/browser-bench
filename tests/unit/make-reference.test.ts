// scripts/make-reference.mjs run as a child process against a COPY of the repo layout in a temp dir
// (script, src/lib, a node_modules junction), so the real constants.ts and references.json are never touched.
// Fixtures are built with the app's own record code; every number is made up and nothing asserts on speed.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCORE_VERSION } from '../../src/lib/scoring/constants.ts';
import type { RunRecord } from '../../src/lib/store/schema.ts';
import { completeRecord } from './store-support.ts';

const REPO = resolve(import.meta.dirname, '../..');
const REAL_CONSTANTS = join(REPO, 'src/lib/scoring/constants.ts');
const REAL_REFERENCES = join(REPO, 'src/lib/scoring/references.json');
// constants.ts as it was before the M8 freeze (git show 6a4ca90:src/lib/scoring/constants.ts), kept as a
// fixture so these tests do not depend on whether the real files are provisional or frozen. `.txt` keeps it out
// of the TypeScript and lint passes.
const PROVISIONAL_CONSTANTS = join(REPO, 'tests/fixtures/constants.provisional.ts.txt');

let tmp: string;
let constantsTs: string;
let referencesJson: string;
let pristineConstants: string;
let pristineReferences: string;
let realBefore: { constants: string; references: string };

beforeAll(() => {
  realBefore = { constants: readFileSync(REAL_CONSTANTS, 'utf8'), references: readFileSync(REAL_REFERENCES, 'utf8') };
  tmp = mkdtempSync(join(tmpdir(), 'bb-makeref-'));
  cpSync(join(REPO, 'scripts/make-reference.mjs'), join(tmp, 'scripts/make-reference.mjs'));
  cpSync(join(REPO, 'src/lib'), join(tmp, 'src/lib'), { recursive: true });
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n');
  symlinkSync(join(REPO, 'node_modules'), join(tmp, 'node_modules'), 'junction');
  constantsTs = join(tmp, 'src/lib/scoring/constants.ts');
  referencesJson = join(tmp, 'src/lib/scoring/references.json');
  // The temp copy starts provisional with no references, whatever state the real files are in.
  pristineConstants = readFileSync(PROVISIONAL_CONSTANTS, 'utf8');
  pristineReferences = '[]\n';
  writeFileSync(constantsTs, pristineConstants);
  writeFileSync(referencesJson, pristineReferences);
}, 60_000);

afterEach(() => {
  // The real files must be exactly as they were after every test.
  expect(readFileSync(REAL_CONSTANTS, 'utf8')).toBe(realBefore.constants);
  expect(readFileSync(REAL_REFERENCES, 'utf8')).toBe(realBefore.references);
});

afterAll(() => {
  // Remove the junction itself first so the recursive delete cannot follow it into the real node_modules.
  try {
    unlinkSync(join(tmp, 'node_modules'));
  } catch {
    try {
      rmSync(join(tmp, 'node_modules'), { force: true });
    } catch {
      // leave it for the OS temp cleaner rather than risk a recursive delete through the link
      return;
    }
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  // The real files must be exactly as they were.
  expect(readFileSync(REAL_CONSTANTS, 'utf8')).toBe(realBefore.constants);
  expect(readFileSync(REAL_REFERENCES, 'utf8')).toBe(realBefore.references);
});

beforeEach(() => {
  writeFileSync(constantsTs, pristineConstants);
  writeFileSync(referencesJson, pristineReferences);
});

/** A complete Full standard-size run whose values are 1.2347x every constant. */
const good = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...completeRecord({ mode: 'full', size: 'standard', scale: 1.2347 }),
  id: 'run-good',
  time: '2026-11-15T10:00:00.000Z',
  ...over,
});

let n = 0;
/** Writes an export file with these runs and runs the script on it. */
function make(runs: RunRecord[], ...args: string[]) {
  const file = join(tmp, `export-${n++}.json`);
  writeFileSync(file, JSON.stringify({ format: 'browser-bench', schema: 1, runs }));
  return makeRaw(file, ...args);
}
function makeRaw(file: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(tmp, 'scripts/make-reference.mjs'), file, ...args], { encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const refs = () =>
  JSON.parse(readFileSync(referencesJson, 'utf8')) as Array<{
    name: string;
    scoreVersion: number;
    results: Record<string, number>;
    points: Record<string, number>;
  }>;

/** A copy of the run with `f` applied to its component `id`. */
function edit(r: RunRecord, id: string, f: (c: RunRecord['components'][number]) => void): RunRecord {
  const copy = structuredClone(r);
  f(copy.components.find((c) => c.id === id)!);
  return copy;
}

function expectRefused(res: ReturnType<typeof make>, ...needles: string[]) {
  expect(res.code).toBe(1);
  expect(res.err).toContain('make-reference: refusing run');
  for (const s of needles) expect(res.err).toContain(s);
  // Refused: nothing written, nothing frozen.
  expect(readFileSync(referencesJson, 'utf8')).toBe(pristineReferences);
  expect(readFileSync(constantsTs, 'utf8')).toBe(pristineConstants);
}

describe('make-reference: refusals', () => {
  it('refuses a smoke-size run', () => {
    const r = good({ size: 'smoke' });
    expectRefused(make([r], r.id), 'smoke');
  });

  it('refuses a Quick run chosen by id', () => {
    const r = good({ mode: 'quick' });
    expectRefused(make([r], r.id), 'not Full');
  });

  it('refuses an Endurance run chosen by id', () => {
    const r = good({ mode: 'endurance' });
    expectRefused(make([r], r.id), 'mode is endurance');
  });

  it('"latest" with no Full standard-size run says so', () => {
    const res = make([good({ mode: 'quick' }), good({ size: 'smoke', id: 's' })]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('no Full standard-size run');
    expect(readFileSync(referencesJson, 'utf8')).toBe(pristineReferences);
  });

  it('an unknown run id is refused', () => {
    const res = make([good()], 'nope');
    expect(res.code).toBe(1);
    expect(res.err).toContain('no run with id nope');
  });

  it('refuses another scoreVersion', () => {
    const r = good({ scoreVersion: SCORE_VERSION + 1 });
    expectRefused(make([r], r.id), 'scoreVersion');
  });

  // The script rescores before validating, so hand-set points/partial/note are recomputed: each fixture
  // below is built from a real cause instead.
  it('refuses a partial component (memory all-cores copy on a worker count other than the core count)', () => {
    const r = edit(good(), 'memory', (c) => void (c.kernels.find((k) => k.workers !== undefined)!.workers = 8));
    expectRefused(make([r], r.id), 'memory: 8 workers, not 16', 'memory: partial');
  });

  it('refuses a component without points (every kernel invalid)', () => {
    const r = edit(good(), 'storage', (c) => {
      for (const k of c.kernels) {
        k.valid = false;
        k.value = null;
      }
    });
    expectRefused(make([r], r.id), 'storage: no points', 'storage: no valid results');
  });

  it('refuses a missing component', () => {
    const r = good();
    r.components = r.components.filter((c) => c.id !== 'gpu');
    expectRefused(make([r], r.id), 'gpu: not run');
  });

  it('refuses a component with an error', () => {
    const r = edit(good(), 'cpu-multi', (c) => void (c.error = 'worker crashed'));
    expectRefused(make([r], r.id), 'cpu-multi: worker crashed');
  });

  it('refuses an invalid kernel', () => {
    const r = edit(good(), 'cpu-single', (c) => {
      c.kernels[2]!.valid = false;
      c.kernels[2]!.value = null;
    });
    expectRefused(make([r], r.id), `cpu-single/${r.components.find((c) => c.id === 'cpu-single')!.kernels[2]!.key}: invalid`);
  });

  it('refuses a hidden kernel', () => {
    const r = edit(good(), 'cpu-single', (c) => void (c.kernels[1]!.hidden = true));
    expectRefused(make([r], r.id), 'tab was hidden');
  });

  it('refuses a kernel whose output check failed', () => {
    const r = edit(good(), 'memory', (c) => void (c.kernels[0]!.checksumOk = false));
    expectRefused(make([r], r.id), 'output check failed');
  });

  it('refuses a component that carries a note (scaled-down storage file)', () => {
    const r = edit(good(), 'storage', (c) => void (c.scaled = true));
    expectRefused(make([r], r.id), 'storage: smaller test file');
  });

  it('refuses a component that carries a note (WebGL2 fallback GPU kernel)', () => {
    const r = good();
    const fast = r.components.find((c) => c.id === 'gpu' && c.gpu?.preference === 'high-performance')!;
    fast.gpu!.api = 'webgl2';
    expectRefused(make([r], r.id), 'gpu: fallback');
  });

  it('refuses a counted GPU that is not the Fast (high-performance) one', () => {
    const r = good();
    // Only the low-power GPU was tested, so it is the one that counts.
    r.components = r.components.filter((c) => !(c.id === 'gpu' && c.gpu?.preference === 'high-performance'));
    expectRefused(make([r], r.id), 'gpu: not the Fast GPU');
  });

  it('refuses a run missing a kernel a constant needs (the component would be partial)', () => {
    const r = edit(good(), 'storage', (c) => void c.kernels.pop());
    expectRefused(make([r], r.id), 'missing');
  });

  it('refuses a file that is not a browser-bench export, and an unknown option', () => {
    const f = join(tmp, 'bad.json');
    writeFileSync(f, '{"format":"other","runs":[]}');
    expect(makeRaw(f).err).toContain('not a browser-bench export');
    expect(makeRaw(f, '--bogus').err).toContain('unknown option --bogus');
  });

  it('--name followed by a flag (or nothing) fails with "--name needs a value"', () => {
    const run = good();
    for (const args of [[run.id, '--name', '--freeze'], [run.id, '--name']]) {
      const res = make([run], ...args);
      expect(res.code).toBe(1);
      expect(res.err).toContain('--name needs a value');
      expect(readFileSync(referencesJson, 'utf8')).toBe(pristineReferences);
      expect(readFileSync(constantsTs, 'utf8')).toBe(pristineConstants);
    }
  });
});

describe('make-reference: writing the entry', () => {
  it('adds an entry with name, scoreVersion, every result and points above 1000 per component', () => {
    const run = good();
    const res = make([run], run.id, '--name', 'Test PC');
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain('references.json: added "Test PC"');
    const list = refs();
    expect(list).toHaveLength(1);
    const e = list[0]!;
    expect(e.name).toBe('Test PC');
    expect(e.scoreVersion).toBe(SCORE_VERSION);
    expect(Object.keys(e.points).sort()).toEqual(['cpu-multi', 'cpu-single', 'gpu', 'memory', 'storage', 'total']);
    // Every constant has a result, keyed <component>/<defKey>, equal to the run's value.
    const constKeys = [...pristineConstants.matchAll(/^\s*'([\w-]+\/[\w:]+)': [\d.e+-]+,$/gm)].map((m) => m[1]!).sort();
    expect(Object.keys(e.results).sort()).toEqual(constKeys);
    const k = run.components.find((c) => c.id === 'cpu-single')!.kernels[0]!;
    expect(e.results[`cpu-single/${k.key}`]).toBe(k.value);
    for (const p of Object.values(e.points)) expect(p).toBeGreaterThan(1000);
    // Not frozen: constants untouched without --freeze.
    expect(readFileSync(constantsTs, 'utf8')).toBe(pristineConstants);
  });

  it('defaults the name to "Owner PC" and picks the newest Full run for "latest"', () => {
    const older = good({ id: 'older', time: '2026-11-01T00:00:00.000Z' });
    const newer = good({ id: 'newer', time: '2026-11-10T00:00:00.000Z' });
    newer.components.find((c) => c.id === 'cpu-single')!.kernels[0]!.value! *= 1.5;
    const quick = good({ id: 'quick', time: '2026-11-12T00:00:00.000Z', mode: 'quick' });
    const res = make([older, newer, quick]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('from run newer');
    const e = refs()[0]!;
    expect(e.name).toBe('Owner PC');
    const k0 = newer.components.find((c) => c.id === 'cpu-single')!.kernels[0]!;
    expect(e.results[`cpu-single/${k0.key}`]).toBe(k0.value);
  });

  it('is idempotent: a second run with the same name replaces, never duplicates', () => {
    const run = good();
    expect(make([run], run.id).code).toBe(0);
    const first = readFileSync(referencesJson, 'utf8');
    const second = make([run], run.id);
    expect(second.code).toBe(0);
    expect(second.out).toContain('replaced "Owner PC"');
    expect(readFileSync(referencesJson, 'utf8')).toBe(first);
    expect(refs()).toHaveLength(1);
  });

  it('a different name is added in front, the earlier entry stays', () => {
    const run = good();
    make([run], run.id, '--name', 'A');
    make([run], run.id, '--name', 'B');
    expect(refs().map((r) => r.name)).toEqual(['B', 'A']);
  });
});

describe('make-reference: --freeze (on a copy of constants.ts)', () => {
  const constantLines = (ts: string) => [...ts.matchAll(/^\s*'([\w-]+\/[\w:]+)': ([\d.e+-]+),$/gm)].map((m) => [m[1]!, Number(m[2])] as const);

  it('rewrites every constant to 3 significant digits of the run, keeps SCORE_VERSION, replaces the PROVISIONAL block', () => {
    const run = good();
    const res = make([run], run.id, '--name', 'Frozen PC', '--freeze');
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain('constants frozen');
    const ts = readFileSync(constantsTs, 'utf8');
    expect(ts).toContain(`export const SCORE_VERSION = ${SCORE_VERSION};`);
    expect(ts).not.toContain('PROVISIONAL');
    expect(ts).toContain(`FROZEN (M8) for SCORE_VERSION ${SCORE_VERSION}`);
    expect(ts).toContain('"Frozen PC"');
    expect(ts).toContain(`Run ${run.id}`);
    const e = refs()[0]!;
    const lines = constantLines(ts);
    expect(lines.length).toBe(constantLines(pristineConstants).length);
    for (const [key, v] of lines) expect(v).toBe(Number(e.results[key]!.toPrecision(3)));
    // Reference points are computed against the frozen constants: about 1000 each (3-digit rounding only).
    for (const p of Object.values(e.points)) expect(Math.abs(p - 1000)).toBeLessThan(40);
    // Everything outside the constants and the comments is unchanged.
    const strip = (s: string) =>
      s
        .replace(/^\s*'[\w-]+\/[\w:]+': [\d.e+-]+,$/gm, '')
        .replace(/^\/\/.*$/gm, '')
        .replace(/\n+/g, '\n');
    expect(strip(ts)).toBe(strip(pristineConstants));
  });

  it('is idempotent: re-running on the frozen files reproduces them; --freeze again refuses and changes nothing', () => {
    const run = good();
    expect(make([run], run.id, '--freeze').code).toBe(0);
    const frozenTs = readFileSync(constantsTs, 'utf8');
    const frozenRefs = readFileSync(referencesJson, 'utf8');
    const again = make([run], run.id);
    expect(again.code).toBe(0);
    expect(readFileSync(constantsTs, 'utf8')).toBe(frozenTs);
    expect(readFileSync(referencesJson, 'utf8')).toBe(frozenRefs);
    const third = make([run], run.id, '--freeze');
    expect(third.code).toBe(1);
    expect(third.err).toContain('PROVISIONAL');
    expect(readFileSync(constantsTs, 'utf8')).toBe(frozenTs);
    expect(readFileSync(referencesJson, 'utf8')).toBe(frozenRefs);
  });

  it('a refused run never freezes anything', () => {
    const r = good({ size: 'smoke' });
    expectRefused(make([r], r.id, '--freeze'), 'smoke');
  });
});

describe('real scoring files (frozen state)', () => {
  it('constants.ts is frozen and references.json holds exactly the "Owner PC" entry at the current SCORE_VERSION', () => {
    const ts = readFileSync(REAL_CONSTANTS, 'utf8');
    expect(ts).not.toContain('PROVISIONAL');
    expect(ts).toContain(`FROZEN (M8) for SCORE_VERSION ${SCORE_VERSION}`);
    const list = JSON.parse(readFileSync(REAL_REFERENCES, 'utf8')) as Array<{
      name: string;
      scoreVersion: number;
      points: Record<string, number>;
    }>;
    expect(list).toHaveLength(1);
    const e = list[0]!;
    expect(e.name).toBe('Owner PC');
    expect(e.scoreVersion).toBe(SCORE_VERSION);
    expect(Object.keys(e.points).sort()).toEqual(['cpu-multi', 'cpu-single', 'gpu', 'memory', 'storage', 'total']);
    // Rounding the constants to 3 digits moves the reference's own points by a hair around 1000.
    for (const [id, p] of Object.entries(e.points)) expect(Math.abs(p - 1000), id).toBeLessThanOrEqual(2);
  });
});
