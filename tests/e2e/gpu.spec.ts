import { expect, test, type Page } from '@playwright/test';
import { openResults } from './helpers.ts';

// GPU tests (docs/SPEC.md, 3.4, M4). Smoke sizes only; nothing here asserts on speed.
// Headless Chrome may lack WebGPU (SPEC risk R2): those tests report as skipped, with the reason.

const WEBGPU_ROWS = ['gpu_nbody', 'gpu_matmul', 'gpu_draws', 'gpu_fragment'];

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
  await openResults(page);
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

async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      return !!navigator.gpu && !!(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  });
}

test.describe('M4 GPU: UI', () => {
  test('the GPU component is selectable but off by default; its radios appear only when checked', async ({
    page,
  }) => {
    await page.goto('/?smoke');
    const gpu = page.getByTestId('component-gpu');
    await expect(gpu).toBeEnabled();
    await expect(gpu).not.toBeChecked();
    await expect(page.getByTestId('gpu-choice')).toHaveCount(0);
    await gpu.check();
    await expect(page.getByTestId('gpu-choice')).toBeVisible();
    await gpu.uncheck();
    await expect(page.getByTestId('gpu-choice')).toHaveCount(0);
  });

  test('GPU choice radios: Fast is the default and exactly one is selected at a time', async ({ page }) => {
    await onlyGpu(page);
    const fast = page.getByTestId('gpu-fast');
    const low = page.getByTestId('gpu-low');
    const both = page.getByTestId('gpu-both');
    for (const r of [fast, low, both]) {
      await expect(r).toBeVisible();
      await expect(r).toBeEnabled();
    }
    await expect(fast).toBeChecked();
    await expect(low).not.toBeChecked();
    await expect(both).not.toBeChecked();
    await low.check();
    await expect(low).toBeChecked();
    await expect(fast).not.toBeChecked();
    await both.check();
    await expect(both).toBeChecked();
    await expect(low).not.toBeChecked();
    await fast.check();
    await expect(fast).toBeChecked();
    await expect(both).not.toBeChecked();
  });

  test('the choice survives unchecking and rechecking GPU, and Run stays enabled', async ({ page }) => {
    await onlyGpu(page);
    await page.getByTestId('gpu-low').check();
    await page.getByTestId('component-gpu').uncheck();
    await page.getByTestId('component-gpu').check();
    await expect(page.getByTestId('gpu-low')).toBeChecked();
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('the radios are disabled while a run is in progress', async ({ page }) => {
    await onlyGpu(page);
    await page.getByTestId('run').click();
    // Run flips to Cancel at once; the fieldset holding the radios is disabled for the whole run.
    await expect(page.getByTestId('cancel')).toBeVisible();
    await expect(page.getByTestId('gpu-fast')).toBeDisabled();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText(/Cancelled|Done/, { timeout: 60_000 });
    await expect(page.getByTestId('gpu-fast')).toBeEnabled();
  });
});

test.describe('M4 GPU: WebGPU', () => {
  test('GPU only: every row is valid and gpu-info names WebGPU', async ({ page }) => {
    await page.goto('/?smoke');
    test.skip(!(await hasWebGpu(page)), 'WebGPU is not available in this Chrome (SPEC R2): GPU e2e skipped');
    await onlyGpu(page);
    await runAndWait(page);

    await expect(page.getByTestId('gpu-none')).toHaveCount(0);
    await expect(page.getByTestId('gpu-fallback')).toHaveCount(0);
    await expect(page.getByTestId('gpu-info').first()).toContainText('WebGPU');
    await expect(page.getByTestId('gpu-run-high-performance')).toHaveText('Fast GPU');
    await expect(page.getByTestId('gpu-run-low-power')).toHaveCount(0);
    // The other components did not run.
    await expect(page.getByTestId('memory-results')).toHaveCount(0);
    await expectValidRows(page, WEBGPU_ROWS);
  });

  test('Power-saving: one group for the low-power GPU, all rows valid', async ({ page }) => {
    await page.goto('/?smoke');
    test.skip(!(await hasWebGpu(page)), 'WebGPU is not available in this Chrome (SPEC R2): GPU e2e skipped');
    await onlyGpu(page);
    await page.getByTestId('gpu-low').check();
    await runAndWait(page);

    await expect(page.getByTestId('gpu-run-low-power')).toHaveText('Power-saving GPU');
    await expect(page.getByTestId('gpu-run-high-performance')).toHaveCount(0);
    await expect(page.getByTestId('gpu-same')).toHaveCount(0);
    await expect(page.getByTestId('gpu-info')).toContainText('WebGPU');
    await expectValidRows(page, WEBGPU_ROWS);
  });

  test('Both: two result groups for two GPUs, or one group plus the same-GPU hint', async ({ page }) => {
    await page.goto('/?smoke');
    test.skip(!(await hasWebGpu(page)), 'WebGPU is not available in this Chrome (SPEC R2): GPU e2e skipped');
    await onlyGpu(page);
    await page.getByTestId('gpu-both').check();
    await runAndWait(page);

    const groups = page.locator('[data-testid^="gpu-run-"]');
    const same = await page.getByTestId('gpu-same').count();
    if (same === 1) {
      // Both preferences gave one GPU: tested once, and the page tells how to reach the other.
      await expect(groups).toHaveCount(1);
      await expect(page.getByTestId('gpu-run-high-performance')).toBeVisible();
      await expect(page.getByTestId('gpu-same')).toContainText('same GPU');
      await expect(page.getByTestId('gpu-same')).toContainText('chrome://flags/#force-high-performance-gpu');
      await expectValidRows(page, WEBGPU_ROWS);
    } else {
      await expect(page.getByTestId('gpu-same')).toHaveCount(0);
      await expect(groups).toHaveCount(2);
      await expect(page.getByTestId('gpu-run-high-performance')).toBeVisible();
      await expect(page.getByTestId('gpu-run-low-power')).toBeVisible();
      await expect(page.getByTestId('gpu-info')).toHaveCount(2);
      const rowIds = await page
        .locator('[data-testid^="row-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(rowIds).toEqual([...WEBGPU_ROWS, ...WEBGPU_ROWS].map((id) => `row-${id}`));
      const cells = page.getByTestId('checksum');
      await expect(cells).toHaveCount(WEBGPU_ROWS.length * 2);
      for (const cell of await cells.all()) await expect(cell).toHaveAttribute('data-valid', 'true');
    }
  });

  test('GPU can be combined with another component; its group still renders', async ({ page }) => {
    await page.goto('/?smoke');
    test.skip(!(await hasWebGpu(page)), 'WebGPU is not available in this Chrome (SPEC R2): GPU e2e skipped');
    await page.getByTestId('component-gpu').check(); // CPU single-core stays on
    await runAndWait(page);
    await expect(page.getByTestId('row-sha256')).toHaveCount(1);
    for (const id of WEBGPU_ROWS) await expect(page.getByTestId(`row-${id}`), id).toHaveCount(1);
    const cells = page.getByTestId('checksum');
    for (const cell of await cells.all()) await expect(cell).toHaveAttribute('data-valid', 'true');
  });
});
