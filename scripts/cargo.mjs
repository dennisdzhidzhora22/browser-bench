// Runs cargo inside kernels/ so kernels/.cargo/config.toml (wasm target and
// simd128 flag) applies. Finds cargo even when ~/.cargo/bin is not on PATH yet,
// which happens in shells started before rustup was installed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const kernelsDir = join(root, 'kernels');

function cargoCandidates() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const homes = [process.env.CARGO_HOME, join(homedir(), '.cargo')].filter(Boolean);
  return ['cargo', ...homes.map((h) => join(h, 'bin', exe)).filter((p) => existsSync(p))];
}

/** Runs `cargo <args>` in kernels/. Exits the process on failure. */
export function cargo(args) {
  // A RUSTFLAGS variable would replace config.toml's rustflags and drop +simd128.
  const env = { ...process.env };
  delete env.RUSTFLAGS;

  for (const bin of cargoCandidates()) {
    const r = spawnSync(bin, args, { cwd: kernelsDir, stdio: 'inherit', env });
    if (r.error && r.error.code === 'ENOENT') continue;
    if (r.error) {
      console.error(`could not start cargo: ${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) process.exit(r.status ?? 1);
    return;
  }
  console.error('cargo not found. Install Rust (rustup) or add ~/.cargo/bin to PATH.');
  process.exit(1);
}
