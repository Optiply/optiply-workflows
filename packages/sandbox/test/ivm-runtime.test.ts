import { afterEach, describe, expect, it } from 'vitest'
import { IvmRuntime, SandboxError } from '../src'

let runtime: IvmRuntime
afterEach(() => runtime?.dispose())

async function expectSandboxError(p: Promise<unknown>, kind: SandboxError['kind']) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SandboxError)
  expect((err as SandboxError).kind).toBe(kind)
  return err as SandboxError
}

describe('IvmRuntime: expressions and code', () => {
  it('evaluates expressions against scope', async () => {
    runtime = new IvmRuntime()
    const scope = { query1: { data: [{ id: 1 }, { id: 2 }] } }
    expect(await runtime.evalExpression('query1.data.length', scope)).toBe(2)
    expect(await runtime.evalExpression('query1.data.map(r => r.id)', scope)).toEqual([1, 2])
    expect(await runtime.evalExpression('{ a: 1 } // trailing comment', {})).toEqual({ a: 1 })
  })

  it('runs async code blocks that return JSON', async () => {
    runtime = new IvmRuntime()
    const result = await runtime.runCode(
      'const x = await Promise.resolve(startTrigger.data.n)\nreturn { doubled: x * 2, at: new Date(0) }',
      { startTrigger: { data: { n: 21 } } },
    )
    expect(result).toEqual({ doubled: 42, at: '1970-01-01T00:00:00.000Z' })
  })

  it('exposes lodash and dayjs (with timezone support)', async () => {
    runtime = new IvmRuntime()
    expect(await runtime.evalExpression('_.sumBy(rows, "v")', { rows: [{ v: 1 }, { v: 2 }] })).toBe(3)
    expect(await runtime.evalExpression('_.chain([3,1,2]).sortBy().value()', {})).toEqual([1, 2, 3])
    expect(
      await runtime.evalExpression(
        'dayjs.utc("2026-03-29T00:30:00Z").tz("Europe/Amsterdam").format("YYYY-MM-DD HH:mm")',
        {},
      ),
    ).toBe('2026-03-29 01:30')
  })

  it('forwards console output, including circular values', async () => {
    runtime = new IvmRuntime()
    const logs: [string, unknown[]][] = []
    await runtime.runCode(
      'const a = {n: 1}; a.self = a; console.log("hi", a); console.error(1n)',
      {},
      {
        onLog: (level, args) => logs.push([level, args]),
      },
    )
    expect(logs).toEqual([
      ['log', ['hi', { n: 1, self: '[Circular]' }]],
      ['error', ['1']],
    ])
  })

  it('isolates evaluations from each other', async () => {
    runtime = new IvmRuntime()
    await runtime.runCode('globalThis.leak = 42; _.leaked = true', {})
    expect(await runtime.evalExpression('typeof leak', {})).toBe('undefined')
    expect(await runtime.evalExpression('_.leaked', {})).toBe(undefined)
  })

  it('maps user errors and syntax errors', async () => {
    runtime = new IvmRuntime()
    const err = await expectSandboxError(runtime.runCode('throw new Error("boom")', {}), 'runtime')
    expect(err.message).toContain('boom')
    await expectSandboxError(runtime.runCode('return (', {}), 'syntax')
  })
})

describe('IvmRuntime: security boundary', () => {
  it('exposes no Node APIs', async () => {
    runtime = new IvmRuntime()
    for (const name of ['process', 'require', 'module', 'Buffer', 'setImmediate', '__dirname']) {
      expect(await runtime.evalExpression(`typeof ${name}`, {})).toBe('undefined')
    }
    expect(await runtime.evalExpression('typeof globalThis.process', {})).toBe('undefined')
    // Escaping via the Function constructor still lands in the isolate's own realm.
    expect(await runtime.evalExpression('typeof (function(){ return this })().process', {})).toBe('undefined')
    expect(await runtime.evalExpression("typeof Function('return this')().process", {})).toBe('undefined')
  })
})

describe('IvmRuntime: limits', () => {
  it('kills a synchronous infinite loop at the timeout', async () => {
    runtime = new IvmRuntime()
    const started = Date.now()
    await expectSandboxError(runtime.runCode('while (true) {}', {}, { timeoutMs: 200 }), 'timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
    // The runtime remains usable afterwards.
    expect(await runtime.evalExpression('1 + 1', {})).toBe(2)
  })

  it('kills an infinite loop inside an async continuation', async () => {
    runtime = new IvmRuntime()
    const started = Date.now()
    await expectSandboxError(
      runtime.runCode('await null; while (true) {}', {}, { timeoutMs: 200 }),
      'timeout',
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await runtime.evalExpression('2 + 2', {})).toBe(4)
  })

  it('kills a memory bomb and recovers with a fresh isolate', async () => {
    runtime = new IvmRuntime({ memoryLimitMb: 32 })
    await expectSandboxError(
      runtime.runCode(
        'const a = []; while (true) a.push(new Array(1e5).fill("x".repeat(10)))',
        {},
        { timeoutMs: 15_000 },
      ),
      'memory',
    )
    expect(await runtime.evalExpression('"still alive"', {})).toBe('still alive')
  })

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
