import { expect, test, type Page } from '@playwright/test';
import { openResults } from './helpers.ts';

// M8 compact results (docs/SPEC.md, section 12): each component's results sit in a closed <details>
// (section-<id>) whose summary row (summary-<id>) says points / test count / checks; the memory latency table
// is in its own closed <details>. A failed check opens its section by itself; a manual open or close lasts for
// the page session. Smoke sizes only; nothing here asserts on speed.

const KEY = 'browser-bench:history';
const CPU_KERNELS = 11;
const LATENCY_SIZES = 17;
const WITH_CHECKS = (n: number) => new RegExp(`^${n} tests · (all checks passed|\\d+ noisy)$`);

async function runAndWait(page: Page, timeout = 60_000): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Done', { timeout });
  await expect(page.getByTestId('error')).toHaveCount(0);
}

const isOpen = (page: Page, id: string) => page.getByTestId(id).evaluate((d) => (d as HTMLDetailsElement).open);

/** The first run the page saved, to build imported files from. */
async function savedRun(page: Page): Promise<Record<string, unknown>> {
  const text = await page.evaluate((k) => localStorage.getItem(k), KEY);
  return (JSON.parse(text!) as { runs: Record<string, unknown>[] }).runs[0]!;
}

/** Imports `run` as a saved run with this id, then opens it from the history list. */
async function importAndOpen(page: Page, run: Record<string, unknown>, id: string): Promise<void> {
  const file = JSON.stringify({ format: 'browser-bench', schema: 1, runs: [{ ...run, id }] });
  await page.getByTestId('history-import').setInputFiles({ name: 'in.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  const item = page.locator(`[data-testid="history-item"][data-id="${id}"]`);
  await expect(item).toHaveCount(1);
  await item.getByTestId('history-open').click();
  await expect(page.getByTestId('run-info')).toContainText('Saved run');
}

type Comp = { kernels: Record<string, unknown>[] };

test.describe('M8 closed result sections', () => {
  test('after a smoke run the sections are closed, summaries say what is inside, a click opens one', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-memory').check();
    await page.getByTestId('workers').fill('2');
    await runAndWait(page, 120_000);

    // The Score overview stays visible; the component tables are folded away.
    await expect(page.getByTestId('points')).toBeVisible();
    for (const id of ['section-cpu-single', 'section-memory']) {
      await expect(page.getByTestId(id)).toBeVisible();
      expect(await isOpen(page, id), id).toBe(false);
    }
    await expect(page.getByTestId('section-cpu-multi')).toHaveCount(0);
    await expect(page.getByTestId('row-sha256')).toBeHidden();
    await expect(page.locator('[data-testid^="mem-row-"]').first()).toBeHidden();

    // Summary: test count and check state (smoke has no points, so no "pts"). Noisy is machine-dependent.
    await expect(page.getByTestId('summary-cpu-single')).toHaveText(WITH_CHECKS(CPU_KERNELS));
    await expect(page.getByTestId('summary-memory')).toHaveText(/^\d+ tests · (all checks passed|\d+ noisy)$/);
    await expect(page.getByTestId('summary-cpu-single')).not.toContainText('failed');
    await expect(page.getByTestId('summary-cpu-single')).not.toContainText('pts');

    // Clicking a summary opens only that section.
    await page.getByTestId('summary-cpu-single').click();
    expect(await isOpen(page, 'section-cpu-single')).toBe(true);
    expect(await isOpen(page, 'section-memory')).toBe(false);
    await expect(page.getByTestId('row-sha256')).toBeVisible();
    await expect(page.locator('[data-testid^="mem-row-"]').first()).toBeHidden();
  });

  test('the memory latency table is closed until opened: "Show table (17 sizes)", then 17 rows', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-memory').check();
    await page.getByTestId('workers').fill('2');
    await runAndWait(page, 120_000);

    await page.getByTestId('summary-memory').click();
    expect(await isOpen(page, 'section-memory')).toBe(true);
    // The chart is drawn once its section is open (a closed canvas has no size).
    await expect(page.getByTestId('latency-chart')).toBeVisible();
    expect(await page.getByTestId('latency-chart').evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);

    const table = page.getByTestId('latency-table');
    await expect(table).toBeVisible();
    expect(await isOpen(page, 'latency-table')).toBe(false);
    await expect(table.locator('summary')).toHaveText(`Show table (${LATENCY_SIZES} sizes)`);
    const rows = page.locator('[data-testid^="latency-row-"]');
    await expect(rows).toHaveCount(LATENCY_SIZES);
    await expect(rows.first()).toBeHidden();

    await table.locator('summary').click();
    expect(await isOpen(page, 'latency-table')).toBe(true);
    await expect(rows).toHaveCount(LATENCY_SIZES);
    for (const row of await rows.all()) await expect(row).toBeVisible();
  });

  test('a manual open or close lasts for the page session, across runs', async ({ page }) => {
    await page.goto('/?smoke');
    await runAndWait(page);
    expect(await isOpen(page, 'section-cpu-single')).toBe(false);

    await page.getByTestId('summary-cpu-single').click();
    expect(await isOpen(page, 'section-cpu-single')).toBe(true);
    await runAndWait(page); // the second run replaces the results; the user's choice stays
    await expect(page.getByTestId('summary-cpu-single')).toHaveText(WITH_CHECKS(CPU_KERNELS));
    expect(await isOpen(page, 'section-cpu-single')).toBe(true);
    await expect(page.getByTestId('row-sha256')).toBeVisible();

    await page.getByTestId('summary-cpu-single').click();
    expect(await isOpen(page, 'section-cpu-single')).toBe(false);
    await runAndWait(page);
    expect(await isOpen(page, 'section-cpu-single')).toBe(false);
  });

  test('test names carry their description as a tooltip (title), not a second line', async ({ page }) => {
    await page.goto('/?smoke');
    await runAndWait(page);
    await openResults(page);
    for (const id of ['sha256', 'matmul', 'fft']) {
      const name = page.getByTestId(`row-${id}`).locator('td').first();
      const title = await name.getAttribute('title');
      expect(title, id).toBeTruthy();
      expect(title!.trim().length, id).toBeGreaterThan(2);
      // The description is only in the tooltip.
      expect((await name.innerText()).includes(title!), id).toBe(false);
    }
  });
});

