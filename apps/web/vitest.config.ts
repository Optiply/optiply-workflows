import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Unit tests for the web app's pure modules (`*.test.ts` next to them); the UI is covered by Playwright (e2e/). */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // A 30 s limit, as in the packages: `pnpm test` runs every suite at once, and CI runners are slower.
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
})
