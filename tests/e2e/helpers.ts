import type { Page } from '@playwright/test';

// Shared by the e2e specs. Component results sit in closed <details> sections (M8 compact results, SPEC 12), and
// the memory latency table in its own closed <details>. Tests that read table content open them first.

/** Opens every component section and the latency table (what a user does by clicking the summaries). */
export async function openResults(page: Page): Promise<void> {
  await page.evaluate(() =>
    document
      .querySelectorAll<HTMLDetailsElement>('details[data-testid^="section-"], details[data-testid="latency-table"]')
      .forEach((d) => (d.open = true)),
  );
}
