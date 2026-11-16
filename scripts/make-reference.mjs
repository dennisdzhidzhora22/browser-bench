// Turns one exported run into the first reference entry (docs/SPEC.md, section 6, "References").
//
//   node scripts/make-reference.mjs <export.json> [<run id> | latest] [--name "Owner PC"] [--freeze]
//
// - Picks the run by id, or with "latest" (the default) the newest Full standard-size Benchmark run.
// - Refuses runs that are smoke size, not Full, Endurance, from another scoreVersion, or that have
//   a component missing, partial or without points (fallback GPU, scaled storage, worker count not
//   the core count), or any kernel that is invalid, hidden or failed its output check.
// - --freeze first rewrites the constants in src/lib/scoring/constants.ts from this run (3 significant
//   digits, SCORE_VERSION unchanged, "provisional" comments replaced). Only the owner runs this.
// - Writes (or replaces, by name) the entry in src/lib/scoring/references.json: name, scoreVersion,
//   per-key results, and points recomputed by the app's own scoring code (loaded through Vite, as the
//   unit tests do) against the constants as they are after the optional freeze.
//
// Note: a Benchmark run's "window lost focus" note is not saved in the record (SPEC 4), so it cannot
// be checked here: export a run during which the window stayed in front.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS_TS = join(root, 'src/lib/scoring/constants.ts');
const REFERENCES = join(root, 'src/lib/scoring/references.json');
const COMPONENTS = ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'];

function fail(msg) {
  console.error(`make-reference: ${msg}`);
  process.exit(1);
}

// Arguments.
const args = process.argv.slice(2);
let name = 'Owner PC';
let freeze = false;
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--freeze') freeze = true;
  else if (args[i] === '--name') name = args[++i] ?? fail('--name needs a value');
  else if (args[i].startsWith('--')) fail(`unknown option ${args[i]}`);
  else pos.push(args[i]);
}
const [file, which = 'latest'] = pos;
if (!file) fail('usage: node scripts/make-reference.mjs <export.json> [<run id> | latest] [--name "Owner PC"] [--freeze]');

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(`cannot read ${file}: ${e.message}`);
}
if (data?.format !== 'browser-bench' || !Array.isArray(data.runs)) fail(`${file} is not a browser-bench export`);

const scoreVersion = Number(/export const SCORE_VERSION = (\d+);/.exec(readFileSync(CONSTANTS_TS, 'utf8'))?.[1]);
if (!scoreVersion) fail('SCORE_VERSION not found in constants.ts');

// Pick the run.
const isFull = (r) => r.mode === 'full' && r.size === 'standard' && !r.endurance;
const run =
  which === 'latest'
    ? data.runs.filter(isFull).sort((a, b) => String(b.time).localeCompare(String(a.time)))[0]
    : data.runs.find((r) => r.id === which);
if (!run) fail(which === 'latest' ? 'no Full standard-size run in the file' : `no run with id ${which}`);

// Refuse anything that is not a clean, complete Full run.
const problems = [];
if (run.size !== 'standard') problems.push(`size is ${run.size} (smoke runs earn no points)`);
if (run.mode !== 'full') problems.push(`mode is ${run.mode}, not Full`);
if (run.endurance) problems.push('an Endurance run');
if (run.scoreVersion !== scoreVersion) problems.push(`scoreVersion ${run.scoreVersion}, this build is ${scoreVersion}`);
const comps = run.components ?? [];
/** The component that counts for `id` (GPU "Both": the Fast one), as lib/scoring/score.ts counted(). */
const counted = (id, list = comps) => {
  const all = list.filter((c) => c.id === id);
  return id === 'gpu' && all.length > 1 ? all.find((c) => c.gpu?.preference === 'high-performance') : all[0];
};
for (const id of COMPONENTS) {
  const c = counted(id);
  if (!c) {
    problems.push(`${id}: not run`);
    continue;
  }
  if (c.error) problems.push(`${id}: ${c.error}`);
  if (c.note) problems.push(`${id}: ${c.note}`);
  if (c.partial) problems.push(`${id}: partial`);
  if (c.points == null) problems.push(`${id}: no points`);
  for (const k of c.kernels ?? []) {
    if (!k.valid || k.value == null) problems.push(`${id}/${k.key}: invalid${k.error ? ` (${k.error})` : ''}`);
    if (k.hidden) problems.push(`${id}/${k.key}: tab was hidden`);
    if (k.checksumOk === false) problems.push(`${id}/${k.key}: output check failed`);
  }
}
// A missing kernel makes its component partial (SPEC 6): every constant needs a result.
const constantsTs = readFileSync(CONSTANTS_TS, 'utf8');
for (const m of constantsTs.matchAll(/^\s*'([\w-]+)\/([\w:]+)': [\d.e+-]+,$/gm)) {
  const k = counted(m[1])?.kernels?.find((x) => x.key === m[2]);
  if (counted(m[1]) && !k) problems.push(`${m[1]}/${m[2]}: missing (component partial)`);
}
if (problems.length) fail(`refusing run ${run.id} (${run.time}):\n  - ${problems.join('\n  - ')}`);

