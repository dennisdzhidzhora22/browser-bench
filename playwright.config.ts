import { defineConfig } from '@playwright/test';

// Runs against the production build served by `vite preview` (127.0.0.1 only).
// Uses the installed Google Chrome (D10), not a downloaded browser.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    launchOptions: {
      // Keep Chrome from treating the test window as background work
      // (lower clocks, slow cores), which adds noise to measurements.
      args: [
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ],
    },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
