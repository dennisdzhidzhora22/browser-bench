import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// M7: Endurance and Stress (docs/SPEC.md, section 4, "How it works (M7)"). Test-only run length: `?endurance=30s` (6 windows
// of 5 s, after a 3 s start delay), smoke sizes. A full run takes about 40 s, so the tests that finish one are few and
// the rest cancel early. Nothing here asserts on speed, only on structure and on what the page does.

const URL = '/?smoke&endurance=30s';
const KEY = 'browser-bench:history';
const DROP = /^-?\d+\.\d%$/;

interface EndRec {
  id: string;
  mode: string;
  components: unknown[];
  endurance: {
    durationMs: number;
    windowMs: number;
    hidden: number[];
    parts: { id: string; label: string; workers: number; keys: string[]; base: (number | null)[]; values: (number | null)[]; drop: number | null }[];
  };
}
interface ExportFile {
  format: string;
  schema: number;
  runs: EndRec[];
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
    }
    await expect(page.getByTestId('endurance-row-cpu-multi')).toContainText('2 workers');
    await expect(page.getByTestId('endurance-row-cpu-single')).toContainText('1 worker');
    await expect(page.getByTestId('endurance-row-memory')).toContainText('Memory — all-cores copy');
    await expect(page.getByTestId('endurance-hidden-note')).toHaveCount(0); // the tab was never hidden
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
    expect(rec).toMatchObject({ mode: 'endurance', components: [] });
    expect(rec.endurance).toMatchObject({ durationMs: 30_000, windowMs: 5_000, hidden: [] });
    expect(rec.endurance.parts.map((p) => p.id)).toEqual(['cpu-single', 'cpu-multi', 'memory']);
    for (const p of rec.endurance.parts) {
      expect(p.values.length).toBeGreaterThanOrEqual(1);
      expect(p.values.length).toBeLessThanOrEqual(6);
      expect(p.keys.length).toBeGreaterThan(0);
      expect(p.base).toHaveLength(p.keys.length);
      expect(p.values.find((v) => v !== null)).toBe(1); // the first valid window is the 100% line
      expect(p.drop).not.toBeNull();
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
    // The drop is computed over valid windows only: null, or exactly what the valid windows give.
    const valid = part.values.filter((v): v is number => v !== null);
    if (valid.length < 2) expect(part.drop).toBeNull();
    else {
      const n = Math.min(12, Math.floor(valid.length / 2));
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(part.drop!).toBeCloseTo(1 - mean(valid.slice(-n)) / mean(valid.slice(0, n)), 9);
    }
    await expect(page.getByTestId('endurance-drop')).toHaveText(part.drop === null ? '—' : DROP);

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
    // 5 valid windows (1, 1, .9, .8, .6): n = 2, drop = 1 - mean(.8, .6) / mean(1, 1) = 30%.
    await expect(page.getByTestId('history-total')).toHaveText('drop 30.0%');
    await expect(page.getByTestId('history-item').locator('td').nth(1)).toHaveText('Endurance 30 s · smoke');
    const drop = async () => (await stored(page)).runs[0]!.endurance.parts[0]!.drop!;
    expect(await drop()).toBeCloseTo(0.3, 9);

    // Tamper with the saved history, then reload.
    await page.evaluate((k) => {
      const f = JSON.parse(localStorage.getItem(k)!);
      f.runs[0].endurance.parts[0].drop = 0.01;
      localStorage.setItem(k, JSON.stringify(f));
    }, KEY);
    await page.reload();
    await expect(page.getByTestId('history-total')).toHaveText('drop 30.0%');
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('endurance-drop')).toHaveText('30.0%');
    await expect(page.getByTestId('endurance-hidden-note')).toBeVisible();
    await expect(page.getByTestId('endurance-row-cpu-single')).toContainText('CPU — single core');
    await expect(page.getByTestId('endurance-chart')).toBeVisible();
  });

  test('invalid blocks are refused with a message and change nothing', async ({ page }) => {
    await page.goto('/?smoke');
    const msg = page.getByTestId('history-message');
    const many = Array.from({ length: 1001 }, () => 1);
    const cases: [string, unknown][] = [
      ['unequal lengths', seeded({}, { units: [] })],
      ['more than 1000 windows', seeded({}, { values: many })],
      ['a negative value', seeded({}, { values: [1, -0.5] })],
      ['a block on a Quick record', seeded({ mode: 'quick' })],
      ['Endurance without a block', (({ endurance: _e, ...r }) => r)(seeded())],
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
