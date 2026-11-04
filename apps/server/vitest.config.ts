import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
    env: { TZ: 'UTC' },
    // Each test file boots its own embedded Postgres. A GitHub runner running every package's tests at once is about
    // six times slower than a Mac (2026-11-03: M18's IAP test, 5 s here, ran out at 30 s there), so CI gets more.
    testTimeout: process.env.CI ? 90_000 : 30_000,
    hookTimeout: 120_000,
  },
})
