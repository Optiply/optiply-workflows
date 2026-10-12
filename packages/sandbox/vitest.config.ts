import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // isolated-vm requires this on Node ≥ 20.
    execArgv: ['--no-node-snapshot'],
    // Servers run with TZ=UTC (dayjs' timezone plugin miscomputes DST offsets when the host TZ isn't UTC).
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
})
