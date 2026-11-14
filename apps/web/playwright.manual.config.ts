import { defineConfig } from '@playwright/test'
import { E2E_PORT } from './playwright.config'

/**
 * The manuals' screenshot tour (docs/manuals/SCREENSHOTS.md): the e2e's throwaway server and database
 * (e2e/global-setup.ts), filled with demo data by e2e-manual/manual-screenshots.spec.ts, which saves each screenshot
 * to docs/manuals/images/<name>.png. Build first: `corepack pnpm --filter @ow/server --filter @ow/web build`.
 * Run: `npx playwright test -c playwright.manual.config.ts` (from apps/web).
 */
export default defineConfig({
  testDir: 'e2e-manual',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    // CI installs Playwright's Chromium; locally the installed Chrome is enough.
    channel: process.env.CI ? undefined : 'chrome',
  },
})
