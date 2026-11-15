import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// M6: saved runs, history, export / import (docs/SPEC.md, section 6). Smoke size, CPU single-core only, so a run takes a
// moment. Playwright gives every test a fresh browser context, so each test starts with an empty history.
// Nothing here asserts on speed.

const KEY = 'browser-bench:history';

interface Rec {
  id: string;
  time: string;
  scoreVersion: number;
  size: string;
  total: number | null;
  partial: boolean;
  components: { points: number | null; partial: boolean; note?: string }[];
}
interface ExportFile {
  format: string;
  schema: number;
  runs: Rec[];
}

async function runOnce(page: Page): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
  await expect(page.getByTestId('error')).toHaveCount(0);
}

async function startSmoke(page: Page): Promise<void> {
  await page.goto('/?smoke');
  await expect(page.getByTestId('history')).toBeVisible();
}

const saved = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), KEY);

/** What the page stored, parsed. */
async function stored(page: Page): Promise<ExportFile> {
  return JSON.parse((await saved(page)) ?? 'null') as ExportFile;
}

async function importText(page: Page, text: string | Buffer, name = 'in.json'): Promise<void> {
  await page.getByTestId('history-import').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: typeof text === 'string' ? Buffer.from(text) : text,
  });
}

async function clearAll(page: Page): Promise<void> {
  const clear = page.getByTestId('history-clear');
  await clear.click(); // the first click only asks
  await expect(clear).toHaveText(/^Really delete all \d+\?$/);
  await expect(page.getByTestId('history-item').first()).toBeVisible();
  await clear.click();
  await expect(page.getByTestId('history-empty')).toBeVisible();
}

async function downloadJson(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), text: readFileSync((await dl.path())!, 'utf8') };
}

/** A run record taken from what the page saved, to build files from. */
async function baseRun(page: Page): Promise<Rec> {
  await startSmoke(page);
  await runOnce(page);
  return (await stored(page)).runs[0]!;
}

const fileOf = (runs: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'browser-bench', schema: 1, runs, ...over });

test.describe('M6 history: saving and showing runs', () => {
  test('a finished run is saved, shown as "smoke: no points", and still there after a reload', async ({ page }) => {
    await startSmoke(page);
    await expect(page.getByTestId('history-empty')).toBeVisible();
    await expect(page.getByTestId('history-item')).toHaveCount(0);
    await runOnce(page);

    // The live run shows its points block: smoke has none.
    await expect(page.getByTestId('points')).toBeVisible();
    await expect(page.getByTestId('total')).toHaveText('smoke: no points');
    await expect(page.getByTestId('history-empty')).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-total')).toHaveText('smoke: no points');
    await expect(page.getByTestId('history-message')).toHaveCount(0);

    const file = await stored(page);
    expect(file).toMatchObject({ format: 'browser-bench', schema: 1 });
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0]).toMatchObject({ size: 'smoke', total: null });
    const id = await page.getByTestId('history-item').getAttribute('data-id');
    expect(id).toBe(file.runs[0]!.id);

    await page.reload();
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-item')).toHaveAttribute('data-id', id!);
    await expect(page.getByTestId('history-total')).toHaveText('smoke: no points');
    await expect(page.getByTestId('history-message')).toHaveCount(0);
    // Nothing is shown above the results until a run is opened.
    await expect(page.getByTestId('points')).toHaveCount(0);
  });

  test('a saved run opens with its results table and its points block', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    const liveRows = await page.locator('[data-testid^="row-"]').count();
    expect(liveRows).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByTestId('results')).toHaveCount(0);
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('points')).toBeVisible();
    await expect(page.getByTestId('run-info')).toContainText('Saved run');
    await expect(page.getByTestId('total')).toHaveText('smoke: no points');
    await expect(page.locator('[data-testid^="row-"]')).toHaveCount(liveRows);
    // Opening is read-only: the history is unchanged.
    await expect(page.getByTestId('history-item')).toHaveCount(1);
  });

  test('every run is kept, newest first; Delete removes one; Clear all asks twice', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    await runOnce(page);
    await runOnce(page);
    const items = page.getByTestId('history-item');
    await expect(items).toHaveCount(3);
    const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(new Set(ids).size).toBe(3);
    const times = (await stored(page)).runs.map((r) => Date.parse(r.time));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(ids).toEqual((await stored(page)).runs.map((r) => r.id));

    await items.first().getByTestId('history-delete').click();
    await expect(items).toHaveCount(2);
    expect((await stored(page)).runs.map((r) => r.id)).toEqual(ids.slice(1));

    // One click on Clear all only asks; clicking elsewhere cancels the question.
    const clear = page.getByTestId('history-clear');
    await clear.click();
    await expect(clear).toHaveText('Really delete all 2?');
    await page.getByTestId('mode-full').focus();
    await expect(clear).toHaveText('Clear all');
    await expect(items).toHaveCount(2);

    await clearAll(page);
    await expect(items).toHaveCount(0);
    expect(await saved(page)).toBeNull(); // an empty history removes the key
    await page.reload();
    await expect(page.getByTestId('history-empty')).toBeVisible();
  });

  test('unreadable saved data shows a message, and the next saved run replaces it', async ({ page }) => {
    await startSmoke(page);
    await page.evaluate((k) => localStorage.setItem(k, 'this is { not json'), KEY);
    await page.reload();
    await expect(page.getByTestId('history-message')).toContainText('could not be read');
    await expect(page.getByTestId('history-empty')).toBeVisible();
    await runOnce(page);
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-message')).toHaveCount(0);
    expect((await stored(page)).runs).toHaveLength(1);
  });

  test('blocked local storage: the page still loads and runs, with a message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Access is denied', 'SecurityError');
        },
      });
    });
    await page.goto('/?smoke');
    await expect(page.getByTestId('history-message')).toContainText('not available');
    await expect(page.getByTestId('run')).toBeEnabled();
    await runOnce(page);
    await expect(page.getByTestId('history-message')).toContainText('not available');
    // The run itself is still shown.
    await expect(page.getByTestId('points')).toBeVisible();
    await expect(page.getByTestId('total')).toHaveText('smoke: no points');
  });
});