/** Every kernel result of the counted components, by `<component>/<defKey>`. */
const results = {};
for (const id of COMPONENTS) for (const k of counted(id).kernels) results[`${id}/${k.key}`] = k.value;

const sig3 = (x) => Number(x.toPrecision(3));

if (freeze) {
  let ts = readFileSync(CONSTANTS_TS, 'utf8');
  const missing = [];
  ts = ts.replace(/^(\s*)'([\w-]+\/[\w:]+)': [\d.e+-]+,$/gm, (line, indent, key) => {
    if (results[key] == null) {
      missing.push(key);
      return line;
    }
    return `${indent}'${key}': ${sig3(results[key])},`;
  });
  if (missing.length) fail(`the run has no result for constant(s): ${missing.join(', ')}; nothing written`);
  const s = run.system ?? {};
  const header =
    `// FROZEN (M8) for SCORE_VERSION ${scoreVersion}: medians of one Full standard-size run on the\n` +
    `// reference PC ("${name}"), rounded to 3 significant digits by scripts/make-reference.mjs.\n` +
    `// Run ${run.id}, ${run.time},\n` +
    `// ${s.browser ?? '?'} ${s.version ?? ''}, ${s.cores ?? '?'} logical cores.\n` +
    `// Do not edit by hand: any change to a constant, a kernel or its size bumps SCORE_VERSION.\n`;
  const start = ts.indexOf('// PROVISIONAL');
  const end = ts.indexOf('//\n// Memory:', start);
  if (start < 0 || end < 0) fail('constants.ts no longer has the PROVISIONAL comment block (already frozen?)');
  ts = ts.slice(0, start) + header + ts.slice(end);
  // Restored if anything below fails, so constants.ts and references.json never disagree.
  const before = readFileSync(CONSTANTS_TS, 'utf8');
  writeFileSync(CONSTANTS_TS, ts);
  process.on('exit', (code) => {
    if (code === 0) return;
    writeFileSync(CONSTANTS_TS, before);
    console.error('make-reference: constants.ts restored; references.json not written.');
  });
  console.log(`constants.ts: ${Object.keys(results).length} constants frozen from run ${run.id}; SCORE_VERSION stays ${scoreVersion}.`);
}

// Points by the app's own code, against the constants as they are now (after --freeze).
const { createServer } = await import('vite');
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  logLevel: 'silent',
});
let scored;
try {
  const { rescore } = await server.ssrLoadModule('/src/lib/scoring/score.ts');
  scored = rescore(run);
} finally {
  await server.close();
}
if (scored.total == null || scored.partial) fail('the rescored run is partial or has no total; nothing written to references.json');
const points = { total: scored.total };
for (const id of COMPONENTS) points[id] = counted(id, scored.components).points;

const refs = JSON.parse(readFileSync(REFERENCES, 'utf8'));
const entry = { name, scoreVersion, results, points };
const at = refs.findIndex((r) => r.name === name);
if (at >= 0) refs[at] = entry;
else refs.unshift(entry);
writeFileSync(REFERENCES, JSON.stringify(refs, null, 2) + '\n');
console.log(
  `references.json: ${at >= 0 ? 'replaced' : 'added'} "${name}" (score v${scoreVersion}) from run ${run.id} ` +
    `(${run.time}): ${Object.keys(results).length} results, total ${points.total} ` +
    `(${COMPONENTS.map((id) => `${id} ${points[id]}`).join(', ')}).`,
);
