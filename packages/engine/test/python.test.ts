/**
 * Python code blocks and loop runners through the engine, against the real code executor (a container, as the
 * MySQL tests do): the scope, results, logs, errors, timeouts, cancel, and running without an executor.
 */
import { executorAvailable, startTestExecutor, type TestExecutor } from '@ow/code-executor/testing'
import { PythonExecutorClient } from '@ow/sandbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryRunStore } from '../src'
import { shared as sharedOnce } from '../src/executor'
import { code, fakeQ, run, testServices, wf } from './helpers'

const available = executorAvailable()
const shared = testServices()
let executor: TestExecutor
const services = () => ({
  ...shared.services,
  python: new PythonExecutorClient({ url: executor.url, token: executor.token }),
})

const python = (name: string, src: string, settings?: object) => ({
  name,
  type: 'code',
  config: { code: src, language: 'python' },
  ...(settings && { settings }),
})
const py = (...lines: string[]) => lines.join('\n')

afterAll(() => shared.close())

describe.skipIf(!available)('Python code blocks', () => {
  beforeAll(async () => {
    executor = await startTestExecutor()
  })
  afterAll(async () => {
    await executor?.stop()
  })

  it('reads the blocks it names and the run globals, and returns its data', async () => {
    const { outcome, data, store } = await run(
      services(),
      wf(
        [
          fakeQ('orders', {
            value: '{{ [{"city": "Utrecht", "amount": 3}, {"city": "Delft", "amount": 4}] }}',
          }),
          python(
            'summary',
            py(
              'import pandas as pd',
              'df = pd.DataFrame(orders.data)',
              'print("rows", len(df))',
              'return {',
              '  "total": int(df.amount.sum()),',
              '  "cities": sorted(df.city),',
              '  "region": configVars.REGION,',
              '  "env": workflowContext.environment,',
              '  "input": startTrigger.data,',
              '}',
            ),
          ),
          code('after', 'return summary.data.total * 2'),
        ],
        [
          ['startTrigger', 'orders'],
          ['orders', 'summary'],
          ['summary', 'after'],
        ],
      ),
      { input: { data: { name: 'Ada' } } },
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('summary')).toEqual({
      total: 7,
      cities: ['Delft', 'Utrecht'],
      region: 'eu',
      env: 'production',
      input: { name: 'Ada' },
    })
    expect(data('after')).toBe(14)
    expect(store.logs).toEqual([{ blockKey: 'summary', level: 'log', message: 'rows 2' }])
  })

  it('runs a loop with a Python runner, each item as value and index', async () => {
    const { outcome, data } = await run(
      services(),
      wf(
        [
          {
            name: 'each',
            type: 'loop',
            config: {
              input: '{{ [10, 20, 30] }}',
              runner: { kind: 'code', code: 'return {"i": index, "double": value * 2}', language: 'python' },
            },
          },
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('each')).toEqual([
      { i: 0, double: 20 },
      { i: 1, double: 40 },
      { i: 2, double: 60 },
    ])
  })

  it('fails the block with the error, its line and traceback, after its prints', async () => {
    const { outcome, store } = await run(
      services(),
      wf(
        [python('bad', py('def ratio(n):', '    return 1 / n', 'print("before")', 'return ratio(0)'))],
        [['startTrigger', 'bad']],
      ),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatchObject({
      block: 'bad',
      code: 'runtime',
      message: 'ZeroDivisionError: division by zero (line 2)',
      details: { line: 2, traceback: '  line 4\n  line 2, in ratio' },
    })
    expect(store.logs.map((l) => l.message)).toEqual(['before'])
    const syntax = await run(services(), wf([python('typo', 'return x +')], [['startTrigger', 'typo']]))
    expect(syntax.outcome.error).toMatchObject({
      code: 'syntax',
      message: 'SyntaxError: invalid syntax (line 1, column 11)',
    })
  })

  it('stops at the block timeout, and retries like any block', async () => {
    const started = Date.now()
    const { outcome } = await run(
      services(),
      wf([python('spin', 'while True: pass', { timeoutMs: 1000 })], [['startTrigger', 'spin']]),
    )
    expect(outcome.error).toMatchObject({ block: 'spin', code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)

    const retried = await run(
      services(),
      wf(
        [
          python('flaky', 'raise RuntimeError("always")', {
            retry: { count: 1, intervalMs: 10 },
          }),
        ],
        [['startTrigger', 'flaky']],
      ),
    )
    expect(retried.outcome.error).toMatchObject({ code: 'runtime' })
    expect(retried.outcome.results.get('flaky')?.attempt).toBe(2)
  })

  it('keeps what the code printed before its timeout', async () => {
    const { outcome, store } = await run(
      services(),
      wf(
        [python('slow', 'print("started")\nwhile True: pass', { timeoutMs: 2500 })],
        [['startTrigger', 'slow']],
      ),
    )
    expect(outcome.error).toMatchObject({
      block: 'slow',
      code: 'timeout',
      message: "The Python code didn't finish within 2500 ms",
    })
    expect(store.logs.map((l) => l.message)).toEqual(['started'])
  })

  it('logs each line while the block is still running', async () => {
    const store = new MemoryRunStore()
    const running = run(
      services(),
      wf(
        [python('slow', py('import time', 'print("first")', 'time.sleep(2)', 'print("second")', 'return 1'))],
        [['startTrigger', 'slow']],
      ),
      { store },
    )
    // "first" is in the run's log a good while before the block ends.
    await expect.poll(() => store.logs.map((l) => l.message), { timeout: 1800 }).toEqual(['first'])
    const { outcome } = await running
    expect(outcome.status).toBe('succeeded')
    expect(store.logs.map((l) => l.message)).toEqual(['first', 'second'])
  })

  it('hangs up on the executor when the run is aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const started = Date.now()
    const { outcome } = await run(
      services(),
      wf([python('slow', 'import time\ntime.sleep(20)', { timeoutMs: 30_000 })], [['startTrigger', 'slow']]),
      { signal: controller.signal },
    )
    expect(outcome.status).toBe('interrupted')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("says the executor can't be reached", async () => {
    const { outcome } = await run(
      {
        ...shared.services,
        python: new PythonExecutorClient({ url: 'http://127.0.0.1:9', token: 'x'.repeat(16) }),
      },
      wf([python('p', 'return 1')], [['startTrigger', 'p']]),
    )
    expect(outcome.error).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining("The Python executor isn't reachable"),
    })
  })
})

it('fails Python blocks without an executor', async () => {
  const { outcome } = await run(shared.services, wf([python('p', 'return 1')], [['startTrigger', 'p']]))
  expect(outcome.error).toMatchObject({
    block: 'p',
    code: 'python_unavailable',
    message: "Python isn't set up on this instance (PYTHON_EXECUTOR_URL)",
  })
})

describe("a run's Python packages (M23)", () => {
  // A runner that answers with the env it was given: these tests are about the env, not Python.
  const echoEnv = {
    run: async (_code: string, _scope: object, opts: { envId?: string }) => opts.envId ?? null,
    check: async () => [],
  }

  it('passes the env to the executor for every Python block', async () => {
    const { outcome, data } = await run(
      { ...shared.services, python: echoEnv, pythonEnv: async () => 'e'.repeat(32) },
      wf(
        [python('one', 'return 1'), python('two', 'return 2')],
        [
          ['startTrigger', 'one'],
          ['one', 'two'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect([data('one'), data('two')]).toEqual(['e'.repeat(32), 'e'.repeat(32)])
  })

  it("asks the provider once for the run's blocks, and again after a failure", async () => {
    let calls = 0
    let fail = true
    const env = sharedOnce(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      if (fail) throw new Error('index down')
      return 'env'
    })
    await expect(Promise.all([env(), env()])).rejects.toThrow('index down')
    expect(calls).toBe(1)
    fail = false
    expect(await Promise.all([env(), env(), env()])).toEqual(['env', 'env', 'env'])
    expect(await env()).toBe('env')
    expect(calls).toBe(2)
  })

  it('gives a failure met ahead (prefetch) to the first caller, without asking again', async () => {
    let calls = 0
    const env = sharedOnce(async () => {
      calls++
      throw new Error(`failure ${calls}`)
    })
    env.prefetch()
    await new Promise((r) => setTimeout(r, 10))
    await expect(env()).rejects.toThrow('failure 1')
    expect(calls).toBe(1)
    await expect(env()).rejects.toThrow('failure 2') // a caller had it: the next asks again
    env.prefetch() // ahead of time only: never asks again while there is an answer
    expect(calls).toBe(2)
  })

  it('says in the log that it waits for the packages, so a timeout then reads in context', async () => {
    const { outcome, store } = await run(
      { ...shared.services, python: echoEnv, pythonEnv: () => new Promise<string>(() => {}) },
      wf([python('slow', 'return 1', { timeoutMs: 1500 })], [['startTrigger', 'slow']]),
    )
    expect(outcome.error).toMatchObject({ block: 'slow', code: 'timeout' })
    expect(store.logs.map((l) => l.message)).toEqual([
      "Waiting for the workflow's Python packages to install…",
    ])
    const quick = await run(
      { ...shared.services, python: echoEnv, pythonEnv: async () => 'e'.repeat(32) },
      wf([python('fast', 'return 1')], [['startTrigger', 'fast']]),
    )
    expect(quick.store.logs).toEqual([]) // a ready env says nothing
  })
})
