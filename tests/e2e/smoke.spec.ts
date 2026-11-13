import { expect, test, type Page } from '@playwright/test';

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

  test('CPU single-core is selected by default; unbuilt components are disabled', async ({ page }) => {
    await page.goto('/?smoke');
    const cpu = page.getByTestId('component-cpu-single');
    await expect(cpu).toBeChecked();
    await expect(cpu).toBeEnabled();
    // cpu-multi became selectable in M2 (see 'M2 all cores' below).
    for (const id of ['memory', 'gpu', 'storage']) {
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
      await expect(cell).toHaveAttribute('data-valid', 'true');
      // noisy is machine-dependent (still valid), so accept either label.
      await expect(cell).toHaveText(/^(ok|noisy)$/);
    }

    // Structure only (never speed): a valid row shows a number. A smoke kernel can finish below
    // timer resolution (median 0 ms), in which case there is no throughput and the cell is a dash.
    const values = page.getByTestId('value');
    await expect(values).toHaveCount(CPU_KERNELS.length);
    for (const v of await values.all()) {
      await expect(v).toHaveText(/^(\d+(\.\d+)?|—)$/);
    }
  });

  test('a run in a hidden tab marks every row hidden and invalid', async ({ page }) => {
    await page.goto('/?smoke');
    // The page reads document.hidden when each kernel starts and ends. Override it before
    // the run so the result does not depend on timing.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });

    const checksums = page.getByTestId('checksum');
    await expect(checksums).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checksums.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true'); // the maths was right...
      await expect(cell).toHaveAttribute('data-valid', 'false'); // ...but the timing is discarded
      await expect(cell).toHaveText('hidden');
    }
    for (const v of await page.getByTestId('value').all()) await expect(v).toHaveText('—');
  });

  test('Full mode also completes on smoke sizes', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('mode-full').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    const checksums = page.getByTestId('checksum');
    await expect(checksums).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checksums.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
    }
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

// ── M2: CPU all cores ─────────────────────────────────────────────────────────

