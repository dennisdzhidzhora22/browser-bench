import { expect, test, type Page } from '@playwright/test';

// Storage tests (docs/SPEC.md, 3.5, M5). Smoke size unless a test says otherwise; nothing here asserts on speed.
// OPFS is per browser context, and Playwright gives every test a fresh context, so tests cannot see each other's files.

const STORAGE_ROWS = ['storage_seq_write', 'storage_seq_read', 'storage_rand_write', 'storage_rand_read'];
const MIB = 1024 * 1024;

async function onlyStorage(page: Page): Promise<void> {
  await page.goto('/?smoke');
  await page.getByTestId('component-cpu-single').uncheck();
  await page.getByTestId('component-storage').check();
}

/** Names of the entries in the OPFS root that belong to the storage tests. */
async function testDirs(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [name] of root.entries()) if (name.startsWith('bb-storage-')) out.push(name);
    return out.sort();
  });
}

/** Every entry in the OPFS root, whatever its name (to prove nothing else was touched). */
async function rootEntries(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [name] of root.entries()) out.push(name);
    return out.sort();
  });
}

/** Names of the files inside every test directory (empty while a run has not created one yet). */
async function testFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [name, h] of root.entries()) {
      if (!name.startsWith('bb-storage-') || h.kind !== 'directory') continue;
      for await (const [file] of (h as FileSystemDirectoryHandle).entries()) out.push(file);
    }
    return out;
  });
}

/** Click Run and wait for Done, failing loudly on the page's own error line. */
async function runAndWait(page: Page, timeout = 120_000): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Done', { timeout });
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('cancel')).toHaveCount(0);
}

/** The first results table holds exactly these rows, in this order, all valid, each with a number (or a dash). */
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

