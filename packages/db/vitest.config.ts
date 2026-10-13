import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // Each test file boots its own embedded Postgres.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
