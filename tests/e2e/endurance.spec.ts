import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// M7: Endurance and Stress (docs/SPEC.md, section 4, "How it works (M7)"). Test-only run length: `?endurance=30s` (6 windows
// of 5 s, after a 3 s start delay), smoke sizes. A full run takes about 40 s, so the tests that finish one are few and
// the rest cancel early. Nothing here asserts on speed, only on structure and on what the page does.

const URL = '/?smoke&endurance=30s';
const KEY = 'browser-bench:history';
const DROP = /^-?\d+\.\d%$/;
const FIGURE = /^(—|-?\d+\.\d%)$/;

interface EndRec {
  id: string;
  mode: string;
  components: unknown[];
  endurance: {
    durationMs: number;
    windowMs: number;
    hidden: number[];
    unfocused?: number[];
    notes?: string[];
    parts: {
      id: string;
      label: string;
      workers: number;
      keys: string[];
      base: (number | null)[];
      values: (number | null)[];
      drop: number | null;
      burst: number | null;
      noisy: boolean;
      missed?: number[];
      error?: string;
    }[];
  };
  partial?: boolean;
}
interface ExportFile {
  format: string;
  schema: number;
  runs: EndRec[];
}

/**
 * The figures of docs/SPEC.md, 4, worked out here from a saved series (independent of the app's code): with N windows,
 * m = min(12, floor(N / 3)); minute 1 = [0, m), minute 2 = [m, 2m), last minute = [N - m, N); valid windows only.
 * burst = 1 - median(minute 2) / first valid window of minute 1; drop = 1 - median(last minute) / median(minute 2).
 */
function figures(values: (number | null)[]): { burst: number | null; drop: number | null } {
  const n = values.length;
  const m = Math.min(12, Math.floor(n / 3));
  if (m < 1) return { burst: null, drop: null };
  const valid = (a: number, b: number) => values.slice(a, b).filter((v): v is number => v !== null);
  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
  };
  const m1 = valid(0, m);
  const m2 = valid(m, 2 * m);
  const last = valid(n - m, n);
  const burst = m1.length && m2.length && m1[0]! > 0 ? 1 - median(m2) / m1[0]! : null;
  const drop = m2.length && last.length && median(m2) > 0 ? 1 - median(last) / median(m2) : null;
  return { burst, drop };
}

const saved = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), KEY);
const stored = async (page: Page): Promise<ExportFile> => JSON.parse((await saved(page)) ?? 'null') as ExportFile;

async function start(page: Page, parts: string[] = ['cpu-single'], mode: 'endurance' | 'stress' = 'endurance'): Promise<void> {
  await page.goto(URL);
  await expect(page.getByTestId('history')).toBeVisible();
  for (const id of ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage']) {
    await page.getByTestId(`component-${id}`).setChecked(parts.includes(id));
  }
  await page.getByTestId(`mode-${mode}`).check();
}

/** Runs until the Endurance run has started its loop (the progress line shows the clock). */
async function running(page: Page): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('progress')).toContainText(/Endurance|Stress/, { timeout: 30_000 });
}
const clockAt = (page: Page, text: RegExp, timeout = 30_000) => expect(page.getByTestId('progress')).toHaveText(text, { timeout });

/** The app is idle: Run is back, nothing is running, nothing is saved. */
async function expectIdleNothingSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('run')).toBeVisible();
  await expect(page.getByTestId('run')).toBeEnabled();
  await expect(page.getByTestId('cancel')).toHaveCount(0);
  await expect(page.getByTestId('stop')).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveCount(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('history-item')).toHaveCount(0);
  expect(await saved(page)).toBeNull();
}

