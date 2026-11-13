import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `pnpm test` runs every package's suite at once; on a 4-CPU CI runner a test fast here (the app graph's 5,000-node
    // loop: 94 ms) took over vitest's default 5 s, and the convergence fuzz (~8 s a test there) once over 30 s.
    testTimeout: process.env.CI ? 90_000 : 30_000,
  },
})
