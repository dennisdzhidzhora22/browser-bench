// Builds the Rust kernels to wasm and copies the module to src/generated/.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cargo, kernelsDir, root } from './cargo.mjs';

cargo(['build', '--release']);

const built = join(kernelsDir, 'target', 'wasm32-unknown-unknown', 'release', 'kernels.wasm');
const outDir = join(root, 'src', 'generated');
mkdirSync(outDir, { recursive: true });
copyFileSync(built, join(outDir, 'kernels.wasm'));
console.log(`kernels.wasm: ${statSync(built).size} bytes`);
