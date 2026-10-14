import { afterEach, describe, expect, it } from 'vitest'
import { IvmRuntime } from '../src'

/**
 * M0's isolate spike target: a fresh context with the stdlib in under 10 ms on average. Timing-sensitive, so it's
 * skipped in `pnpm test` (where every suite competes for the CPUs; CI once measured 10.5 ms that way) and run on
 * its own with `pnpm --filter @ow/sandbox bench` (CI does, after the tests).
 */
describe.runIf(process.env.SANDBOX_BENCH === '1')('IvmRuntime: speed', () => {
  let runtime: IvmRuntime
  afterEach(() => runtime?.dispose())

  it('creates a fresh context fast (< 10ms on average after warm-up)', async () => {
    runtime = new IvmRuntime()
    await runtime.evalExpression('1', {}) // warm-up: builds the snapshot + isolate
    const n = 50
    const started = performance.now()
    for (let i = 0; i < n; i++) {
      await runtime.evalExpression('_.sum(xs)', { xs: [1, 2, 3] })
    }
    const avgMs = (performance.now() - started) / n
    console.info(`avg fresh-context evaluation: ${avgMs.toFixed(2)}ms`)
    expect(avgMs).toBeLessThan(10)
  })
})
