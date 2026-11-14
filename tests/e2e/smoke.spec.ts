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
    const memory = page.getByTestId('component-memory');
    await expect(memory).toBeEnabled();
    await expect(memory).not.toBeChecked();
    // cpu-multi became selectable in M2, memory in M3 and gpu in M4 (see 'M2 all cores', 'M3 memory'
    // below and gpu.spec.ts).
    const gpu = page.getByTestId('component-gpu');
    await expect(gpu).toBeEnabled();
    await expect(gpu).not.toBeChecked();
    const storage = page.getByTestId('component-storage');
    await expect(storage).toBeDisabled();
    await expect(storage).not.toBeChecked();
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

// ── M3: memory ────────────────────────────────────────────────────────────────

test.describe('M3 memory', () => {
  const DASH = '—';
  const KB = 1024;
  const MB = 1024 * KB;
  // Working-set sizes of the latency curve, in bytes (src/lib/bench/memory/index.ts): 17 points, 16 KB ... 256 MB.
  const LATENCY_SIZES = [
    16 * KB, 32 * KB, 64 * KB, 128 * KB, 256 * KB, 512 * KB, 1 * MB, 2 * MB, 4 * MB, 8 * MB,
    12 * MB, 16 * MB, 24 * MB, 32 * MB, 64 * MB, 128 * MB, 256 * MB,
  ];
  const MULTI_ROW = 'mem-row-mem_copy_mt-multi';
  // 2 bandwidth rows + 1 all-cores row + 17 latency rows.
  const MEMORY_CHECKS = 3 + LATENCY_SIZES.length;
  // Progress counts kernels: fill, copy, 17 latency points, then all-cores copy.
  const MEMORY_STEPS = 2 + LATENCY_SIZES.length + 1;

  async function onlyMemory(page: Page) {
    await page.getByTestId('component-memory').check();
    await page.getByTestId('component-cpu-single').uncheck();
  }

  /** Number of non-transparent pixels, plus the bitmap size, of the latency chart canvas. */
  async function chartPixels(page: Page) {
    return page.getByTestId('latency-chart').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted++;
      return { width: c.width, height: c.height, painted };
    });
  }

  test('memory is enabled and unchecked by default', async ({ page }) => {
    await page.goto('/?smoke');
    const memory = page.getByTestId('component-memory');
    await expect(memory).toBeEnabled();
    await expect(memory).not.toBeChecked();
    await expect(page.getByTestId('memory-results')).toHaveCount(0);
    await expect(page.getByTestId('latency-chart')).toHaveCount(0);
  });

  test('the worker count input shows when only Memory is selected', async ({ page }) => {
    await page.goto('/?smoke');
    const workers = page.getByTestId('workers');
    await expect(workers).toHaveCount(0);
    await onlyMemory(page);
    await expect(workers).toBeVisible();
    await expect(workers).toBeEnabled();
    const n = Number(await workers.inputValue());
    expect(Number.isInteger(n) && n >= 1).toBe(true);
    // One input, below the whole component list (not tucked under the cpu-multi line).
    const wbox = (await workers.boundingBox())!;
    for (const id of ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage']) {
      const box = (await page.getByTestId(`component-${id}`).boundingBox())!;
      expect(wbox.y, id).toBeGreaterThan(box.y);
    }
    // Still there, still one, with cpu-multi added, and gone only when neither needs it.
    await page.getByTestId('component-cpu-multi').check();
    await expect(workers).toBeVisible();
    await expect(page.getByTestId('workers')).toHaveCount(1);
    await page.getByTestId('component-memory').uncheck();
    await expect(workers).toBeVisible();
    await page.getByTestId('component-cpu-multi').uncheck();
    await expect(workers).toHaveCount(0);
  });

  test('a worker count of 0 disables Run while Memory is checked', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMemory(page);
    const workers = page.getByTestId('workers');
    await workers.fill('0');
    await expect(page.getByTestId('run')).toBeDisabled();
    await workers.fill('');
    await expect(page.getByTestId('run')).toBeDisabled();
    await workers.fill('2');
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('smoke run of Memory only: all rows, 17 latency rows, valid checksums, a drawn chart', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMemory(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();

    // Only the memory table: no CPU tables.
    await expect(page.getByTestId('memory-results')).toBeVisible();
    await expect(page.getByTestId('results')).toHaveCount(0);
    await expect(page.getByTestId('multi-results')).toHaveCount(0);

    // Bandwidth rows: fill and copy single-core, copy all-cores, in that order.
    await expect(page.getByTestId('mem-row-mem_fill')).toHaveCount(1);
    await expect(page.getByTestId('mem-row-mem_copy')).toHaveCount(1);
    await expect(page.getByTestId(MULTI_ROW)).toHaveCount(1);
    const memRows = await page
      .locator('[data-testid^="mem-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(memRows).toEqual(['mem-row-mem_fill', 'mem-row-mem_copy', MULTI_ROW]);
    await expect(page.getByTestId('mem-row-mem_fill')).toContainText('1 core');
    await expect(page.getByTestId('mem-row-mem_copy')).toContainText('counted once');
    await expect(page.getByTestId(MULTI_ROW)).toContainText('2 workers');
    await expect(page.getByTestId(MULTI_ROW)).toContainText('counted once');
    // Fewer than 8 workers: the row warns that the total may fit in cache.
    await expect(page.getByTestId(MULTI_ROW)).toContainText('few workers');

    // 17 latency rows, one per size, ascending (12 MB and 24 MB included).
    const latencyRows = await page
      .locator('[data-testid^="latency-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(latencyRows).toEqual(LATENCY_SIZES.map((s) => `latency-row-${s}`));
    await expect(page.getByTestId('latency-row-16384')).toContainText('16 KB');
    await expect(page.getByTestId('latency-row-12582912')).toContainText('12 MB');
    await expect(page.getByTestId('latency-row-25165824')).toContainText('24 MB');
    // A smoke run measures 4 KB at every point; the labels say so.
    for (const s of LATENCY_SIZES) await expect(page.getByTestId(`latency-row-${s}`), String(s)).toContainText('smoke run: 4 KB');
    await expect(page.getByTestId('latency-row-268435456')).toContainText('256 MB');

    // Every checksum cell is valid and ok.
    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(MEMORY_CHECKS);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
      await expect(cell).toHaveText(/^(ok|noisy)$/);
    }
    // Per section too, so a missing section cannot hide behind another's cells.
    for (const id of ['mem-row-mem_fill', 'mem-row-mem_copy', MULTI_ROW]) {
      await expect(page.getByTestId(id).getByTestId('checksum'), id).toHaveAttribute('data-valid', 'true');
    }
    for (const s of LATENCY_SIZES) {
      await expect(page.getByTestId(`latency-row-${s}`).getByTestId('checksum'), String(s)).toHaveAttribute(
        'data-valid',
        'true',
      );
    }

    // Structure only (never speed): a number, or a dash when a smoke run is below timer resolution.
    const values = page.getByTestId('value');
    await expect(values).toHaveCount(MEMORY_CHECKS);
    for (const v of await values.all()) {
      await expect(v).toHaveText(new RegExp(`^(\\d+(\\.\\d+)?|${DASH})$`));
    }

    // The chart: a canvas with a real bitmap that has something drawn on it (axes at least).
    await expect(page.getByTestId('latency-chart')).toBeVisible();
    const { width, height, painted } = await chartPixels(page);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(painted).toBeGreaterThan(100);
  });

  test('a second Memory run replaces the results instead of appending', async ({ page }) => {
    await page.goto('/?smoke');
    await onlyMemory(page);
    await page.getByTestId('workers').fill('2');
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('run').click();
      await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    }
    await expect(page.getByTestId('checksum')).toHaveCount(MEMORY_CHECKS);
    await expect(page.locator('[data-testid^="latency-row-"]')).toHaveCount(LATENCY_SIZES.length);
    await expect(page.getByTestId('latency-chart')).toHaveCount(1);
  });

  test('a hidden tab marks every memory row hidden and invalid; the chart is still there', async ({ page }) => {
    await page.goto('/?smoke');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    await onlyMemory(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(MEMORY_CHECKS);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true'); // the maths was right...
      await expect(cell).toHaveAttribute('data-valid', 'false'); // ...but the timing is discarded
      await expect(cell).toHaveText('hidden');
    }
    for (const v of await page.getByTestId('value').all()) await expect(v).toHaveText(DASH);
    await expect(page.getByTestId('latency-chart')).toBeVisible();
  });

  test('all three components together: all three tables', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-multi').check();
    await page.getByTestId('component-memory').check();
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 300_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('results')).toBeVisible();
    await expect(page.getByTestId('multi-results')).toBeVisible();
    await expect(page.getByTestId('memory-results')).toBeVisible();
    await expect(page.locator('[data-testid^="row-"]')).toHaveCount(CPU_KERNELS.length);
    await expect(page.locator('[data-testid^="multi-row-"]')).toHaveCount(CPU_KERNELS.length);
    await expect(page.locator('[data-testid^="mem-row-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="latency-row-"]')).toHaveCount(LATENCY_SIZES.length);
    await expect(page.getByTestId('latency-chart')).toBeVisible();

    const checks = page.getByTestId('checksum');
    await expect(checks).toHaveCount(CPU_KERNELS.length * 2 + MEMORY_CHECKS);
    for (const cell of await checks.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'true');
    }
  });

  test('Memory is not run when it is unchecked (CPU-only run has no memory table)', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('memory-results')).toHaveCount(0);
    await expect(page.getByTestId('latency-chart')).toHaveCount(0);
  });

  test('cancel during a standard-size memory run', async ({ page }) => {
    // Standard sizes: the first kernel (128 MB fill x 40 passes) alone runs for seconds.
    await page.goto('/');
    await onlyMemory(page);
    await page.getByTestId('workers').fill('2');
    await page.getByTestId('run').click();
    const cancel = page.getByTestId('cancel');
    await expect(cancel).toBeVisible();
    await expect(page.getByTestId('progress')).toContainText(`1 / ${MEMORY_STEPS}`);
    await expect(page.getByTestId('run')).toHaveCount(0);
    // Let the first kernel get past prepare and into its timed runs.
    await page.waitForTimeout(1_500);
    await expect(cancel).toBeVisible();

    await cancel.click();

    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
    // It never finished, so it must not show every memory row as done.
    await expect(page.getByTestId('checksum')).not.toHaveCount(MEMORY_CHECKS);
    // The controls are usable again.
    await expect(page.getByTestId('workers')).toBeEnabled();
    await expect(page.getByTestId('component-memory')).toBeEnabled();
  });

  test('can run again after cancelling a memory run', async ({ page }) => {
    await page.goto('/');
    await onlyMemory(page);
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

  test('every network request is same-origin during a memory run', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await page.goto('/?smoke');
    await onlyMemory(page);
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
