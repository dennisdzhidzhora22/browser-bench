// scripts/check-size.mjs, run as a child process against synthetic dist folders. The script finds dist/ relative to
// its own location, so each case copies it into <tmp>/scripts/ and builds <tmp>/dist/. Only sizes of made-up files are
// involved; nothing here asserts on speed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-size.mjs');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Incompressible text of about `n` bytes (base64 of random bytes: gzip keeps about 3/4 of it). */
const noise = (n: number) => randomBytes(Math.ceil((n * 3) / 4)).toString('base64');

const HTML = (head: string) => `<!doctype html><html><head>${head}</head><body><div id="app"></div></body></html>`;
const SCRIPT_TAG = '<script type="module" crossorigin src="/assets/index.js"></script>';

/** Builds <tmp>/dist from `files` (paths under dist/), runs the copied script, returns its result. */
function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'bb-size-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'check-size.mjs'));
  for (const [name, text] of Object.entries(files)) {
    const f = join(root, 'dist', name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-size.mjs')], { cwd: root, encoding: 'utf8' });
  expect(r.error).toBeUndefined();
  return { code: r.status, out: r.stdout, err: r.stderr.replaceAll('\\', '/') }; // messages use the OS separator
}

/** The part of the output after "Page load:" and before "Loaded lazily". */
const pageSection = (out: string) => out.slice(out.indexOf('Page load:'), out.indexOf('Loaded lazily'));
const lazySection = (out: string) => out.slice(out.indexOf('Loaded lazily'));

describe('check-size.mjs', () => {
  it('a normal build passes: page-load chunks and the css counted, the worker listed as lazy', () => {
    const r = run({
      'index.html': HTML(`${SCRIPT_TAG}<link rel="stylesheet" href="/assets/index.css">`),
      'assets/index.js': 'import{a}from"./dep.js";console.log(a,new Worker(new URL("w.js",import.meta.url)),import("./lazy.js"));',
      'assets/dep.js': 'export const a=1;',
      'assets/index.css': 'body{margin:0}',
      'assets/w.js': 'self.onmessage=()=>{};',
      'assets/lazy.js': 'export default 2;',
    });
    expect(r.code, r.err).toBe(0);
    const page = pageSection(r.out);
    for (const f of ['index.html', 'assets/index.js', 'assets/dep.js', 'assets/index.css']) expect(page).toContain(f);
    expect(page).not.toContain('assets/w.js');
    expect(page).not.toContain('assets/lazy.js'); // dynamic import and new Worker are lazy
    expect(lazySection(r.out)).toContain('assets/w.js');
    expect(lazySection(r.out)).toContain('assets/lazy.js');
    expect(r.out).not.toContain('OVER CAP');
  });

  it('a static import written right after a banner comment (no space, no semicolon) counts as page load', () => {
    const r = run({
      'index.html': HTML(SCRIPT_TAG),
      'assets/index.js': '/*! banner */import{a}from"./dep.js";console.log(a);',
      'assets/dep.js': 'export const a=1;',
    });
    expect(r.code, r.err).toBe(0);
    expect(pageSection(r.out)).toContain('assets/dep.js');
    expect(lazySection(r.out)).not.toContain('assets/dep.js');
  });

  it.each([
    ['after a semicolon', ';import"./dep.js";'],
    ['after a brace', '{}import{a}from"./dep.js";'],
    ['after a newline', 'x=1\nimport{a}from"./dep.js";'],
    ['a re-export', 'export*from"./dep.js";'],
    ['a named re-export', 'export{a}from"./dep.js";'],
  ])('a static import %s counts as page load', (_n, code) => {
    const r = run({ 'index.html': HTML(SCRIPT_TAG), 'assets/index.js': code, 'assets/dep.js': 'export const a=1;' });
    expect(r.code, r.err).toBe(0);
    expect(pageSection(r.out)).toContain('assets/dep.js');
  });

  it('a dynamic import or a property named import is not a static import', () => {
    const r = run({
      'index.html': HTML(SCRIPT_TAG),
      'assets/index.js': 'const m=import("./lazy.js");o.import"./other.js";',
      'assets/lazy.js': 'export default 1;',
      'assets/other.js': 'export default 2;',
    });
    expect(r.code, r.err).toBe(0);
    expect(pageSection(r.out)).not.toMatch(/lazy\.js|other\.js/);
  });

  it('a script that index.html references but dist lacks fails with a message naming it', () => {
    const r = run({ 'index.html': HTML(SCRIPT_TAG) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('assets/index.js');
    expect(r.err).toContain('does not exist');
  });

  it('a stylesheet that index.html references but dist lacks fails', () => {
    const r = run({
      'index.html': HTML(`${SCRIPT_TAG}<link rel="stylesheet" href="/assets/gone.css">`),
      'assets/index.js': 'console.log(1);',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('assets/gone.css');
  });

  it('a static import of a file that is not there fails, naming the importer and the file', () => {
    const r = run({ 'index.html': HTML(SCRIPT_TAG), 'assets/index.js': 'import{a}from"./missing.js";console.log(a);' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('assets/index.js');
    expect(r.err).toContain('assets/missing.js');
  });

  it('a missing file imported by a chunk that is itself imported (two levels) fails too', () => {
    const r = run({
      'index.html': HTML(SCRIPT_TAG),
      'assets/index.js': 'import"./a.js";',
      'assets/a.js': '/*! x */import"./b.js";',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('assets/b.js');
  });

  it('an index.html that references no script fails (nothing to measure)', () => {
    const r = run({ 'index.html': HTML('<link rel="stylesheet" href="/assets/index.css">'), 'assets/index.css': 'body{}' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('references no script');
  });

  it('external and data: URLs in index.html are ignored, not looked up', () => {
    const r = run({
      'index.html': HTML(`${SCRIPT_TAG}<link rel="icon" href="data:,"><script src="https://example.com/x.js"></script>`),
      'assets/index.js': 'console.log(1);',
    });
    expect(r.code, r.err).toBe(0);
  });

  it('a lazy chunk over 20 kB gzipped fails and is marked OVER CAP; a small one beside it is not', () => {
    const r = run({
      'index.html': HTML(SCRIPT_TAG),
      'assets/index.js': 'console.log(1);',
      'assets/worker-big.js': `const d="${noise(30 * 1024)}";`,
      'assets/worker-small.js': 'self.onmessage=()=>{};',
    });
    expect(r.code).toBe(1);
    const lines = lazySection(r.out).split('\n');
    expect(lines.find((l) => l.includes('worker-big.js'))).toContain('OVER CAP');
    expect(lines.find((l) => l.includes('worker-small.js'))).not.toContain('OVER CAP');
  });

  it('a lazy chunk well under 20 kB passes', () => {
    const r = run({ 'index.html': HTML(SCRIPT_TAG), 'assets/index.js': 'console.log(1);', 'assets/w.js': `const d="${noise(8 * 1024)}";` });
    expect(r.code, r.err).toBe(0);
  });

  it('a page load over 50 kB gzipped fails', () => {
    const r = run({ 'index.html': HTML(SCRIPT_TAG), 'assets/index.js': `const d="${noise(80 * 1024)}";` });
    expect(r.code).toBe(1);
    expect(r.err).toContain('over budget');
  });

  it('a big chunk reached only through a static import counts against the page budget', () => {
    const r = run({
      'index.html': HTML(SCRIPT_TAG),
      'assets/index.js': '/*! banner */import"./big.js";',
      'assets/big.js': `const d="${noise(80 * 1024)}";`,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('over budget');
    expect(lazySection(r.out)).not.toContain('big.js');
  });

  it('no dist/index.html at all fails with a hint', () => {
    const r = run({});
    expect(r.code).toBe(1);
    expect(r.err).toContain('npm run build');
  });
});
