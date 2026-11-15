// Enforces the JS + CSS budget (docs/SPEC.md, section 7), gzipped, .wasm
// excluded. Run after `vite build`.
//
// - Page load: dist/index.html, the scripts and stylesheets it references,
//   and every chunk those import statically. 50 kB in total.
// - Everything else (the lazily loaded worker chunks) is listed separately,
//   with a cap of 20 kB per chunk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PAGE_BUDGET_BYTES = 50 * 1024;
const WORKER_CAP_BYTES = 20 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const html = join(dist, 'index.html');

if (!existsSync(html)) {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** A URL from the built files, as a path under dist/. */
const local = (from, url) => resolve(url.startsWith('/') ? dist : dirname(from), url.replace(/^\//, ''));

// Page-load set: index.html's <script src> and <link href> (stylesheet,
// modulepreload), then static `import ... from "x"` / `import "x"` in those
// chunks, recursively. Dynamic `import("x")` and `new Worker(...)` are lazy.
const page = new Set([html]);
const queue = [];
// A referenced file that is missing means this script resolved a path wrong
// (e.g. a non-root `base`); fail instead of silently counting less.
const need = (f, from) => {
  if (existsSync(f)) return f;
  console.error(`${relative(dist, from)} references ${relative(dist, f)}, which does not exist.`);
  process.exit(1);
};
for (const m of readFileSync(html, 'utf8').matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
  const url = m[1];
  if (/^(data:|https?:)/.test(url)) continue;
  const f = local(html, url);
  if (['.js', '.css'].includes(extname(f))) queue.push(need(f, html));
}
if (!queue.some((f) => extname(f) === '.js')) {
  console.error('dist/index.html references no script; cannot find the page-load set.');
  process.exit(1);
}
while (queue.length) {
  const f = queue.pop();
  if (page.has(f)) continue;
  page.add(f);
  if (extname(f) !== '.js') continue;
  const code = readFileSync(f, 'utf8');
  // Any non-identifier character may precede the keyword (`;`, `}`, a comment's `/`, ...).
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+\.js)["']/g)) {
    queue.push(need(local(f, m[1]), f));
  }
}

const rel = (f) => relative(dist, f).split(sep).join('/');
const gz = (f) => gzipSync(readFileSync(f), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(2).padStart(8)} kB`;
let failed = false;

let total = 0;
console.log('Page load:');
for (const f of page) {
  const n = gz(f);
  total += n;
  console.log(`${kb(n)}  ${rel(f)}`);
}
console.log(`${kb(total)}  page-load total (budget ${PAGE_BUDGET_BYTES / 1024} kB)`);
if (total > PAGE_BUDGET_BYTES) {
  console.error('Page load is over budget.');
  failed = true;
}

const lazy = walk(dist).filter((f) => ['.js', '.css'].includes(extname(f)) && !page.has(f));
console.log(`Loaded lazily (cap ${WORKER_CAP_BYTES / 1024} kB each):`);
for (const f of lazy) {
  const n = gz(f);
  const over = n > WORKER_CAP_BYTES;
  console.log(`${kb(n)}  ${rel(f)}${over ? '  OVER CAP' : ''}`);
  if (over) failed = true;
}
if (failed) process.exit(1);
