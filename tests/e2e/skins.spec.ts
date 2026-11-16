import { expect, test, type Page } from '@playwright/test';

// M8: four switchable skins and light/dark/auto (src/ui/look.svelte.ts, index.html pre-paint script, the two
// selects in the top bar of App.svelte). Structure only; nothing here asserts on speed.

const SKINS = [
  ['clean', 'A · Clean'],
  ['terminal', 'B · Terminal'],
  ['vivid', 'C · Vivid'],
  ['minimal', 'D · Minimal'],
] as const;
const DEFAULT_SKIN = 'minimal';
const SKIN_KEY = 'browser-bench:skin';
const THEME_KEY = 'browser-bench:theme';

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

/** What <html> carries right now. */
const attrs = (page: Page) =>
  page.evaluate(() => ({ skin: document.documentElement.dataset['skin'], theme: document.documentElement.dataset['theme'] }));

/** Sets localStorage values (null removes the key) for the page's origin; takes effect on the next load. */
async function seed(page: Page, values: Record<string, string | null>) {
  await page.evaluate((v) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === null) localStorage.removeItem(k);
      else localStorage.setItem(k, x);
    }
  }, values);
}

test.describe('M8 skins', () => {
  test('defaults: Minimal skin, Auto theme, all four skins offered', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?smoke');
    await expect(page.getByTestId('skin')).toHaveValue(DEFAULT_SKIN);
    await expect(page.getByTestId('theme')).toHaveValue('auto');
    expect(await attrs(page)).toEqual({ skin: DEFAULT_SKIN, theme: 'light' });
    const options = await page.getByTestId('skin').locator('option').evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent]));
    expect(options).toEqual(SKINS.map(([id, label]) => [id, label]));
    await expect(page.getByTestId('theme').locator('option')).toHaveText(['Auto', 'Light', 'Dark']);
  });

  for (const [id, label] of SKINS) {
    test(`skin ${label} can be chosen, with light and dark, and the choice survives a reload`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/?smoke');
      await page.getByTestId('skin').selectOption(id);
      await expect(page.getByTestId('skin')).toHaveValue(id);
      expect((await attrs(page)).skin).toBe(id);

      await page.getByTestId('theme').selectOption('dark');
      expect(await attrs(page)).toEqual({ skin: id, theme: 'dark' });
      await page.getByTestId('theme').selectOption('light');
      expect(await attrs(page)).toEqual({ skin: id, theme: 'light' });
      await page.getByTestId('theme').selectOption('dark');

      await page.reload();
      await expect(page.getByTestId('isolated')).toBeVisible();
      await expect(page.getByTestId('skin')).toHaveValue(id);
      await expect(page.getByTestId('theme')).toHaveValue('dark');
      expect(await attrs(page)).toEqual({ skin: id, theme: 'dark' });
    });
  }

  test('a skin change keeps the theme choice, and a theme change keeps the skin', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('theme').selectOption('dark');
    await page.getByTestId('skin').selectOption('terminal');
    await expect(page.getByTestId('theme')).toHaveValue('dark');
    expect(await attrs(page)).toEqual({ skin: 'terminal', theme: 'dark' });
    await page.getByTestId('theme').selectOption('light');
    await expect(page.getByTestId('skin')).toHaveValue('terminal');
    expect(await attrs(page)).toEqual({ skin: 'terminal', theme: 'light' });
  });

  test('skin and theme are on <html> before first paint (set at DOMContentLoaded, before the app renders)', async ({ page }) => {
    // Registered for every load of this page. Records <html data-skin/data-theme> when each first appears and
    // whether the app had rendered anything by then, plus the values at DOMContentLoaded.
    await page.addInitScript(() => {
      const w = window as unknown as { __first: Record<string, { value: string | null; appRendered: boolean }>; __dcl: { skin?: string; theme?: string } };
      w.__first = {};
      new MutationObserver((records) => {
        for (const r of records) {
          const name = r.attributeName!;
          if (name in w.__first) continue;
          w.__first[name] = {
            value: (r.target as Element).getAttribute(name),
            appRendered: !!document.querySelector('#app > *'),
          };
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-skin', 'data-theme'] });
      document.addEventListener('DOMContentLoaded', () => {
        w.__dcl = { skin: document.documentElement.dataset['skin'], theme: document.documentElement.dataset['theme'] };
      });
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?smoke');
    await seed(page, { [SKIN_KEY]: 'vivid', [THEME_KEY]: 'dark' });
    await page.reload();
    await expect(page.getByTestId('isolated')).toBeVisible();

    const seen = await page.evaluate(() => {
      const w = window as unknown as { __first: Record<string, { value: string | null; appRendered: boolean }>; __dcl: { skin?: string; theme?: string } };
      return { first: w.__first, dcl: w.__dcl };
    });
    // The attributes were there at DOMContentLoaded already, with the saved values (not the defaults).
    expect(seen.dcl).toEqual({ skin: 'vivid', theme: 'dark' });
    // And they were first set before the app put anything on the page.
    expect(seen.first['data-skin']).toEqual({ value: 'vivid', appRendered: false });
    expect(seen.first['data-theme']).toEqual({ value: 'dark', appRendered: false });
  });

  test('without saved choices the first-paint attributes are the default skin and the OS theme', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __dcl: object }).__dcl = {
          skin: document.documentElement.dataset['skin'],
          theme: document.documentElement.dataset['theme'],
        };
      });
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?smoke');
    await expect(page.getByTestId('isolated')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __dcl: object }).__dcl)).toEqual({ skin: DEFAULT_SKIN, theme: 'dark' });
  });

  test('Auto follows the OS colour scheme, also while the page is open; an explicit choice does not', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?smoke');
    await expect(page.getByTestId('theme')).toHaveValue('auto');
    expect((await attrs(page)).theme).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await attrs(page)).theme).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await attrs(page)).theme).toBe('dark');

    // Explicit Light ignores the OS.
    await page.getByTestId('theme').selectOption('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect((await attrs(page)).theme).toBe('light');

    // Back to Auto: resolves to the OS right away, and a reload keeps Auto.
    await page.getByTestId('theme').selectOption('auto');
    expect((await attrs(page)).theme).toBe('dark');
    await page.reload();
    await expect(page.getByTestId('theme')).toHaveValue('auto');
    expect((await attrs(page)).theme).toBe('dark');
  });

  test('bad saved values fall back to the default skin and Auto', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?smoke');
    for (const [skin, theme] of [
      ['bogus', 'purple'],
      ['', ''],
      ['Clean', 'DARK'], // case matters
      ['__proto__', 'auto'], // "auto" is never stored; it is the absence of a choice
      ['{"a":1}', 'null'],
    ] as const) {
      await seed(page, { [SKIN_KEY]: skin, [THEME_KEY]: theme });
      await page.reload();
      await expect(page.getByTestId('isolated')).toBeVisible();
      await expect(page.getByTestId('skin'), `skin "${skin}"`).toHaveValue(DEFAULT_SKIN);
      await expect(page.getByTestId('theme'), `theme "${theme}"`).toHaveValue('auto');
      expect(await attrs(page)).toEqual({ skin: DEFAULT_SKIN, theme: 'dark' });
    }
    // A good skin with a bad theme keeps the skin.
    await seed(page, { [SKIN_KEY]: 'terminal', [THEME_KEY]: 'sepia' });
    await page.reload();
    await expect(page.getByTestId('skin')).toHaveValue('terminal');
    await expect(page.getByTestId('theme')).toHaveValue('auto');
    expect(await attrs(page)).toEqual({ skin: 'terminal', theme: 'dark' });
  });

  test('the switchers are disabled while a run is in progress and enabled again after', async ({ page }) => {
    await page.goto('/?smoke');
    await expect(page.getByTestId('skin')).toBeEnabled();
    await expect(page.getByTestId('theme')).toBeEnabled();
    // A smoke run can be quick, so record every change of the `disabled` state rather than race it.
    await page.evaluate(() => {
      const log: Record<string, boolean[]> = { skin: [], theme: [] };
      (window as unknown as { __dis: typeof log }).__dis = log;
      for (const id of ['skin', 'theme']) {
        const el = document.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!;
        log[id]!.push(el.disabled);
        new MutationObserver(() => {
          if (log[id]![log[id]!.length - 1] !== el.disabled) log[id]!.push(el.disabled);
        }).observe(el, { attributes: true, attributeFilter: ['disabled'] });
      }
    });
    await page.getByTestId('mode-full').check();
    await page.getByTestId('component-memory').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 120_000 });
    const log = await page.evaluate(() => (window as unknown as { __dis: Record<string, boolean[]> }).__dis);
    expect(log['skin']).toEqual([false, true, false]);
    expect(log['theme']).toEqual([false, true, false]);
    await expect(page.getByTestId('skin')).toBeEnabled();
    await expect(page.getByTestId('theme')).toBeEnabled();
  });

  test('a cancelled run also re-enables the switchers', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('mode-full').check();
    await page.getByTestId('component-memory').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('cancel')).toBeVisible();
    await expect(page.getByTestId('skin')).toBeDisabled();
    await expect(page.getByTestId('theme')).toBeDisabled();
    // The run may already have finished by the time Cancel is clicked; either end enables the selects.
    await page.getByTestId('cancel').click({ timeout: 2_000 }).catch(() => {});
    await expect(page.getByTestId('run')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('skin')).toBeEnabled();
    await expect(page.getByTestId('theme')).toBeEnabled();
  });

  for (const [id, label] of SKINS) {
    for (const theme of ['light', 'dark'] as const) {
      test(`a smoke run renders every result in skin ${label}, ${theme}`, async ({ page }) => {
        await page.goto('/?smoke');
        await page.getByTestId('skin').selectOption(id);
        await page.getByTestId('theme').selectOption(theme);
        expect(await attrs(page)).toEqual({ skin: id, theme });
        await page.getByTestId('run').click();
        await expect(page.getByTestId('status')).toHaveText('Done', { timeout: 60_000 });
        await expect(page.getByTestId('error')).toHaveCount(0);

        await expect(page.getByTestId('results')).toBeVisible();
        for (const k of CPU_KERNELS) await expect(page.getByTestId(`row-${k}`), k).toBeVisible();
        const checksums = page.getByTestId('checksum');
        await expect(checksums).toHaveCount(CPU_KERNELS.length);
        for (const cell of await checksums.all()) {
          await expect(cell).toBeVisible();
          await expect(cell).toHaveAttribute('data-ok', 'true');
          await expect(cell).toHaveText(/^(ok|noisy)$/);
        }
        for (const v of await page.getByTestId('value').all()) await expect(v).toHaveText(/^(\d+(\.\d+)?|—)$/);
        // Skin and theme are untouched by the run.
        expect(await attrs(page)).toEqual({ skin: id, theme });
      });
    }
  }
});
