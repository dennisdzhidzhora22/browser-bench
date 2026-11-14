import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The dev server (`npx vite`, 127.0.0.1:5173) is a different code path from the preview server
// the rest of the e2e suite uses (4173): it serves unbundled modules, a module worker and the
// .wasm through Vite's middleware. This proves COOP/COEP also cover the worker and the wasm
// there. The test owns the server: it starts it, waits for it, and kills the whole process tree.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WASM = fileURLToPath(new URL('../../src/generated/kernels.wasm', import.meta.url));
const ORIGIN = 'http://127.0.0.1:5173';
const IS_WIN = process.platform === 'win32';

let server: ChildProcess | undefined;
let log = '';
let exited = false;

function killTree(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) return;
  if (IS_WIN) {
    // /T = the whole tree (cmd -> npx -> node -> vite), /F = force.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function answers(): Promise<boolean> {
  try {
    const res = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2_000) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

test.describe('dev server (npx vite on 5173)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(WASM)) {
      const r = spawnSync('npm run build:wasm', { cwd: ROOT, shell: true, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`npm run build:wasm failed:\n${r.stdout}\n${r.stderr}`);
    }
    if (await answers()) throw new Error(`something already listens on ${ORIGIN}; refusing to reuse it`);
    // shell: true so `npx` resolves to npx.cmd on Windows. The tree is killed in afterAll.
    server = spawn('npx vite', {
      cwd: ROOT,
      shell: true,
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.stdout?.on('data', (b: Buffer) => (log += b.toString()));
    server.stderr?.on('data', (b: Buffer) => (log += b.toString()));
    server.on('exit', () => (exited = true));
    const deadline = Date.now() + 90_000;
    while (!(await answers())) {
      if (exited) throw new Error(`vite exited before answering:\n${log}`);
      if (Date.now() > deadline) throw new Error(`vite did not answer within 90 s:\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  test.afterAll(() => {
    killTree(server);
  });

  test('GET / carries COOP same-origin and COEP require-corp', async ({ request }) => {
    const res = await request.get(`${ORIGIN}/`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('page is cross-origin isolated, shows the dev banner, and a single-core smoke run is valid', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`${ORIGIN}/?smoke`);
    // Vite may reload once after pre-bundling dependencies on a cold start; wait for the final page.
    await expect(page.getByTestId('isolated')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.getByTestId('not-isolated')).toHaveCount(0);
    await expect(page.getByTestId('dev-banner')).toBeVisible();

    // Only CPU single-core is selected by default (smoke_spec asserts that on the preview build).
    await expect(page.getByTestId('component-cpu-single')).toBeChecked();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);

    const checks = page.getByTestId('checksum');
    expect(await checks.count()).toBeGreaterThan(0);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
    }
    expect(pageErrors).toEqual([]);
  });
});
