import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // isolated-vm needs this on Node ≥ 20, and the sandbox expects TZ=UTC.
    execArgv: ['--no-node-snapshot'],
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
