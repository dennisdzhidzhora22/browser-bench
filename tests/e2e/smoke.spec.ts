import { expect, test } from '@playwright/test';

test.describe('M0 smoke', () => {
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

  test('smoke run completes with a valid checksum', async ({ page }) => {
    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    const checksum = page.getByTestId('checksum');
    await expect(checksum).toBeVisible();
    await expect(checksum).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('error')).toHaveCount(0);
  });

  test('production build shows no dev banner', async ({ page }) => {
    await page.goto('/?smoke');
    await expect(page.getByTestId('isolated')).toBeVisible();
    await expect(page.getByTestId('dev-banner')).toHaveCount(0);
  });

  test('every network request is same-origin', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));

    await page.goto('/?smoke');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('checksum')).toHaveAttribute('data-ok', 'true');

    expect(urls.length).toBeGreaterThan(0);
    const external = urls.filter((u) => {
      // data: and blob: URLs never leave the browser (e.g. worker bootstrap).
      if (u.startsWith('data:') || u.startsWith('blob:')) return false;
      return new URL(u).origin !== origin;
    });
    expect(external).toEqual([]);
  });
});
