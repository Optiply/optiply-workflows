import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // The Postgres tests boot their own embedded Postgres.
    // As the server's: a shared GitHub runner is several times slower than a Mac.
    testTimeout: process.env.CI ? 90_000 : 30_000,
    hookTimeout: 120_000,
  },
})
