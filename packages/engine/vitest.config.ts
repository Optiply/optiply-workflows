import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // isolated-vm needs this on Node ≥ 20, and the sandbox expects TZ=UTC.
    execArgv: ['--no-node-snapshot'],
    env: { TZ: 'UTC' },
    // As the server's: a shared GitHub runner is several times slower than a Mac.
    testTimeout: process.env.CI ? 90_000 : 30_000,
    hookTimeout: 120_000,
    // Tests that wait for runs with expect.poll: its default 1 s ran out on a GitHub runner (2026-11-03). A wait
    // that succeeds still returns at once.
    expect: { poll: { timeout: 10_000 } },
  },
})
