import { defineConfig } from '@playwright/test'

/** The bundled server the end-to-end tests start (see e2e/global-setup.ts). */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4387)

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    // CI installs Playwright's Chromium; locally the installed Chrome is enough.
    channel: process.env.CI ? undefined : 'chrome',
  },
})
