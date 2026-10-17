import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `pnpm test` runs every package's suite at once; on a 4-CPU CI runner a test fast here (the app graph's 5,000-node
    // loop: 94 ms) took over vitest's default 5 s.
    testTimeout: 30_000,
  },
})