async function importText(page: Page, text: string): Promise<void> {
  await page.getByTestId('history-import').setInputFiles({ name: 'in.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}
const fileOf = (runs: unknown[]) => JSON.stringify({ format: 'browser-bench', schema: 1, runs });

test.describe('M7 mode controls', () => {
  test('Endurance shows the 10 / 30 / 60 min choice; the test length replaces it with ?endurance=', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('mode-endurance').check();
    const sel = page.getByTestId('endurance-minutes');
    await expect(sel).toBeVisible();
    await expect(sel.locator('option')).toHaveText(['10 min', '30 min', '60 min']);
    await expect(page.getByText('storage is not looped')).toBeVisible();
    await page.goto(URL);
    await page.getByTestId('mode-endurance').check();
    await expect(page.getByTestId('endurance-minutes')).toHaveCount(0);
    await expect(page.getByText('(test length: 30 s)')).toBeVisible();
    // The choice is only for looping modes: Quick does not show the note.
    await page.getByTestId('mode-quick').check();
    await expect(page.getByText('storage is not looped')).toHaveCount(0);
  });

  test('Storage alone cannot be looped: Run stays disabled in Endurance and Stress', async ({ page }) => {
    await start(page, ['storage']);
    await expect(page.getByTestId('run')).toBeDisabled();
    await page.getByTestId('mode-stress').check();
    await expect(page.getByTestId('run')).toBeDisabled();
    await page.getByTestId('mode-quick').check();
    await expect(page.getByTestId('run')).toBeEnabled();
  });
});

test.describe('M7 Endurance run', () => {
  test('finishes, shows the chart and a drop row per part, is saved, and round-trips through export and import', async ({ page }) => {
    test.setTimeout(150_000);
    await start(page, ['cpu-single', 'cpu-multi', 'memory']);
    await page.getByTestId('workers').fill('2');
    await running(page);
    await expect(page.getByTestId('wake')).toBeVisible();

    // The chart shows while it runs (lazy-loaded, drawn once a second).
    await expect(page.getByTestId('endurance-chart')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cancel')).toBeVisible();
    await expect(page.getByTestId('history-import')).toBeDisabled();
    // Storage is not looped and no storage section appears.
    await expect(page.getByRole('heading', { name: 'Storage' })).toHaveCount(0);

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Endurance' })).toBeVisible();
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
    for (const id of ['cpu-single', 'cpu-multi', 'memory']) {
      const row = page.getByTestId(`endurance-row-${id}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId('endurance-drop')).toHaveText(DROP);
      await expect(row.getByTestId('endurance-burst')).toHaveText(FIGURE);
    }
    await expect(page.getByTestId('endurance-row-cpu-multi')).toContainText('2 workers');
    await expect(page.getByTestId('endurance-row-cpu-single')).toContainText('1 worker');
    await expect(page.getByTestId('endurance-row-memory')).toContainText('Memory — all-cores copy');
    await expect(page.getByTestId('endurance-hidden-note')).toHaveCount(0); // the tab was never hidden
    await expect(page.getByTestId('endurance-unfocused-note')).toHaveCount(0); // and never lost focus (Playwright reports focus)
    await expect(page.getByTestId('endurance-notes')).toHaveCount(0); // nothing to say: focus known, every part looped
    await expect(page.getByTestId('endurance-error')).toHaveCount(0);
    // No points in Endurance: the points block is not shown.
    await expect(page.getByTestId('points')).toHaveCount(0);
    await expect(page.getByTestId('wake')).toHaveCount(0); // the wake line goes with the run

    // History: one Endurance record, labelled with its length and its drops.
    const item = page.getByTestId('history-item');
    await expect(item).toHaveCount(1);
    await expect(item.locator('td').nth(1)).toHaveText('Endurance 30 s · smoke');
    await expect(page.getByTestId('history-total')).toHaveText(/^drop -?\d+\.\d% \/ -?\d+\.\d% \/ -?\d+\.\d%$/);
    const file = await stored(page);
    expect(file.runs).toHaveLength(1);
    const rec = file.runs[0]!;
    expect(rec).toMatchObject({ mode: 'endurance', components: [], partial: false });
    expect(rec.endurance).toMatchObject({ durationMs: 30_000, windowMs: 5_000, hidden: [], unfocused: [] });
    expect(rec.endurance.notes ?? []).toEqual([]); // Playwright emulates focus: it must not read as "focus unknown"
    expect(rec.endurance.parts.map((p) => p.id)).toEqual(['cpu-single', 'cpu-multi', 'memory']);
    for (const p of rec.endurance.parts) {
      expect(p.values.length).toBeGreaterThanOrEqual(1);
      expect(p.values.length).toBeLessThanOrEqual(6);
      expect(p.keys.length).toBeGreaterThan(0);
      expect(p.base).toHaveLength(p.keys.length);
      expect(p.values.find((v) => v !== null)).toBe(1); // the first valid window is the 100% line
      expect(p.drop).not.toBeNull();
      // Both figures are the ones the series gives; noisy is a flag; one missed count per worker.
      const f = figures(p.values);
      expect(p.drop!).toBeCloseTo(f.drop!, 9);
      if (f.burst === null) expect(p.burst).toBeNull();
      else expect(p.burst!).toBeCloseTo(f.burst, 9);
      expect(typeof p.noisy).toBe('boolean');
      expect(p.error).toBeUndefined();
      expect(p.missed).toHaveLength(p.workers);
      for (const n of p.missed!) expect(Number.isInteger(n) && n >= 0).toBe(true);
    }

    // Round trip: export it, clear, import it back; the saved history is byte-identical.
    const before = await saved(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('history-export').click()]);
    const text = readFileSync((await dl.path())!, 'utf8');
    expect((JSON.parse(text) as ExportFile).runs[0]!.endurance.parts).toHaveLength(3);
    const clear = page.getByTestId('history-clear');
    await clear.click();
    await clear.click();
    await expect(page.getByTestId('history-empty')).toBeVisible();
    await importText(page, text);
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run.');
    expect(await saved(page)).toBe(before);

    // And it opens from History after a reload: chart and rows from the saved block.
    await page.reload();
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('endurance-chart')).toHaveCount(0);
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
    await expect(page.getByTestId('endurance-row-memory').getByTestId('endurance-drop')).toHaveText(DROP);
    await expect(page.getByTestId('points')).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(1); // opening is read-only
  });
});

test.describe('M7 No live updates', () => {
  test('the page text stops changing while the switch is on, and moves again when it is off', async ({ page }) => {
    test.setTimeout(90_000);
    await start(page);
    await running(page);
    await clockAt(page, /Endurance · 0:0[1-9] \/ 0:30/); // the clock ticks once a second
    await expect(page.getByTestId('endurance-chart')).toBeVisible({ timeout: 15_000 });
    // Let the wake-lock state settle, then freeze.
    await page.getByTestId('no-live').check();
    await page.waitForTimeout(1_200);
    const body = () => page.evaluate(() => document.body.innerText);
    const frozen = await body();
    const progress = (await page.getByTestId('progress').innerText()).trim();
    await page.waitForTimeout(3_500);
    expect(await body()).toBe(frozen);
    expect((await page.getByTestId('progress').innerText()).trim()).toBe(progress);

    // Off again: updates resume within a second or two.
    await page.getByTestId('no-live').uncheck();
    await expect.poll(async () => (await page.getByTestId('progress').innerText()).trim(), { timeout: 5_000 }).not.toBe(progress);

    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
  });

  test('switched on before the run: no chart and no clock until the run ends; the final result still shows', async ({ page }) => {
    test.setTimeout(120_000);
    await start(page);
    await page.getByTestId('no-live').check();
    await running(page);
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1_000);
      await expect(page.getByTestId('progress')).toHaveText('Endurance');
      await expect(page.getByTestId('endurance-chart')).toHaveCount(0);
    }
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
    await expect(page.getByTestId('endurance-row-cpu-single').getByTestId('endurance-drop')).toHaveText(DROP);
    await expect(page.getByTestId('history-item')).toHaveCount(1);
  });
});

test.describe('M7 Stress', () => {
  test('Stop ends the run, shows the result, and saves nothing', async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, ['cpu-single'], 'stress');
    await running(page);
    await expect(page.getByTestId('cancel')).toHaveCount(0); // Stress has Stop
    const stop = page.getByTestId('stop');
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId('progress')).toHaveText(/^Stress · 0:/, { timeout: 15_000 });
    // Long enough for the 3 s start delay and a window or two.
    await clockAt(page, /^Stress · 0:(1[0-9]|[2-5][0-9])$/);
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
    await stop.click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 20_000 });
    await expect(page.getByTestId('stop')).toHaveCount(0);
    await expect(page.getByTestId('progress')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Stress' })).toBeVisible();
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
    await expect(page.getByTestId('endurance-row-cpu-single')).toBeVisible();
    await expect(page.getByTestId('error')).toHaveCount(0);
    // Shown, not saved.
    await expect(page.getByTestId('history-item')).toHaveCount(0);
    expect(await saved(page)).toBeNull();
    // Stopped for good: nothing starts again by itself, and the page is usable.
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId('stop')).toHaveCount(0);
    await expect(page.getByTestId('progress')).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(0);
    await expect(page.getByTestId('run')).toBeEnabled();
  });

  test('Stop works before the first window as well', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page, ['cpu-single'], 'stress');
    await running(page);
    await expect(page.getByTestId('stop')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('stop').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 20_000 });
    await expect(page.getByTestId('stop')).toHaveCount(0);
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(0);
    expect(await saved(page)).toBeNull();
    await expect(page.getByTestId('run')).toBeEnabled();
  });
});

test.describe('M7 Cancel', () => {
  test('during the start delay: the app is idle, nothing is saved', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    await running(page); // loops are starting; window 0 is at least 3 s away
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
    await expectIdleNothingSaved(page);
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('progress')).toHaveCount(0);
  });

  test('during the loop: the app is idle, nothing is saved, no storage files appear, and Benchmark runs afterwards', async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, ['cpu-single', 'storage']); // storage is never looped
    const entries = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const out: string[] = [];
        for await (const [name] of root.entries()) out.push(name);
        return out.sort();
      });
    const before = await entries();
    await running(page);
    await clockAt(page, /Endurance · 0:(0[6-9]|1[0-9]) \/ 0:30/); // past the start delay, in the loop
    expect(await entries()).toEqual(before);
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
    await expectIdleNothingSaved(page);
    expect(await entries()).toEqual(before);
    // What was measured so far stays on screen, labelled as the Endurance view, but is not saved.
    await expect(page.getByRole('heading', { name: 'Endurance' })).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('status')).toHaveText('Cancelled');
    await expect(page.getByTestId('history-item')).toHaveCount(0);

    // The workers are gone and the state is clean: a Quick run finishes and is saved normally.
    await page.getByTestId('mode-quick').check();
    await page.getByTestId('component-storage').setChecked(false);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('endurance-chart')).toHaveCount(0);
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await expect(page.getByTestId('history-total')).toHaveText('smoke: no points');
  });

  test('cancelling twice in a row, then starting again, works', async ({ page }) => {
    test.setTimeout(90_000);
    await start(page);
    for (let i = 0; i < 2; i++) {
      await running(page);
      await page.getByTestId('cancel').click();
      await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
      await expect(page.getByTestId('run')).toBeEnabled();
    }
    await expectIdleNothingSaved(page);
  });
});

test.describe('M7 hidden tab', () => {
  test('a hidden period marks the affected windows invalid: grey note on the chart, nulls in the saved series', async ({ page }) => {
    test.setTimeout(150_000);
    await start(page);
    await running(page);
    await clockAt(page, /Endurance · 0:0[5-9] \/ 0:30/);
    // Emulate the tab being hidden (the real one stays in front: only what the page sees changes).
    const setHidden = (hidden: boolean) =>
      page.evaluate((h) => {
        if (h) {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        } else {
          delete (document as unknown as Record<string, unknown>)['hidden'];
          delete (document as unknown as Record<string, unknown>)['visibilityState'];
        }
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await setHidden(true);
    await page.waitForTimeout(7_000); // more than one 5 s window
    await setHidden(false);

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('endurance-hidden-note')).toBeVisible();
    await expect(page.getByTestId('endurance-hidden-note')).toContainText('tab hidden');
    await expect(page.getByTestId('endurance-chart')).toBeVisible();

    const rec = (await stored(page)).runs[0]!;
    const part = rec.endurance.parts[0]!;
    expect(rec.endurance.hidden.length).toBeGreaterThanOrEqual(1);
    for (const i of rec.endurance.hidden) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(part.values.length);
      expect(part.values[i], `window ${i} overlaps the hidden period`).toBeNull();
    }
    // Hidden windows are excluded from the base: the first valid window is the 100% line, and it is not a hidden one.
    const first = part.values.findIndex((v) => v !== null);
    if (first >= 0) {
      expect(part.values[first]).toBe(1);
      expect(rec.endurance.hidden).not.toContain(first);
    }
    // Both figures are computed over valid windows only (thirds of the 6 windows): null, or exactly what the series gives.
    const f = figures(part.values);
    if (f.drop === null) expect(part.drop).toBeNull();
    else expect(part.drop!).toBeCloseTo(f.drop, 9);
    if (f.burst === null) expect(part.burst).toBeNull();
    else expect(part.burst!).toBeCloseTo(f.burst, 9);
    await expect(page.getByTestId('endurance-drop')).toHaveText(part.drop === null ? '—' : DROP);
    await expect(page.getByTestId('endurance-burst')).toHaveText(part.burst === null ? '—' : DROP);
    // Hiding the tab says nothing about focus.
    expect(rec.endurance.unfocused).toEqual([]);
    await expect(page.getByTestId('endurance-unfocused-note')).toHaveCount(0);

    // The note survives saving: open the run after a reload.
    await page.reload();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-hidden-note')).toBeVisible();
  });
});

// A hand-written record, to test loading without waiting for a run.
const seeded = (over: Record<string, unknown> = {}, part: Record<string, unknown> = {}) => ({
  schema: 1,
  id: 'seeded-endurance',
  time: '2026-11-10T10:00:00.000Z',
  mode: 'endurance',
  endurance: {
    durationMs: 30_000,
    windowMs: 5_000,
    hidden: [2],
    parts: [
      {
        id: 'cpu-single',
        label: 'CPU — single core',
        workers: 1,
        keys: ['sha256'],
        units: ['MB/s'],
        base: [321.5],
        values: [1, 1, null, 0.9, 0.8, 0.6],
        drop: 0.99,
        ...part,
      },
    ],
  },
  size: 'smoke',
  scoreVersion: 1,
  system: { browser: 'Chrome', version: '1', ua: 'x', cores: 8, screen: '1x1@1', isolated: true },
  components: [],
  total: null,
  partial: false,
  ...over,
});

test.describe('M7 saved Endurance records', () => {
  test('a forged drop is recomputed on import and on load; the list and the opened run show the real one', async ({ page }) => {
    await page.goto('/?smoke');
    await importText(page, fileOf([seeded()]));
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run.');
    // [1, 1, null, .9, .8, .6]: 6 windows, m = 2. Minute 2 = [null, .9] -> median .9; last = [.8, .6] -> median .7.
    // Sustained drop = 1 - .7 / .9 = 22.2%; burst -> sustained = 1 - .9 / 1 (the first window) = 10.0%.
    await expect(page.getByTestId('history-total')).toHaveText('drop 22.2%');
    await expect(page.getByTestId('history-item').locator('td').nth(1)).toHaveText('Endurance 30 s · smoke');
    const drop = async () => (await stored(page)).runs[0]!.endurance.parts[0]!.drop!;
    expect(await drop()).toBeCloseTo(1 - 0.7 / 0.9, 9);
    const p0 = async () => (await stored(page)).runs[0]!.endurance.parts[0]!;
    expect((await p0()).burst!).toBeCloseTo(0.1, 9);
    expect((await p0()).noisy).toBe(true); // the last minute [.8, .6]: IQR 0.1 over median 0.7 is above 10 %

    // Tamper with the saved history (every figure), then reload.
    await page.evaluate((k) => {
      const f = JSON.parse(localStorage.getItem(k)!);
      Object.assign(f.runs[0].endurance.parts[0], { drop: 0.01, burst: 0.9, noisy: false });
      localStorage.setItem(k, JSON.stringify(f));
    }, KEY);
    await page.reload();
    await expect(page.getByTestId('history-total')).toHaveText('drop 22.2%');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-drop')).toHaveText('22.2%');
    await expect(page.getByTestId('endurance-burst')).toHaveText('10.0%');
    await expect(page.getByTestId('endurance-noisy')).toBeVisible();
    await expect(page.getByTestId('endurance-hidden-note')).toBeVisible();
    await expect(page.getByTestId('endurance-row-cpu-single')).toContainText('CPU — single core');
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
  });

  test('invalid blocks are refused with a message and change nothing', async ({ page }) => {
    await page.goto('/?smoke');
    const msg = page.getByTestId('history-message');
    const many = Array.from({ length: 1001 }, () => 1);
    /** A seeded record with the block (or its first part) edited by `fn`. */
    const edited = (fn: (e: { [k: string]: any; parts: { [k: string]: any }[] }) => void): unknown => {
      const r = seeded() as { endurance: { [k: string]: any; parts: { [k: string]: any }[] } };
      fn(r.endurance);
      return r;
    };
    const cases: [string, unknown][] = [
      ['unequal lengths', seeded({}, { units: [] })],
      ['more than 1000 windows', seeded({}, { values: many })],
      ['more values than the run had windows', seeded({}, { values: [1, 1, 1, 1, 1, 1, 1] })],
      ['a negative value', seeded({}, { values: [1, -0.5] })],
      ['a block on a Quick record', seeded({ mode: 'quick' })],
      ['Endurance without a block', (({ endurance: _e, ...r }) => r)(seeded())],
      ['windowMs other than 5000', edited((e) => (e.windowMs = 1_000))],
      ['a duplicate hidden index', edited((e) => (e.hidden = [2, 2]))],
      ['a hidden index past the series', edited((e) => (e.hidden = [6]))],
      ['a duplicate unfocused index', edited((e) => (e.unfocused = [1, 1]))],
      ['an unfocused index past the series', edited((e) => (e.unfocused = [6]))],
      ['missed with the wrong length', seeded({}, { missed: [0, 0] })],
      ['a negative missed count', seeded({}, { missed: [-1] })],
      ['21 notes', edited((e) => (e.notes = Array.from({ length: 21 }, (_, i) => `note ${i}`)))],
      ['a duplicate part id', edited((e) => e.parts.push({ ...e.parts[0]! }))],
    ];
    for (const [name, rec] of cases) {
      await importText(page, fileOf([rec]));
      await expect(msg, name).toContainText(/Run 1 .*not valid/);
      await expect(page.getByTestId('history-item'), name).toHaveCount(0);
      expect(await saved(page), name).toBeNull();
    }
  });

  test('a record with all windows invalid shows "—" for its drop', async ({ page }) => {
    await page.goto('/?smoke');
    await importText(page, fileOf([seeded({}, { values: [null, null, null], base: [null], hidden: [] })]));
    await expect(page.getByTestId('history-total')).toHaveText('drop —');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-drop')).toHaveText('—');
    await expect(page.getByTestId('endurance-burst')).toHaveText('—');
    await expect(page.getByTestId('endurance-noisy')).toBeVisible(); // nothing valid in minute 2
  });

  test('a zero minute 2 gives "—", never NaN or Infinity', async ({ page }) => {
    await page.goto('/?smoke');
    await importText(page, fileOf([seeded({}, { values: [0, 0, 0, 0, 1, 1], drop: 0.5 })]));
    await expect(page.getByTestId('history-total')).toHaveText('drop —');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-burst')).toHaveText('—');
    await expect(page.getByTestId('endurance-results')).not.toContainText(/NaN|Infinity/);
  });

  test('unfocused windows, notes, missed slices and a part error show on a saved run, and survive a reload', async ({ page }) => {
    await page.goto('/?smoke');
    const note = 'GPU: not looped, this browser offers neither WebGPU nor WebGL2.';
    const rec = seeded({}, { workers: 2, missed: [0, 3] }) as { endurance: { [k: string]: unknown } };
    Object.assign(rec.endurance, { unfocused: [4], notes: [note] });
    await importText(page, fileOf([rec]));
    await expect(page.getByTestId('history-message')).toHaveText('Imported 1 run.');
    const file = await stored(page);
    expect(file.runs[0]).toMatchObject({ partial: false });
    expect(file.runs[0]!.endurance).toMatchObject({ hidden: [2], unfocused: [4], notes: [note] });
    expect(file.runs[0]!.endurance.parts[0]!.missed).toEqual([0, 3]);
    await page.reload();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-unfocused-note')).toBeVisible();
    await expect(page.getByTestId('endurance-hidden-note')).toBeVisible();
    await expect(page.getByTestId('endurance-notes')).toHaveText(note);
    await expect(page.getByTestId('endurance-missed')).toContainText('3 slices missed (worst worker 3)');
  });

  test('a part with an error has no figures, whatever its series (and a saved noisy flag is not trusted)', async ({ page }) => {
    await page.goto('/?smoke');
    await importText(page, fileOf([seeded({}, { error: 'checksum mismatch in sha256: result invalid', drop: 0.4, burst: 0.4, noisy: true })]));
    await expect(page.getByTestId('history-total')).toHaveText('drop —');
    const part = (await stored(page)).runs[0]!.endurance.parts[0]!;
    expect(part).toMatchObject({ drop: null, burst: null, noisy: false });
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-error')).toHaveText('checksum mismatch in sha256: result invalid');
    await expect(page.getByTestId('endurance-drop')).toHaveText('—');
    await expect(page.getByTestId('endurance-burst')).toHaveText('—');
    await expect(page.getByTestId('endurance-noisy')).toHaveCount(0);
  });

  test('an older record without unfocused, notes, missed, burst or noisy still opens, with its figures filled in', async ({ page }) => {
    await page.goto('/?smoke');
    await importText(page, fileOf([seeded()])); // the seeded part has only keys, units, base, values and a (forged) drop
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-burst')).toHaveText('10.0%');
    await expect(page.getByTestId('endurance-unfocused-note')).toHaveCount(0);
    await expect(page.getByTestId('endurance-notes')).toHaveCount(0);
    await expect(page.getByTestId('endurance-missed')).toHaveCount(0);
  });
});

test.describe('M7 Wake Lock', () => {
  /** Init script: replaces navigator.wakeLock with a fake that grants, refuses, or does not exist. */
  const fakeWakeLock = (_mode: 'grant' | 'deny' | 'none') => (m: string) => {
    const w = window as unknown as { __locks: { released: boolean }[] };
    w.__locks = [];
    if (m === 'none') {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => undefined });
      return;
    }
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      get: () => ({
        request: async (type: string) => {
          if (m === 'deny') throw new DOMException('denied', 'NotAllowedError');
          if (type !== 'screen') throw new Error('not a screen lock');
          const s = {
            released: false,
            release: async () => {
              s.released = true;
            },
          };
          w.__locks.push(s);
          return s;
        },
      }),
    });
  };

  test('granted: "screen kept on" while running, released when the run is cancelled', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(fakeWakeLock('grant'), 'grant');
    await start(page);
    await running(page);
    await expect(page.getByTestId('wake')).toHaveText('screen kept on');
    expect(await page.evaluate(() => (window as unknown as { __locks: { released: boolean }[] }).__locks.map((l) => l.released))).toEqual([false]);
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __locks: { released: boolean }[] }).__locks.every((l) => l.released))).toBe(true);
  });

  for (const [name, mode] of [
    ['refused', 'deny'],
    ['unsupported', 'none'],
  ] as const) {
    test(`${name}: the run goes on, and Endurance says the screen may sleep`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.addInitScript(fakeWakeLock(mode), mode);
      await start(page);
      await running(page);
      await expect(page.getByTestId('wake')).toHaveText('the screen may sleep (no wake lock)');
      await clockAt(page, /Endurance · 0:0[1-9] \/ 0:30/); // still running
      await page.getByTestId('cancel').click();
      await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
      await expect(page.getByTestId('wake')).toHaveCount(0);
    });
  }

  test('Benchmark mode never writes the wake state to the page, and still takes and releases a lock', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(fakeWakeLock('grant'), 'grant');
    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
    await expect(page.getByTestId('wake')).toHaveCount(0);
    await expect(page.getByText('screen kept on')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __locks: { released: boolean }[] }).__locks.map((l) => l.released))).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Window focus. Playwright emulates focus (document.hasFocus() is true and no blur/focus event ever fires), so these tests
// replace hasFocus() with a switch the test controls and dispatch the window's own `blur` / `focus` events, which is what
// the page listens to (docs/SPEC.md, 4, "Window not in front").

/** Init script: `document.hasFocus()` reads `window.__focus`; the test flips it with setFocus(). */
const fakeFocus = (_initial: boolean) => (on: boolean) => {
  const w = window as unknown as { __focus: boolean };
  w.__focus = on;
  document.hasFocus = () => w.__focus;
};
/** The window loses or gains focus: hasFocus() changes and the matching event fires. */
const setFocus = (page: Page, on: boolean) =>
  page.evaluate((v) => {
    (window as unknown as { __focus: boolean }).__focus = v;
    window.dispatchEvent(new Event(v ? 'focus' : 'blur'));
  }, on);

test.describe('M7 window focus: Endurance', () => {
  test('a period without focus marks the windows it touches: hatched note, nulls in every part, saved indexes', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(fakeFocus(true), true);
    await start(page, ['cpu-single', 'memory']);
    await page.getByTestId('workers').fill('2');
    await running(page);
    await clockAt(page, /Endurance · 0:0[5-9] \/ 0:30/);
    await setFocus(page, false); // another window comes to the front
    await page.waitForTimeout(7_000); // more than one 5 s window; the 1 s poll sees hasFocus() = false too
    await setFocus(page, true);

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('endurance-unfocused-note')).toBeVisible();
    await expect(page.getByTestId('endurance-unfocused-note')).toContainText('another window in front');
    await expect(page.getByTestId('endurance-hidden-note')).toHaveCount(0); // the tab stayed visible
    await expect(page.getByTestId('endurance-chart')).toBeVisible();

    const rec = (await stored(page)).runs[0]!;
    const unfocused = rec.endurance.unfocused ?? [];
    expect(unfocused.length).toBeGreaterThanOrEqual(1);
    expect(rec.endurance.hidden).toEqual([]);
    expect(new Set(unfocused).size).toBe(unfocused.length);
    expect(rec.endurance.parts.map((p) => p.id)).toEqual(['cpu-single', 'memory']);
    for (const part of rec.endurance.parts) {
      for (const i of unfocused) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(part.values.length);
        expect(part.values[i], `${part.id}: window ${i} overlaps the unfocused period`).toBeNull();
      }
      // The base (the 100% line) is a valid window, never an unfocused one.
      const first = part.values.findIndex((v) => v !== null);
      if (first >= 0) {
        expect(part.values[first]).toBe(1);
        expect(unfocused).not.toContain(first);
      }
      // Figures come from the valid windows only.
      const f = figures(part.values);
      if (f.drop === null) expect(part.drop).toBeNull();
      else expect(part.drop!).toBeCloseTo(f.drop, 9);
    }
    // Focus was known (it was there at the start), so there is no "focus unknown" note.
    expect((rec.endurance.notes ?? []).filter((n) => /focus/i.test(n))).toEqual([]);
    await expect(page.getByTestId('endurance-notes')).toHaveCount(0);

    // The hatched note survives saving: open the run after a reload.
    await page.reload();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-unfocused-note')).toBeVisible();
  });

  test('focus unknown (the window never had focus): nothing is invalidated, a note says so, shown and saved', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(fakeFocus(false), false);
    await start(page);
    await running(page);
    await clockAt(page, /Endurance · 0:0[5-9] \/ 0:30/);
    await setFocus(page, false); // a blur from a window that never had focus is not a loss
    await page.waitForTimeout(6_000);

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('endurance-unfocused-note')).toHaveCount(0);
    await expect(page.getByTestId('endurance-notes')).toContainText('Window focus unknown');
    const rec = (await stored(page)).runs[0]!;
    expect(rec.endurance.unfocused).toEqual([]);
    expect(rec.endurance.hidden).toEqual([]);
    expect(rec.endurance.notes).toHaveLength(1);
    expect(rec.endurance.notes![0]).toMatch(/focus unknown/i);
    expect(rec.endurance.parts[0]!.values.find((v) => v !== null)).toBe(1);

    // The note is part of the saved run.
    await page.reload();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-notes')).toContainText('Window focus unknown');
  });

  test('focus that arrives mid-run starts the tracking: a later loss counts, the earlier unknown time does not', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(fakeFocus(false), false);
    await start(page);
    await running(page);
    await clockAt(page, /Endurance · 0:0[3-9] \/ 0:30/);
    await setFocus(page, true); // the user clicks the window: from here on it is tracked
    await page.waitForTimeout(1_500);
    await setFocus(page, false);
    await page.waitForTimeout(6_000);
    await setFocus(page, true);

    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    const rec = (await stored(page)).runs[0]!;
    expect((rec.endurance.unfocused ?? []).length).toBeGreaterThanOrEqual(1);
    for (const i of rec.endurance.unfocused ?? []) expect(rec.endurance.parts[0]!.values[i]).toBeNull();
    // Focus is known by the end, so no "unknown" note.
    expect((rec.endurance.notes ?? []).filter((n) => /focus unknown/i.test(n))).toEqual([]);
  });
});

test.describe('M7 window focus: the hint and Benchmark mode', () => {
  test('"Keep this window in front during the run." shows for Endurance and Stress, not for Quick or Full, and next to the clock', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(URL);
    const hint = page.getByTestId('focus-hint');
    await expect(hint).toHaveCount(0); // Quick is the default mode
    await page.getByTestId('mode-full').check();
    await expect(hint).toHaveCount(0);
    await page.getByTestId('mode-endurance').check();
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Keep this window in front during the run.');
    await page.getByTestId('mode-stress').check();
    await expect(hint).toBeVisible();
    await page.getByTestId('mode-quick').check();
    await expect(hint).toHaveCount(0);

    // While it runs, the reminder is beside the clock.
    for (const id of ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage']) await page.getByTestId(`component-${id}`).setChecked(id === 'cpu-single');
    await page.getByTestId('mode-endurance').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('progress')).toContainText(/Endurance/, { timeout: 30_000 });
    await expect(page.locator('p', { has: page.getByTestId('progress') })).toContainText('keep this window in front');
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('status')).toHaveText('Cancelled', { timeout: 15_000 });
  });

  test('Benchmark mode: a run during which the window lost focus ends with a note, which is not saved', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(fakeFocus(true), true);
    await page.goto('/?smoke');
    await expect(page.getByTestId('history')).toBeVisible();
    for (const id of ['cpu-multi', 'memory', 'gpu', 'storage']) await page.getByTestId(`component-${id}`).setChecked(false);
    await page.getByTestId('component-cpu-single').setChecked(true);
    await expect(page.getByTestId('focus-lost')).toHaveCount(0);

    await page.getByTestId('run').click(); // the page listens from here on
    await setFocus(page, false);
    await setFocus(page, true);
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('focus-lost')).toBeVisible();
    await expect(page.getByTestId('focus-lost')).toContainText('lost focus');
    // Not saved: the record says nothing about focus.
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    expect(await saved(page)).not.toMatch(/focus/i);

    // The next run starts clean: no loss, no note.
    await page.getByTestId('run').click();
    await expect(page.getByTestId('progress')).toBeVisible();
    await expect(page.getByTestId('focus-lost')).toHaveCount(0); // nothing is written to the page mid-run
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('focus-lost')).toHaveCount(0);
  });

  test('Benchmark mode: a window that never had focus shows no note (focus unknown, as in automation)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(fakeFocus(false), false);
    await page.goto('/?smoke');
    for (const id of ['cpu-multi', 'memory', 'gpu', 'storage']) await page.getByTestId(`component-${id}`).setChecked(false);
    await page.getByTestId('run').click();
    await setFocus(page, false);
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('focus-lost')).toHaveCount(0);
  });

  test('Benchmark mode: no note when focus was never lost, as with the real automated window', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?smoke');
    for (const id of ['cpu-multi', 'memory', 'gpu', 'storage']) await page.getByTestId(`component-${id}`).setChecked(false);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('focus-lost')).toHaveCount(0);
  });
});

test.describe('M7 notes: a part that cannot loop', () => {
  /** Init script: neither WebGPU nor WebGL2, so a GPU part cannot loop. */
  const noGpu = () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined });
    const getContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as never;
  };

  test("the GPU part is named in the run's notes, shown, saved and shown again from History; the other parts still loop", async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(noGpu);
    await start(page, ['cpu-single', 'gpu']);
    await running(page);
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 90_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(page.getByTestId('endurance-notes')).toContainText('GPU: not looped');
    await expect(page.getByTestId('endurance-row-gpu')).toHaveCount(0);
    await expect(page.getByTestId('endurance-row-cpu-single')).toBeVisible();
    const rec = (await stored(page)).runs[0]!;
    expect(rec.endurance.parts.map((p) => p.id)).toEqual(['cpu-single']);
    expect(rec.endurance.notes).toEqual([expect.stringContaining('GPU: not looped')]);
    await page.reload();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-notes')).toContainText('GPU: not looped');
  });

  test('a GPU that cannot loop and nothing else to run: an error that says why, nothing saved', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(noGpu);
    await start(page, ['gpu']);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('error')).toContainText('GPU: not looped', { timeout: 30_000 });
    await expect(page.getByTestId('history-item')).toHaveCount(0);
    expect(await saved(page)).toBeNull();
    await expect(page.getByTestId('run')).toBeEnabled();
  });
});