test.describe('M2 all cores', () => {
  const DASH = '—';

  async function onlyMulti(page: Page) {
    await page.getByTestId('component-cpu-multi').check();
    await page.getByTestId('component-cpu-single').uncheck();
  }

  test('cpu-multi is enabled and unchecked by default', async ({ page }) => {
    await page.goto('/?smoke');
    const multi = page.getByTestId('component-cpu-multi');
    await expect(multi).toBeEnabled();
    await expect(multi).not.toBeChecked();
  });

  test('the worker count input shows only while cpu-multi is checked', async ({ page }) => {
    await page.goto('/?smoke');
    const workers = page.getByTestId('workers');
    await expect(workers).toHaveCount(0);
    await page.getByTestId('component-cpu-multi').check();
    await expect(workers).toBeVisible();
    await expect(workers).toBeEnabled();
    const n = Number(await workers.inputValue());
    expect(Number.isInteger(n) && n >= 1).toBe(true);
    await page.getByTestId('component-cpu-multi').uncheck();
    await expect(workers).toHaveCount(0);
  });

  test('an empty or zero worker count disables Run', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMulti(page);
    const workers = page.getByTestId('workers');
    await workers.fill('0');
    await expect(page.getByTestId('run')).toBeDisabled();
    await workers.fill('');
    await expect(page.getByTestId('run')).toBeDisabled();
    await workers.fill('2');
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('a typed worker count of 2.5 becomes 2 on blur', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    const workers = page.getByTestId('workers');
    await workers.fill('2.5');
    await expect(page.getByTestId('run')).toBeEnabled(); // usable as typed: it will run with 2
    await workers.blur();
    await expect(workers).toHaveValue('2');
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('a worker count above the cap is clamped to 2 x logical cores on blur', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    const max = (await page.evaluate(() => navigator.hardwareConcurrency || 1)) * 2;
    const workers = page.getByTestId('workers');
    await workers.fill('99999');
    await workers.blur();
    await expect(workers).toHaveValue(String(max));
  });

  test('a worker count of 0 disables Run while cpu-multi is checked, not otherwise', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    const workers = page.getByTestId('workers');
    await workers.fill('0');
    await workers.blur();
    await expect(page.getByTestId('run')).toBeDisabled();
    await workers.fill('-3');
    await workers.blur();
    await expect(page.getByTestId('run')).toBeDisabled();
    // Unchecking cpu-multi hides the input and the count no longer matters.
    await page.getByTestId('component-cpu-multi').uncheck();
    await expect(page.getByTestId('run')).toBeEnabled();
    // The bad count is still there when cpu-multi comes back.
    await page.getByTestId('component-cpu-multi').check();
    await expect(page.getByTestId('run')).toBeDisabled();
    await page.getByTestId('workers').fill('1');
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('a run with a typed 2.5 uses 2 workers', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('workers').fill('2.5'); // no blur: the run itself must truncate
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    await expect(page.getByTestId('multi-row-sha256')).toContainText('2 workers');
    await expect(page.getByTestId('multi-row-sha256')).not.toContainText('2.5');
  });

  test('smoke run of cpu-multi with 2 workers: 11 valid rows and no single-core table', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();

    await expect(page.getByTestId('multi-results')).toBeVisible();
    await expect(page.getByTestId('results')).toHaveCount(0);
    for (const id of CPU_KERNELS) {
      await expect(page.getByTestId(`multi-row-${id}`), id).toHaveCount(1);
    }
    const rowIds = await page
      .locator('[data-testid^="multi-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(rowIds).toEqual(CPU_KERNELS.map((id) => `multi-row-${id}`));

    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
      await expect(cell).toHaveText(/^(ok|noisy)$/);
    }

    // Structure only: a number, or a dash when a smoke window is below timer resolution.
    const values = page.getByTestId('value');
    await expect(values).toHaveCount(CPU_KERNELS.length);
    for (const v of await values.all()) {
      await expect(v).toHaveText(new RegExp(`^(\\d+(\\.\\d+)?|${DASH})$`));
    }
    const scalings = page.getByTestId('scaling');
    await expect(scalings).toHaveCount(CPU_KERNELS.length);
    for (const s of await scalings.all()) {
      await expect(s).toHaveText(new RegExp(`^(\\d+\\.\\d{2}×|${DASH})$`));
    }

    // Each row names the worker count it used.
    for (const id of CPU_KERNELS) {
      await expect(page.getByTestId(`multi-row-${id}`)).toContainText('2 workers');
    }
  });

  test('both components selected: both tables appear', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 180_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('results')).toBeVisible();
    await expect(page.getByTestId('multi-results')).toBeVisible();
    await expect(page.locator('[data-testid^="row-"]')).toHaveCount(CPU_KERNELS.length);
    await expect(page.locator('[data-testid^="multi-row-"]')).toHaveCount(CPU_KERNELS.length);
    // 11 single-core + 11 all-cores checksum cells, all valid.
    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(CPU_KERNELS.length * 2);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
    }
  });

  test('a single worker is allowed', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('1');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checks.all()) await expect(cell).toHaveAttribute('data-valid', 'true');
  });

  test('a second all-cores run replaces the results instead of appending', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('run').click();
      await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    }
    await expect(page.getByTestId('checksum')).toHaveCount(CPU_KERNELS.length);
  });

  test('a hidden tab marks every all-cores row hidden and invalid', async ({ page }) => {
    await page.goto('/?smoke');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(CPU_KERNELS.length);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'false');
      await expect(cell).toHaveText('hidden');
    }
    for (const v of await page.getByTestId('value').all()) await expect(v).toHaveText(DASH);
  });

  test('cancel during an all-cores run at standard size', async ({ page }) => {
    await page.goto('/');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    const cancel = page.getByTestId('cancel');
    await expect(cancel).toBeVisible();
    await expect(page.getByTestId('progress')).toContainText(`1 / ${CPU_KERNELS.length}`);
    await expect(page.getByTestId('run')).toHaveCount(0);
    // Let the workers get past init and into a kernel before cancelling.
    await page.waitForTimeout(1_500);
    await expect(cancel).toBeVisible();

    await cancel.click();

    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
    await expect(page.getByTestId('checksum')).not.toHaveCount(CPU_KERNELS.length);
    // The controls are usable again.
    await expect(page.getByTestId('workers')).toBeEnabled();
    await expect(page.getByTestId('component-cpu-multi')).toBeEnabled();
  });

  test('can run again after cancelling an all-cores run', async ({ page }) => {
    await page.goto('/');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('cancel')).toBeVisible();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('every network request is same-origin during an all-cores run', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await page.goto('/?smoke');
    await onlyMulti(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    const external = urls.filter((u) => {
      if (u.startsWith('data:') || u.startsWith('blob:')) return false;
      return new URL(u).origin !== origin;
    });
    expect(external).toEqual([]);
  });
});