test.describe('M6 export and import', () => {
  test('export one run, clear, import it back: the saved history is identical', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    const before = await saved(page);
    expect(before).not.toBeNull();

    const { name, text } = await downloadJson(page, () => page.getByTestId('history-export').click());
    expect(name).toMatch(/^browser-bench-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/);
    const parsed = JSON.parse(text) as ExportFile;
    expect(parsed).toMatchObject({ format: 'browser-bench', schema: 1 });
    expect(parsed.runs).toHaveLength(1);

    await clearAll(page);
    await importText(page, text, name);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run.');
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).toBe(before); // byte-identical
    expect(await stored(page)).toEqual(parsed);

    // And it survives a reload.
    await page.reload();
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).toBe(before);
  });

  test('export all, clear, import: every run comes back in the same order', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    await runOnce(page);
    const before = await saved(page);
    const { name, text } = await downloadJson(page, () => page.getByTestId('history-export-all').click());
    expect(name).toMatch(/^browser-bench-history-\d{4}-\d\d-\d\d\.json$/);
    expect((JSON.parse(text) as ExportFile).runs).toHaveLength(2);

    await clearAll(page);
    await importText(page, text);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 2 runs.');
    await expect(page.getByTestId('history-item')).toHaveCount(2);
    expect(await saved(page)).toBe(before);
  });

  test('importing runs that are already there adds nothing and says so', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    const before = await saved(page);
    const { text } = await downloadJson(page, () => page.getByTestId('history-export').click());
    await importText(page, text);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 0 runs (1 already in history).');
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).toBe(before);
  });

  test('a file with another schema version is refused with a message; history is unchanged', async ({ page }) => {
    await startSmoke(page);
    await runOnce(page);
    const before = await saved(page);
    await importText(page, fileOf([], { schema: 2 }));
    const msg = page.getByTestId('history-message');
    await expect(msg).toContainText('v2');
    await expect(msg).toContainText('reads v1');
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).toBe(before);
  });

  test('other bad files: not JSON, not ours, wrong field types, one bad run among good ones', async ({ page }) => {
    const run = await baseRun(page);
    const before = await saved(page);
    const msg = page.getByTestId('history-message');
    const cases: [string, string | Buffer, RegExp][] = [
      ['not JSON', 'hello, this is not json', /not valid JSON/],
      ['empty file', '', /not valid JSON/],
      ['another JSON file', '{"name":"package","version":"1.0.0"}', /not a browser-bench export/],
      ['an array', '[1,2,3]', /not a browser-bench export/],
      ['no list of runs', '{"format":"browser-bench","schema":1}', /no list of runs/],
      ['a field of the wrong type', fileOf([{ ...run, id: 7 }]), /Run 1 .*not valid/],
      ['an unknown mode', fileOf([{ ...run, id: 'x', mode: 'turbo' }]), /Run 1 .*not valid/],
      ['a time that is not ISO UTC', fileOf([{ ...run, id: 'x', time: '2026-11-01T10:00:00+05:00' }]), /Run 1 .*not valid/],
      ['zero cores', fileOf([{ ...run, id: 'x', system: { ...(run as never as { system: object }).system, cores: 0 } }]), /Run 1 .*not valid/],
      [
        'a fractional core count',
        fileOf([{ ...run, id: 'x', system: { ...(run as never as { system: object }).system, cores: 2.5 } }]),
        /Run 1 .*not valid/,
      ],
      ['one bad run among good ones', fileOf([{ ...run, id: 'good' }, { ...run, id: 'bad', total: 'lots' }]), /Run 2 .*not valid/],
    ];
    for (const [name, content, re] of cases) {
      await importText(page, content);
      await expect(msg, name).toContainText(re);
      // Nothing was imported, not even the good run next to a bad one.
      await expect(page.getByTestId('history-item'), name).toHaveCount(1);
      expect(await saved(page), name).toBe(before);
    }
    await expect(page.getByTestId('history-confirm')).toHaveCount(0);
  });

  test('a valid-and-hidden kernel is rejected', async ({ page }) => {
    const run = (await baseRun(page)) as unknown as { id: string; components: { kernels: Record<string, unknown>[] }[] };
    run.id = 'forged';
    Object.assign(run.components[0]!.kernels[0]!, { valid: true, hidden: true });
    await importText(page, fileOf([run]));
    await expect(page.getByTestId('history-message')).toContainText('Run 1 in the file is not valid');
    await expect(page.getByTestId('history-item')).toHaveCount(1);
  });

  test('a file over 5 MB is refused before it is read', async ({ page }) => {
    await startSmoke(page);
    await importText(page, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    await expect(page.getByTestId('history-message')).toContainText('larger than 5 MB');
    await expect(page.getByTestId('history-empty')).toBeVisible();
  });

  test('a hand-edited scoreVersion shows "not comparable" in the list and on the opened run', async ({ page }) => {
    const run = await baseRun(page);
    await clearAll(page);
    await importText(page, fileOf([{ ...run, scoreVersion: 99, total: 777 }]));
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-total')).toHaveText('not comparable (score v99)');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('not-comparable')).toContainText('score v99');
    await expect(page.getByTestId('points')).toHaveAttribute('data-score-version', '99');
    // Saved points are shown as saved: nothing is recomputed for another version.
    expect((await stored(page)).runs[0]).toMatchObject({ scoreVersion: 99, total: 777 });
  });

  test('saved points are never trusted: a forged total is recomputed on import and on load', async ({ page }) => {
    const run = await baseRun(page);
    const forged = {
      ...run,
      id: 'forged',
      size: 'standard',
      total: 999999,
      partial: false,
      components: run.components.map((c) => ({ ...c, points: 999999, partial: false })),
    };
    await clearAll(page);
    await importText(page, fileOf([forged]));
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-total')).not.toContainText('999999');
    const rec = (await stored(page)).runs[0]!;
    expect(rec.total).not.toBe(999999);
    expect(rec.components.every((c) => c.points !== 999999)).toBe(true);

    // Also on load: tamper with the saved history directly.
    await page.evaluate(
      ([k]) => {
        const f = JSON.parse(localStorage.getItem(k!)!);
        f.runs[0].total = 999999;
        for (const c of f.runs[0].components) c.points = 999999;
        localStorage.setItem(k!, JSON.stringify(f));
      },
      [KEY],
    );
    await page.reload();
    await expect(page.getByTestId('history-total')).not.toContainText('999999');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('points')).not.toContainText('999999');
  });

  test('unknown keys in an imported file are not kept', async ({ page }) => {
    const run = await baseRun(page);
    await clearAll(page);
    await importText(page, fileOf([{ ...run, junkKey: 'x', system: { ...(run as never as { system: object }).system, other: 1 } }], { extra: 1 }));
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).not.toContain('junkKey');
    expect(await saved(page)).not.toContain('"other"');
  });
});

