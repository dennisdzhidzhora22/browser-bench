import { expect, test, type Page } from '@playwright/test';

// WebGL2 fallback (docs/SPEC.md, 3.4). This Chrome ignores --disable-webgpu (navigator.gpu stays and an
// adapter is still found), so the fallback is forced with --disable-gpu: navigator.gpu exists but
// requestAdapter() returns null, and WebGL2 runs in software. That is the same path planGpus takes when
// WebGPU is unusable. test.use({ launchOptions }) must be top-level, hence this separate file.
// Skipped, with the reason, if a build of Chrome still finds an adapter or has no WebGL2.

test.use({
  launchOptions: {
    args: [
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-gpu',
      '--disable-webgpu',
    ],
  },
});

const WEBGPU_ROWS = ['gpu_nbody', 'gpu_matmul', 'gpu_draws', 'gpu_fragment'];
const FALLBACK_ROW = 'gpu_fragment_gl';

async function hasAdapter(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      return !!navigator.gpu && !!(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  });
}

async function onlyGpu(page: Page): Promise<void> {
  await page.goto('/?smoke');
  await page.getByTestId('component-cpu-single').uncheck();
  await page.getByTestId('component-gpu').check();
}

/** Click Run and wait for Done, failing loudly on the page's own error line. */
async function runAndWait(page: Page): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('cancel')).toHaveCount(0);
}

/** Every row in the (first) results table is valid, with these ids in this order. */
async function expectValidRows(page: Page, ids: string[]): Promise<void> {
  const rowIds = await page
    .locator('[data-testid^="row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(rowIds).toEqual(ids.map((id) => `row-${id}`));
  const cells = page.getByTestId('checksum');
  await expect(cells).toHaveCount(ids.length);
  for (const cell of await cells.all()) {
    await expect(cell).toHaveAttribute('data-ok', 'true');
    await expect(cell).toHaveAttribute('data-valid', 'true');
    await expect(cell).toHaveText(/^(ok|noisy)$/);
  }
  const values = page.getByTestId('value');
  await expect(values).toHaveCount(ids.length);
  for (const v of await values.all()) await expect(v).toHaveText(/^(\d+(\.\d+)?|—)$/);
}

test('only the WebGL2 pixel-shading row runs, it is valid, and the fallback warning shows', async ({
  page,
}) => {
  await page.goto('/?smoke');
  test.skip(
    await hasAdapter(page),
    'WebGPU still finds an adapter with --disable-gpu in this Chrome: fallback cannot be exercised',
  );
  test.skip(
    await page.evaluate(() => !new OffscreenCanvas(1, 1).getContext('webgl2')),
    'WebGL2 is not available in this Chrome: fallback cannot be exercised',
  );
  await onlyGpu(page);
  await runAndWait(page);

  await expect(page.getByTestId('gpu-none')).toHaveCount(0);
  await expect(page.getByTestId('gpu-fallback')).toBeVisible();
  await expect(page.getByTestId('gpu-fallback')).toContainText('WebGL2');
  await expect(page.getByTestId('gpu-info')).toContainText('WebGL2 (fallback)');
  // None of the WebGPU rows ran.
  for (const id of WEBGPU_ROWS) await expect(page.getByTestId(`row-${id}`), id).toHaveCount(0);
  await expect(page.getByTestId(`row-${FALLBACK_ROW}`)).toHaveCount(1);
  await expectValidRows(page, [FALLBACK_ROW]);
});

test('Both with WebGPU off: the fallback runs once per distinct GPU, each group warns', async ({ page }) => {
  await page.goto('/?smoke');
  test.skip(await hasAdapter(page), 'WebGPU still finds an adapter with --disable-gpu in this Chrome');
  test.skip(
    await page.evaluate(() => !new OffscreenCanvas(1, 1).getContext('webgl2')),
    'WebGL2 is not available in this Chrome',
  );
  await onlyGpu(page);
  await page.getByTestId('gpu-both').check();
  await runAndWait(page);

  const groups = await page.locator('[data-testid^="gpu-run-"]').count();
  expect([1, 2]).toContain(groups);
  expect(await page.getByTestId('gpu-same').count()).toBe(groups === 1 ? 1 : 0);
  await expect(page.getByTestId('gpu-fallback')).toHaveCount(groups);
  await expect(page.getByTestId(`row-${FALLBACK_ROW}`)).toHaveCount(groups);
  const cells = page.getByTestId('checksum');
  await expect(cells).toHaveCount(groups);
  for (const cell of await cells.all()) await expect(cell).toHaveAttribute('data-valid', 'true');
});
