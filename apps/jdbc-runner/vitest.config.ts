import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60_000,
    // The first run builds the runner image (Maven, the drivers, its Java tests): a few minutes on a cold cache.
    hookTimeout: 900_000,
  },
})
