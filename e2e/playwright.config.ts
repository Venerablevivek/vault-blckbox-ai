import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the full Docker Compose stack, through the web server on
 * port 3000, exactly as a browser reaches it. That path (browser -> Next.js server -> API)
 * is where the header-spoofing and view-counting defects lived, and unit tests that call
 * the API directly could not see them.
 *
 * Run against a freshly started stack: the API's rate-limit counters live in memory, and
 * the abuse tests (99-*) deliberately use them up.
 */
export default defineConfig({
  testDir: './tests',
  // One worker, files in name order: the abuse-limit tests run last because they exhaust
  // the login rate limit for this client address.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