test.describe('M5 storage: UI', () => {
  test('Storage is selectable and off by default; no storage section before a run', async ({ page }) => {
    await page.goto('/?smoke');
    const storage = page.getByTestId('component-storage');
    await expect(storage).toBeEnabled();
    await expect(storage).not.toBeChecked();
    await expect(page.getByTestId('storage-info')).toHaveCount(0);
    await expect(page.getByTestId('storage-caveat')).toHaveCount(0);
    // It needs no worker count (that input is for the all-cores tests only).
    await storage.check();
    await expect(page.getByTestId('workers')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('Run is disabled when Storage was the only thing selected and is unchecked again', async ({ page }) => {
    await onlyStorage(page);
    await expect(page.getByTestId('run')).toBeEnabled();
    await page.getByTestId('component-storage').uncheck();
    await expect(page.getByTestId('run')).toBeDisabled();
  });
});

test.describe('M5 storage: smoke run', () => {
  test('Storage only: four valid rows, the file size, the R4 caveat, and the test files removed', async ({ page }) => {
    await onlyStorage(page);
    await runAndWait(page);

    // Only the storage section: no CPU tables.
    await expect(page.getByTestId('results')).toHaveCount(1);
    await expect(page.locator('[data-testid^="multi-row-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="mem-row-"]')).toHaveCount(0);
    await expect(page.getByTestId('storage-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('storage-error')).toHaveCount(0);

    await expectValidRows(page, STORAGE_ROWS);

    // Units, as in SPEC 3.5.
    await expect(page.getByTestId('row-storage_seq_write')).toContainText('MB/s');
    await expect(page.getByTestId('row-storage_seq_read')).toContainText('MB/s');
    await expect(page.getByTestId('row-storage_rand_write')).toContainText('IOPS');
    await expect(page.getByTestId('row-storage_rand_read')).toContainText('IOPS');

    // The smoke file is 2 MiB and the page says which API ran.
    const info = page.getByTestId('storage-info');
    await expect(info).toHaveAttribute('data-bytes', String(2 * MIB));
    await expect(info).toContainText('OPFS');
    await expect(info).toContainText('2 MiB');
    await expect(page.getByTestId('storage-scaled')).toHaveCount(0);

    // R4: the caveat about the OS file cache and the browser sitting between test and disk.
    const caveat = page.getByTestId('storage-caveat');
    await expect(caveat).toBeVisible();
    await expect(caveat).toContainText('OS file cache can inflate reads');
    await expect(caveat).toContainText('the browser sits between the test and the disk');

    // Cleanup: the page says so, and OPFS agrees.
    await expect(page.getByTestId('storage-cleanup')).toHaveAttribute('data-removed', 'true');
    await expect(page.getByTestId('storage-cleanup')).toContainText('Test files removed');
    expect(await testDirs(page)).toEqual([]);
    expect(await rootEntries(page)).toEqual([]);
  });

  test('a second run replaces the rows instead of appending, and leaves no files', async ({ page }) => {
    await onlyStorage(page);
    for (let i = 0; i < 2; i++) await runAndWait(page);
    await expectValidRows(page, STORAGE_ROWS);
    await expect(page.getByTestId('storage-info')).toHaveCount(1);
    await expect(page.getByTestId('storage-caveat')).toHaveCount(1);
    expect(await testDirs(page)).toEqual([]);
  });

  test('Full mode also completes at smoke size', async ({ page }) => {
    await onlyStorage(page);
    await page.getByTestId('mode-full').check();
    await runAndWait(page);
    await expectValidRows(page, STORAGE_ROWS);
    expect(await testDirs(page)).toEqual([]);
  });

  test('a run in a hidden tab marks every storage row hidden and invalid, and still cleans up', async ({ page }) => {
    await page.goto('/?smoke');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await runAndWait(page);
    const cells = page.getByTestId('checksum');
    await expect(cells).toHaveCount(STORAGE_ROWS.length);
    for (const cell of await cells.all()) {
      await expect(cell).toHaveAttribute('data-ok', 'true');
      await expect(cell).toHaveAttribute('data-valid', 'false');
      await expect(cell).toHaveText('hidden');
    }
    for (const v of await page.getByTestId('value').all()) await expect(v).toHaveText('—');
    expect(await testDirs(page)).toEqual([]);
  });

  test('CPU single-core and Storage together: both tables, all rows valid', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('component-storage').check();
    await runAndWait(page, 180_000);
    // 11 CPU rows + 4 storage rows in two tables.
    await expect(page.getByTestId('results')).toHaveCount(2);
    await expect(page.getByTestId('storage-caveat')).toBeVisible();
    for (const id of STORAGE_ROWS) await expect(page.getByTestId(`row-${id}`)).toHaveCount(1);
    const cells = page.getByTestId('checksum');
    await expect(cells).toHaveCount(11 + STORAGE_ROWS.length);
    for (const cell of await cells.all()) await expect(cell).toHaveAttribute('data-valid', 'true');
    expect(await testDirs(page)).toEqual([]);
  });

  test('every network request is same-origin during a storage run', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await onlyStorage(page);
    await runAndWait(page);
    const external = urls.filter((u) => {
      if (u.startsWith('data:') || u.startsWith('blob:')) return false;
      return new URL(u).origin !== origin;
    });
    expect(external).toEqual([]);
  });

  test('the storage worker never fetches the wasm kernels (it needs none)', async ({ page }) => {
    const wasm: string[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('.wasm')) wasm.push(req.url());
    });
    await onlyStorage(page);
    await runAndWait(page);
    expect(wasm).toEqual([]);
  });
});

test.describe('M5 storage: quota', () => {
  /** Make navigator.storage.estimate() report this quota and usage, before the page's scripts run. */
  async function fakeEstimate(page: Page, quota: number, usage = 0): Promise<void> {
    await page.addInitScript(
      ([q, u]) => {
        StorageManager.prototype.estimate = async () => ({ quota: q!, usage: u! });
      },
      [quota, usage],
    );
  }

  test('too little quota: the page explains, runs no storage test and creates no files', async ({ page }) => {
    await fakeEstimate(page, 4 * MIB); // smoke needs 8 MiB free (a quarter of it is the 2 MiB file)
    await onlyStorage(page);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 30_000 });
    const msg = page.getByTestId('storage-unavailable');
    await expect(msg).toBeVisible();
    await expect(msg).toContainText('Not enough storage quota');
    await expect(msg).toContainText('8 MiB');
    await expect(page.getByTestId('storage-info')).toHaveCount(0);
    await expect(page.getByTestId('storage-caveat')).toHaveCount(0);
    await expect(page.locator('[data-testid^="row-"]')).toHaveCount(0);
    expect(await testDirs(page)).toEqual([]);
  });

  test('standard size with little quota is scaled down, flagged not comparable, and still valid', async ({ page }) => {
    // 64 MiB left -> a quarter is 16 MiB, the smallest standard-size file.
    await fakeEstimate(page, 64 * MIB);
    await page.goto('/');
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await runAndWait(page, 180_000);

    const info = page.getByTestId('storage-info');
    await expect(info).toHaveAttribute('data-bytes', String(16 * MIB));
    await expect(info).toContainText('16 MiB');
    await expect(info).toContainText('64 MiB'); // "this site may use 64 MiB more"
    const scaled = page.getByTestId('storage-scaled');
    await expect(scaled).toBeVisible();
    await expect(scaled).toContainText('not comparable');
    await expectValidRows(page, STORAGE_ROWS);
    await expect(page.getByTestId('storage-cleanup')).toHaveAttribute('data-removed', 'true');
    expect(await testDirs(page)).toEqual([]);
  });

  test('standard size with just under the minimum: refused with a message, no files', async ({ page }) => {
    await fakeEstimate(page, 64 * MIB - 1);
    await page.goto('/');
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 30_000 });
    await expect(page.getByTestId('storage-unavailable')).toContainText('64 MiB');
    expect(await testDirs(page)).toEqual([]);
  });
});

