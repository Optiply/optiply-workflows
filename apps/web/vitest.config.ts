import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Unit tests for the web app's pure modules (`*.test.ts` next to them); the UI is covered by Playwright (e2e/). */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
