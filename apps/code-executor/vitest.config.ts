import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    // The first run builds the executor image (nsjail from source, the packages): a few minutes on a cold cache.
    hookTimeout: 900_000,
  },
})
