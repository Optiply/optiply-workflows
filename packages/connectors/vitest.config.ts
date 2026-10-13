import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // The Postgres tests boot their own embedded Postgres.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