test.describe('M8 saved runs and failed checks', () => {
  /** Runs one smoke run (so the page saves it) and returns the saved record. */
  async function base(page: Page): Promise<Record<string, unknown>> {
    await page.goto('/?smoke');
    await runAndWait(page);
    return savedRun(page);
  }

  test('a failed check opens its section by itself and the summary says "1 failed"', async ({ page }) => {
    const run = await base(page);
    const comps = structuredClone(run['components']) as Comp[];
    // Output check failed on one kernel: the kernel is invalid and its dot is red.
    Object.assign(comps[0]!.kernels[3]!, { checksumOk: false, valid: false, value: null, hidden: false });
    await page.reload();
    await importAndOpen(page, { ...run, components: comps }, 'forged-fail');

    expect(await isOpen(page, 'section-cpu-single')).toBe(true);
    await expect(page.getByTestId('summary-cpu-single')).toContainText('1 failed');
    await expect(page.getByTestId('summary-cpu-single')).not.toContainText('all checks passed');
    await expect(page.getByTestId('row-sha256')).toBeVisible();
    await expect(page.locator('[data-testid="checksum"][data-ok="false"]')).toHaveCount(1);
  });

  test('a clean saved run opens closed; with points the summary starts with "<n> pts"', async ({ page }) => {
    const run = await base(page);
    // A standard-size record with plain valid numbers: the page rescoring gives the component points.
    const comps = structuredClone(run['components']) as Comp[];
    for (const k of comps[0]!.kernels) {
      Object.assign(k, { value: 100, valid: true, noisy: false, hidden: false });
      delete k['checksumOk'];
    }
    await page.reload();
    await importAndOpen(page, { ...run, size: 'standard', components: comps }, 'forged-clean');

    expect(await isOpen(page, 'section-cpu-single')).toBe(false);
    await expect(page.getByTestId('summary-cpu-single')).toHaveText(/^\d+ pts · 11 tests · all checks passed$/);
    await expect(page.getByTestId('row-sha256')).toBeHidden();
  });

  test('a user close of an auto-opened section holds for the page session', async ({ page }) => {
    const run = await base(page);
    const comps = structuredClone(run['components']) as Comp[];
    Object.assign(comps[0]!.kernels[0]!, { checksumOk: false, valid: false, value: null, hidden: false });
    await page.reload();
    await importAndOpen(page, { ...run, components: comps }, 'forged-fail');
    expect(await isOpen(page, 'section-cpu-single')).toBe(true);

    await page.getByTestId('summary-cpu-single').click();
    expect(await isOpen(page, 'section-cpu-single')).toBe(false);
    await expect(page.getByTestId('summary-cpu-single')).toContainText('1 failed');
  });
});