test.describe('M6 history cap and the import confirmation', () => {
  /** Fills the saved history with `n` runs, one per hour from `start`, then reloads. Returns their ids (newest first). */
  async function seed(page: Page, run: Rec, n: number, start = Date.UTC(2026, 0, 1)): Promise<string[]> {
    const runs = Array.from({ length: n }, (_, i) => ({ ...run, id: `seed-${i}`, time: new Date(start + i * 3_600_000).toISOString() }));
    await page.evaluate(([k, text]) => localStorage.setItem(k!, text!), [KEY, fileOf(runs)]);
    await page.reload();
    return runs.map((r) => r.id).reverse();
  }
  const ids = (page: Page) => page.getByTestId('history-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));

  test('a 51st run pushes the oldest out: the history never holds more than 50', async ({ page }) => {
    const run = await baseRun(page);
    const seeded = await seed(page, run, 50);
    await expect(page.getByTestId('history-item')).toHaveCount(50);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('history-item')).toHaveCount(50);
    const now = await ids(page);
    expect(now).not.toContain('seed-0'); // the oldest
    expect(now.slice(1)).toEqual(seeded.slice(0, 49));
    expect((await stored(page)).runs).toHaveLength(50);
  });

  test('an import that would push saved runs out asks first; "Cancel" keeps the history unchanged', async ({ page }) => {
    const run = await baseRun(page);
    const seeded = await seed(page, run, 50);
    const before = await saved(page);
    await importText(page, fileOf([{ ...run, id: 'newcomer', time: '2030-01-01T00:00:00.000Z' }]));

    const confirm = page.getByTestId('history-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Only the newest 50 runs are kept');
    await expect(confirm).toContainText('would remove 1 of your saved run');
    // Nothing happened yet.
    expect(await saved(page)).toBe(before);
    await expect(page.getByTestId('history-import')).toBeDisabled();

    await page.getByTestId('history-confirm-no').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(50);
    expect(await ids(page)).toEqual(seeded);
    expect(await saved(page)).toBe(before);
    await expect(page.getByTestId('history-import')).toBeEnabled();
    await page.reload();
    expect(await ids(page)).toEqual(seeded);
  });

  test('"Import" in the confirmation imports, dropping the oldest, and says so', async ({ page }) => {
    const run = await baseRun(page);
    const seeded = await seed(page, run, 50);
    await importText(page, fileOf([{ ...run, id: 'newcomer', time: '2030-01-01T00:00:00.000Z' }]));
    await expect(page.getByTestId('history-confirm')).toContainText('would remove 1 of your saved run');
    await page.getByTestId('history-confirm-yes').click();
    await expect(page.getByTestId('history-confirm')).toHaveCount(0);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run; 1 oldest dropped (limit 50).');
    await expect(page.getByTestId('history-item')).toHaveCount(50);
    expect(await ids(page)).toEqual(['newcomer', ...seeded.slice(0, 49)]);
    await page.reload();
    expect(await ids(page)).toEqual(['newcomer', ...seeded.slice(0, 49)]);
  });

  test('the question counts the runs lost', async ({ page }) => {
    const run = await baseRun(page);
    await seed(page, run, 49);
    const extra = Array.from({ length: 3 }, (_, i) => ({ ...run, id: `new-${i}`, time: new Date(Date.UTC(2030, 0, 1, i)).toISOString() }));
    await importText(page, fileOf(extra));
    await expect(page.getByTestId('history-confirm')).toContainText('would remove 2 of your saved runs');
  });

  test('an import that fits (even exactly) needs no confirmation', async ({ page }) => {
    const run = await baseRun(page);
    await seed(page, run, 49);
    await importText(page, fileOf([{ ...run, id: 'last-one', time: '2030-01-01T00:00:00.000Z' }]));
    await expect(page.getByTestId('history-confirm')).toHaveCount(0);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run.');
    await expect(page.getByTestId('history-item')).toHaveCount(50);
  });

  test('an import older than everything saved, into a full history, drops itself: no confirmation, a message', async ({ page }) => {
    const run = await baseRun(page);
    const seeded = await seed(page, run, 50);
    await importText(page, fileOf([{ ...run, id: 'ancient', time: '2000-01-01T00:00:00.000Z' }]));
    await expect(page.getByTestId('history-confirm')).toHaveCount(0);
    await expect(page.getByTestId('history-message')).toContainText('1 oldest dropped (limit 50)');
    expect(await ids(page)).toEqual(seeded);
  });
});
