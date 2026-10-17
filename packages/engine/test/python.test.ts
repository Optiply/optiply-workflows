/**
 * Python code blocks and loop runners through the engine, against the real code executor (a container, as the
 * MySQL tests do): the scope, results, logs, errors, timeouts, cancel, and running without an executor.
 */
import { executorAvailable, startTestExecutor, type TestExecutor } from '@ow/code-executor/testing'
import { PythonExecutorClient } from '@ow/sandbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
