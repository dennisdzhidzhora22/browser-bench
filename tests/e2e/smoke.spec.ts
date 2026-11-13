import { expect, test } from '@playwright/test';

// Ids of the CPU single-core kernels, in run order (src/lib/bench/cpu/index.ts).
const CPU_KERNELS = [
  'sha256',
  'lz',
  'sort_u32',
  'sort_f64',
  'nbody',
  'mandelbrot',
  'mandelbrot_simd',
  'matmul',
  'matmul_simd',
  'fft',
  'trace',
];

test.describe('M1 smoke', () => {
  test('page is cross-origin isolated', async ({ page }) => {
    await page.goto('/?smoke');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.getByTestId('isolated')).toBeVisible();
    await expect(page.getByTestId('not-isolated')).toHaveCount(0);
  });

  test('document is served with COOP and COEP headers', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    const headers = response!.headers();
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('production build shows no dev banner', async ({ page }) => {
    await page.goto('/?smoke');
    await expect(page.getByTestId('isolated')).toBeVisible();
    await expect(page.getByTestId('dev-banner')).toHaveCount(0);
  });

  test('?smoke is announced in the isolation line; plain URL is not', async ({ page }) => {
    await page.goto('/?smoke');
    await expect(page.getByTestId('isolated')).toContainText('smoke sizes');
    await page.goto('/');
    await expect(page.getByTestId('isolated')).not.toContainText('smoke sizes');
  });

  test('CPU single-core is selected by default and the other components are disabled', async ({ page }) => {
    await page.goto('/?smoke');
    const cpu = page.getByTestId('component-cpu-single');
    await expect(cpu).toBeChecked();
    await expect(cpu).toBeEnabled();
    for (const id of ['cpu-multi', 'memory', 'gpu', 'storage']) {
      const box = page.getByTestId(`component-${id}`);
      await expect(box, id).toBeDisabled();
      await expect(box, id).not.toBeChecked();
    }
    await expect(page.getByTestId('mode-quick')).toBeChecked();
    await expect(page.getByTestId('mode-full')).not.toBeChecked();
    await expect(page.getByTestId('run')).toBeEnabled();
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('results')).toHaveCount(0);
    await expect(page.getByTestId('status')).toHaveCount(0);
  });

  test('Run is disabled when nothing is selected', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-single').uncheck();
    await expect(page.getByTestId('run')).toBeDisabled();
    await page.getByTestId('component-cpu-single').check();
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('smoke run completes with one valid row per CPU kernel', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('run').click();

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();

    await expect(page.getByTestId('results')).toBeVisible();
    for (const id of CPU_KERNELS) {
      await expect(page.getByTestId(`row-${id}`), id).toHaveCount(1);
    }
    // Rows are in run order, exactly one per kernel.
    const rowIds = await page
      .locator('[data-testid^="row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(rowIds).toEqual(CPU_KERNELS.map((id) => `row-${id}`));

    const checksums = page.getByTestId('checksum');
    await expect(checksums).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checksums.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveText('ok');
    }

    // Structure only (never speed): every valid row shows a number.
    const values = page.getByTestId('value');
    await expect(values).toHaveCount(CPU_KERNELS.length);
    for (const v of await values.all()) {
      await expect(v).toHaveText(/^\d+(\.\d+)?$/);
    }
  });

  test('Full mode also completes on smoke sizes', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('mode-full').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    const checksums = page.getByTestId('checksum');
    await expect(checksums).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checksums.all()) await expect(cell).toHaveAttribute('data-ok', 'true');
  });

  test('a second run replaces the results instead of appending', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('checksum')).toHaveCount(CPU_KERNELS.length);
  });

  test('cancel stops a standard-size run', async ({ page }) => {
    // Standard sizes: the first kernel alone runs for many seconds, so the run is
    // guaranteed to still be in flight when Cancel is clicked.
    await page.goto('/');
    await page.getByTestId('run').click();
    const cancel = page.getByTestId('cancel');
    await expect(cancel).toBeVisible();
    await expect(page.getByTestId('progress')).toContainText(`1 / ${CPU_KERNELS.length}`);
    await expect(page.getByTestId('run')).toHaveCount(0);

    await cancel.click();

    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
    // The run never finished, so it must not report every kernel as done.
    await expect(page.getByTestId('checksum')).not.toHaveCount(CPU_KERNELS.length);
  });

  test('can run again after a cancel', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('run').click();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    // Same page, plain URL is standard size; just prove the UI is back to idle and Run starts again.
    await page.getByTestId('run').click();
    await expect(page.getByTestId('cancel')).toBeVisible();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
  });

  test('every network request is same-origin', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));

    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    for (const cell of await page.getByTestId('checksum').all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
    }

    expect(urls.length).toBeGreaterThan(0);
    const external = urls.filter((u) => {
      // data: and blob: URLs never leave the browser (e.g. worker bootstrap).
      if (u.startsWith('data:') || u.startsWith('blob:')) return false;
      return new URL(u).origin !== origin;
    });
    expect(external).toEqual([]);
  });
});