test.describe('M5 storage: cleanup', () => {
  test('cancel mid-run removes the test directory (standard size, so the run is still writing)', async ({ page }) => {
    test.setTimeout(120_000);
    // Smoke is far too fast to cancel in the middle, so this uses the plain URL: standard size, a 256 MiB
    // file (or a quarter of the quota left, if smaller). The first test, sequential write, fills it with
    // synchronous 1 MiB writes for seconds, so the run is guaranteed to be in flight.
    await page.goto('/');
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await page.getByTestId('run').click();
    const cancel = page.getByTestId('cancel');
    await expect(cancel).toBeVisible();
    await expect(page.getByTestId('progress')).toContainText('1 / 4');

    // Wait until the worker really has a test file open in this run's directory, so the cancel lands on a
    // locked file (the case the page's retrying delete exists for).
    await expect
      .poll(() => testFiles(page), { timeout: 30_000, message: 'a test file exists while running' })
      .toContain('storage_seq_write.bin');
    expect(await testDirs(page)).toHaveLength(1);

    await cancel.click();

    // 'Cancelled' appears after the page has finished removing the directory (up to 15 s of retries).
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 60_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('cancel')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
    expect(await testDirs(page)).toEqual([]);
    expect(await rootEntries(page)).toEqual([]);
    // It never finished, so it must not show every storage row as done.
    await expect(page.getByTestId('checksum')).not.toHaveCount(STORAGE_ROWS.length);
  });

  test('can run again after a cancel', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('cancel')).toBeVisible();
    await expect
      .poll(() => testFiles(page), { timeout: 30_000 })
      .toContain('storage_seq_write.bin');
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 60_000 });
    expect(await testDirs(page)).toEqual([]);

    // Same page: Run starts a new run in a new directory, and cancelling that one cleans up too.
    await page.getByTestId('run').click();
    await expect(page.getByTestId('cancel')).toBeVisible();
    await expect
      .poll(() => testFiles(page), { timeout: 30_000 })
      .toContain('storage_seq_write.bin');
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 60_000 });
    await expect(page.getByTestId('run')).toBeEnabled();
    expect(await testDirs(page)).toEqual([]);
  });

  test('a stale test directory from a crashed run is swept when the page loads', async ({ page }) => {
    await page.goto('/?smoke');
    // Plant what a closed tab would leave behind: a bb-storage-* directory holding a file, plus two entries
    // the sweep must not touch (a directory and a file whose names merely look similar).
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const stale = await root.getDirectoryHandle('bb-storage-old', { create: true });
      const f = await stale.getFileHandle('storage_seq_write.bin', { create: true });
      const w = await f.createWritable();
      await w.write(new Uint8Array(1024 * 1024));
      await w.close();
      await root.getDirectoryHandle('keep-this-dir', { create: true });
      await root.getFileHandle('bb-storage-is-a-file', { create: true });
    });
    expect((await testDirs(page)).sort()).toEqual(['bb-storage-is-a-file', 'bb-storage-old']);

    await page.reload();
    await expect(page.getByTestId('isolated')).toBeVisible();
    // The sweep is asynchronous and best effort at load; it must finish on its own.
    await expect
      .poll(() => rootEntries(page), { timeout: 15_000, message: 'stale directory swept' })
      .toEqual(['bb-storage-is-a-file', 'keep-this-dir']);
  });

  test('a stale directory is also gone after the next run, which leaves nothing of its own', async ({ page }) => {
    await page.goto('/?smoke');
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const stale = await root.getDirectoryHandle('bb-storage-old', { create: true });
      await stale.getFileHandle('x.bin', { create: true });
    });
    await page.reload();
    await page.getByTestId('component-cpu-single').uncheck();
    await page.getByTestId('component-storage').check();
    await runAndWait(page);
    await expectValidRows(page, STORAGE_ROWS);
    await expect.poll(() => rootEntries(page), { timeout: 15_000 }).toEqual([]);
  });
});
