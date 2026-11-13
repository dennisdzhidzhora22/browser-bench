// Enforces the JS + CSS budget (docs/SPEC.md, section 7): 50 kB gzipped in
// total, .wasm excluded. Run after `vite build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 50 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let files;
try {
  files = walk(dist).filter((f) => ['.js', '.css', '.html'].includes(extname(f)));
} catch {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(f), { level: 9 }).length;
  total += gz;
  console.log(`${(gz / 1024).toFixed(2).padStart(8)} kB  ${relative(dist, f)}`);
}
console.log(`${(total / 1024).toFixed(2).padStart(8)} kB  total (budget ${BUDGET_BYTES / 1024} kB)`);
if (total > BUDGET_BYTES) {
  console.error('Over budget.');
  process.exit(1);
}
