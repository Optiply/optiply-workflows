/**
 * Golden semantics tests: one group per rule in docs/architecture.md §2.2 that M2 covers. Loops, functions,
 * waits and the global error handler arrive in M5 with their own tests.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { LeaseLostError, MemoryRunStore, retryDelayMs } from '../src'
import { branch, code, fakeQ, filter, response, run, testServices, wf } from './helpers'

const t = testServices()
const { services, fake } = t
beforeEach(() => t.reset())
afterAll(() => t.close())

describe('readiness and data flow', () => {
  it('runs blocks in order and passes data downstream', async () => {
    const { outcome, statuses, data } = await run(
      services,
      wf(
        [code('double', 'return startTrigger.data.n * 2'), code('plusOne', 'return double.data + 1')],
        [
          ['startTrigger', 'double'],
          ['double', 'plusOne'],
        ],
      ),
      { input: { data: { n: 20 } } },
    )
    expect(outcome).toMatchObject({ status: 'succeeded', error: null, response: null })
    expect(statuses).toEqual({ startTrigger: 'succeeded', double: 'succeeded', plusOne: 'succeeded' })
    expect(data('plusOne')).toBe(41)
  })

  it('exposes the trigger input and the run globals', async () => {
    const src = `return {
      data: startTrigger.data, headers: startTrigger.headers, pathParams: startTrigger.pathParams,
      urlParams: startTrigger.urlParams, region: configVars.REGION, key: idempotencyKey,
      env: workflowContext.environment,
    }`
    const { data } = await run(services, wf([code('read', src)], [['startTrigger', 'read']]), {
      input: { data: { id: 7 }, headers: { 'x-a': '1' }, pathParams: { id: '7' }, urlParams: { q: 'x' } },
    })
    expect(data('read')).toEqual({
      data: { id: 7 },
      headers: { 'x-a': '1' },
      pathParams: { id: '7' },
      urlParams: { q: 'x' },
      region: 'eu',
      key: 'idem-1',
      env: 'production',
    })
  })

  it('labels resource queries with the run, so connectors can attribute their work', async () => {
    await run(services, wf([fakeQ('q', {})], [['startTrigger', 'q']]), {
      globals: {
        configVars: {},
        workflowContext: {
          runId: 'run-1',
          workflowId: 'wf-9',
          environment: 'staging',
          triggerType: 'schedule',
        },
        idempotencyKey: 'run-1',
      },
    })
    expect(fake.labels).toEqual([
      {
        ow_source: 'workflow',
        ow_run: 'run-1',
        ow_workflow: 'wf-9',
        ow_environment: 'staging',
        ow_trigger: 'schedule',
      },
    ])
  })

  it('fans out in parallel, and a join waits for every parent', async () => {
    const { data, store } = await run(
      services,
      wf(
        [
          fakeQ('left', { delayMs: 150 }),
          fakeQ('right', { delayMs: 150 }),
          code('join', 'return [left.data, right.data]'),
        ],
        [
          ['startTrigger', 'left'],
          ['startTrigger', 'right'],
          ['left', 'join'],
          ['right', 'join'],
        ],
      ),
    )
    expect(fake.maxActive).toBe(2)
    expect(data('join')).toEqual([1, 1])
    const order = store.events.map((e) => `${e.type} ${e.key}`)
    expect(order.indexOf('started join')).toBeGreaterThan(order.indexOf('finished left'))
    expect(order.indexOf('started join')).toBeGreaterThan(order.indexOf('finished right'))
  })

  it('caps how many blocks execute at once', async () => {
    const names = ['a', 'b', 'c', 'd']
    await run(
      services,
      wf(
        names.map((n) => fakeQ(n, { delayMs: 50 })),
        names.map((n) => ['startTrigger', n]),
      ),
      { maxConcurrency: 2 },
    )
    expect(fake.maxActive).toBe(2)
    expect(names.map((n) => fake.count(n))).toEqual([1, 1, 1, 1])
  })

  it('skips a block whose incoming edges are all dead, and the skip propagates downstream', async () => {
    const { statuses } = await run(
      services,
      wf(
        [
          branch('check', [['yes', 'true']]),
          code('onYes', 'return 1'),
          code('onElse', 'return 2'),
          code('afterElse', 'return 3'),
        ],
        [
          ['startTrigger', 'check'],
          ['check', 'onYes', 'cond:yes'],
          ['check', 'onElse', 'else'],
          ['onElse', 'afterElse'],
        ],
      ),
    )
    expect(statuses).toMatchObject({ onYes: 'succeeded', onElse: 'skipped', afterElse: 'skipped' })
  })

  it('runs a join after if/else, where a skipped parent reads as an empty skipped result', async () => {
    const { statuses, data } = await run(
      services,
      wf(
        [
          branch('check', [['big', 'startTrigger.data > 10']]),
          code('big', 'return "big"'),
          code('small', 'return "small"'),
          code('join', 'return { big, small }'),
        ],
        [
          ['startTrigger', 'check'],
          ['check', 'big', 'cond:big'],
          ['check', 'small', 'else'],
          ['big', 'join'],
          ['small', 'join'],
        ],
      ),
      { input: { data: 3 } },
    )
    expect(statuses).toMatchObject({ big: 'skipped', small: 'succeeded', join: 'succeeded' })
    expect(data('join')).toEqual({
      big: { data: null, error: null, metadata: { status: 'skipped' } },
      small: { data: 'small', error: null, metadata: { status: 'succeeded' } },
    })
  })

  it('skips blocks that nothing connects to', async () => {
    const { statuses, outcome } = await run(services, wf([code('orphan', 'return 1')], []))
    expect(outcome.status).toBe('succeeded')
    expect(statuses.orphan).toBe('skipped')
  })
})

describe('branch', () => {
  const graph = (conditions: [string, string][], settings?: object) =>
    wf(
      [
        branch('pick', conditions, settings),
        code('one', 'return 1'),
        code('two', 'return 2'),
        code('three', 'return 3'),
        code('other', 'return 0'),
      ],
      [
        ['startTrigger', 'pick'],
        ['pick', 'one', 'cond:one'],
        ['pick', 'two', 'cond:two'],
        ['pick', 'three', 'cond:three'],
        ['pick', 'other', 'else'],
      ],
    )

  it('fires only the first truthy condition', async () => {
    const { statuses, data } = await run(
      services,
      graph([
        ['one', 'false'],
        ['two', 'startTrigger.data.ok'],
        ['three', 'true'],
      ]),
      { input: { data: { ok: 1 } } },
    )
    expect(statuses).toMatchObject({ one: 'skipped', two: 'succeeded', three: 'skipped', other: 'skipped' })
    expect(data('pick')).toBe('two')
  })

  it('fires else when nothing is truthy', async () => {
    const { statuses, outcome } = await run(
      services,
      graph([
        ['one', '0'],
        ['two', '""'],
        ['three', 'null'],
      ]),
    )
    expect(statuses).toMatchObject({ one: 'skipped', two: 'skipped', three: 'skipped', other: 'succeeded' })
    expect(outcome.results.get('pick')!.port).toBe('else')
  })

  it('treats a condition that throws as a block error', async () => {
    const { outcome, statuses } = await run(
      services,
      graph([
        ['one', 'false'],
        ['two', 'startTrigger.data.missing.deep'],
        ['three', 'true'],
      ]),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'expression', block: 'pick' })
    expect(outcome.error!.message).toMatch(/Condition "two" failed/)
    expect(statuses.three).toBeUndefined()
  })
})

describe('errors', () => {
  it('with finally=stop, fails the run, aborts in-flight siblings and starts nothing else', async () => {
    const started = Date.now()
    const { outcome, statuses, store } = await run(
      services,
      wf(
        [
          code('bad', 'throw new Error("nope")'),
          code('afterBad', 'return 1'),
          fakeQ('slow', { delayMs: 5000 }),
          code('afterSlow', 'return 1'),
        ],
        [
          ['startTrigger', 'bad'],
          ['bad', 'afterBad'],
          ['startTrigger', 'slow'],
          ['slow', 'afterSlow'],
        ],
      ),
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'runtime', message: 'nope', block: 'bad' })
    expect(statuses).toMatchObject({ bad: 'failed', slow: 'cancelled' })
    expect(outcome.results.get('slow')!.error!.message).toBe('Stopped because "bad" failed')
    expect(fake.aborted).toEqual(['slow'])
    expect(store.events.some((e) => e.key === 'afterBad' || e.key === 'afterSlow')).toBe(false)
  })

  it('with finally=continue, kills the out edge and fires the error edge', async () => {
    const { outcome, statuses, data } = await run(
      services,
      wf(
        [
          code('bad', 'throw new Error("nope")', { finally: 'continue' }),
          code('onOk', 'return "ok"'),
          code('onError', 'return "handled: " + bad.error.message'),
        ],
        [
          ['startTrigger', 'bad'],
          ['bad', 'onOk'],
          ['bad', 'onError', 'error'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(statuses).toMatchObject({ bad: 'errored', onOk: 'skipped', onError: 'succeeded' })
    expect(data('onError')).toBe('handled: nope')
  })

  it('always runs a block connected to both out and error', async () => {
    const both = (name: string, src: string) =>
      wf(
        [code(name, src, { finally: 'continue' }), code('always', `return ${name}.metadata.status`)],
        [
          ['startTrigger', name],
          [name, 'always'],
          [name, 'always', 'error'],
        ],
      )
    expect((await run(services, both('good', 'return 1'))).data('always')).toBe('succeeded')
    expect((await run(services, both('bad', 'throw new Error("x")'))).data('always')).toBe('errored')
  })
})

describe('retries and timeouts', () => {
  it('retries a failing block and succeeds on a later attempt', async () => {
    const { outcome, store } = await run(
      services,
      wf(
        [fakeQ('flaky', { failTimes: 2 }, { retry: { count: 2, intervalMs: 10 } })],
        [['startTrigger', 'flaky']],
      ),
    )
    const result = outcome.results.get('flaky')!
    expect(result).toMatchObject({ status: 'succeeded', attempt: 3, data: 3 })
    expect(
      store.events
        .filter((e) => e.type === 'started' && e.key === 'flaky')
        .map((e) => e.type === 'started' && e.attempt),
    ).toEqual([1, 2, 3])
    expect(store.logs.filter((l) => l.level === 'warn')).toHaveLength(2)
  })

  it('reports the last error once retries run out, with secrets scrubbed', async () => {
    const { outcome } = await run(
      services,
      wf(
        [fakeQ('flaky', { failTimes: 5 }, { retry: { count: 1, intervalMs: 10 } })],
        [['startTrigger', 'flaky']],
      ),
    )
    expect(outcome.results.get('flaky')).toMatchObject({ status: 'failed', attempt: 2 })
    expect(outcome.error).toMatchObject({ code: 'query', message: 'call 2 failed (token [REDACTED])' })
  })

  it('times out a block and aborts its work', async () => {
    const { outcome } = await run(
      services,
      wf([fakeQ('slow', { delayMs: 5000 }, { timeoutMs: 200 })], [['startTrigger', 'slow']]),
    )
    expect(outcome.error).toMatchObject({ code: 'timeout', block: 'slow' })
    expect(fake.aborted).toEqual(['slow'])
  })

  it('times out code stuck in a loop', async () => {
    const { outcome } = await run(
      services,
      wf([code('spin', 'while (true) {}', { timeoutMs: 300 })], [['startTrigger', 'spin']]),
    )
    expect(outcome.error).toMatchObject({ code: 'timeout', block: 'spin' })
  })

  it('fails the run at its deadline and cancels what is in flight', async () => {
    const { outcome, statuses } = await run(
      services,
      wf([fakeQ('slow', { delayMs: 5000 })], [['startTrigger', 'slow']]),
      { deadline: new Date(Date.now() + 300) },
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toEqual({ code: 'run_timeout', message: 'The run timed out' })
    expect(statuses.slow).toBe('cancelled')
  })

  it('backs off exponentially up to the cap', () => {
    const retry = { count: 5, intervalMs: 100, exponential: true, coefficient: 2, maxIntervalMs: 500 }
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(retry, n))).toEqual([100, 200, 400, 500, 500])
    expect(retryDelayMs({ ...retry, exponential: false }, 4)).toBe(100)
  })
})

describe('response', () => {
  it('replies with the first Response block, keeps executing, and ignores later ones', async () => {
    const { outcome, statuses } = await run(
      services,
      wf(
        [
          response('fast', '{"winner": "fast", "n": {{ startTrigger.data }}}', '201', [
            ['X-Run', '{{ idempotencyKey }}'],
          ]),
          code('afterFast', 'return 1'),
          // Well behind `fast`, which evaluates three templates in the sandbox first (over 100 ms on a busy CI runner).
          fakeQ('slow', { delayMs: 1500 }),
          response('late', '{"winner": "late"}'),
        ],
        [
          ['startTrigger', 'fast'],
          ['fast', 'afterFast'],
          ['startTrigger', 'slow'],
          ['slow', 'late'],
        ],
      ),
      { input: { data: 5 } },
    )
    expect(outcome.response).toEqual({
      status: 201,
      headers: { 'x-run': 'idem-1' },
      body: { winner: 'fast', n: 5 },
    })
    expect(statuses).toMatchObject({ fast: 'succeeded', afterFast: 'succeeded', late: 'succeeded' })
    expect(outcome.results.get('fast')!.metadata).toEqual({ sent: true })
    expect(outcome.results.get('late')!.metadata).toEqual({ ignored: true })
  })

  it('has no response when no Response block runs', async () => {
    const { outcome } = await run(services, wf([code('a', 'return 1')], [['startTrigger', 'a']]))
    expect(outcome.response).toBeNull()
  })

  it('rejects a status that is not an HTTP status code', async () => {
    const { outcome } = await run(
      services,
      wf([response('r', '{}', '{{ "teapot" }}')], [['startTrigger', 'r']]),
    )
    expect(outcome.error).toMatchObject({ code: 'invalid_response', block: 'r' })
  })
})

describe('delivery and resume', () => {
  const graph = () =>
    wf(
      [
        fakeQ('load', { value: '{{ startTrigger.data * 2 }}' }),
        branch('check', [['big', 'load.data > 5']]),
        fakeQ('onBig', { value: '{{ load.data + 1 }}' }),
        fakeQ('onSmall'),
        code('finish', 'return [load.data, onBig.data, onSmall.metadata.status]'),
      ],
      [
        ['startTrigger', 'load'],
        ['load', 'check'],
        ['check', 'onBig', 'cond:big'],
        ['check', 'onSmall', 'else'],
        ['onBig', 'finish'],
        ['onSmall', 'finish'],
      ],
    )

  it('resumes from checkpoints without re-running committed blocks', async () => {
    // The first lease is lost as soon as onBig starts.
    const first = await run(services, graph(), {
      input: { data: 10 },
      store: new MemoryRunStore((e) => {
        if (e.type === 'started' && e.key === 'onBig') throw new LeaseLostError('epoch moved on')
      }),
    })
    expect(first.outcome.status).toBe('interrupted')
    expect(first.outcome.error).toMatchObject({ message: 'epoch moved on' })
    expect(Object.keys(first.statuses).sort()).toEqual(['check', 'load', 'onSmall', 'startTrigger'])

    const second = await run(services, graph(), {
      input: { data: 10 },
      checkpoints: first.store.checkpoints(),
    })
    expect(second.outcome.status).toBe('succeeded')
    expect(fake.count('load')).toBe(1)
    expect(fake.count('onBig')).toBe(1)
    expect(second.store.events.some((e) => e.key === 'load' || e.key === 'check')).toBe(false)
    expect(second.data('finish')).toEqual([20, 21, 'skipped'])
  })

  it('stops committing once the lease is lost', async () => {
    const { outcome, store } = await run(services, graph(), {
      input: { data: 10 },
      store: new MemoryRunStore((e) => {
        if (e.type === 'finished' && e.key === 'check') throw new LeaseLostError('fenced')
      }),
    })
    expect(outcome.status).toBe('interrupted')
    expect([...store.results.keys()].sort()).toEqual(['load', 'startTrigger'])
    expect(fake.count('onBig')).toBe(0)
  })

  it('interrupts on an external abort without committing in-flight blocks', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const { outcome, store } = await run(
      services,
      wf([fakeQ('slow', { delayMs: 5000 })], [['startTrigger', 'slow']]),
      { signal: controller.signal },
    )
    expect(outcome).toMatchObject({ status: 'interrupted', error: null })
    expect(store.results.has('slow')).toBe(false)
    expect(fake.aborted).toEqual(['slow'])
  })

  it('does not reply again when an earlier lease already did', async () => {
    const { outcome } = await run(services, wf([response('r', '{}')], [['startTrigger', 'r']]), {
      responded: true,
    })
    expect(outcome.response).toBeNull()
    expect(outcome.results.get('r')!.metadata).toEqual({ ignored: true })
  })

  it('fails straight away when a committed block had failed', async () => {
    const failed = {
      key: 'load',
      status: 'failed' as const,
      data: null,
      sizeBytes: 0,
      error: { code: 'query', message: 'boom' },
      metadata: {},
      port: null,
      attempt: 1,
      startedAt: null,
      finishedAt: new Date(),
    }
    const { outcome } = await run(services, graph(), { checkpoints: [failed] })
    expect(outcome.error).toEqual({ code: 'query', message: 'boom', block: 'load' })
    expect(fake.count('load')).toBe(0)
  })
})

describe('run block (only)', () => {
  // startTrigger → a → b → c, and startTrigger → other.
  const graph = () =>
    wf(
      [
        fakeQ('a', { value: '{{ startTrigger.data + 1 }}' }),
        fakeQ('b', { value: '{{ a.data * 10 }}' }),
        fakeQ('c'),
        fakeQ('other'),
      ],
      [
        ['startTrigger', 'a'],
        ['a', 'b'],
        ['b', 'c'],
        ['startTrigger', 'other'],
      ],
    )

  it('runs the target and the ancestors it needs, and nothing else', async () => {
    const { outcome, statuses, data } = await run(services, graph(), { input: { data: 1 }, only: ['b'] })
    expect(outcome.status).toBe('succeeded')
    expect(statuses).toEqual({ startTrigger: 'succeeded', a: 'succeeded', b: 'succeeded' })
    expect(data('b')).toBe(20)
    expect([fake.count('c'), fake.count('other')]).toEqual([0, 0])
  })

  it('runs a chain nothing connects to the start trigger, and ignores a broken block elsewhere (M28)', async () => {
    const loose = wf(
      [
        fakeQ('x', { value: '{{ 3 }}' }),
        fakeQ('y', { value: '{{ x.data * 2 }}' }),
        { name: 'bad', type: 'code', config: { code: 'return (' } },
      ],
      [
        ['x', 'y'],
        ['startTrigger', 'bad'],
      ],
    )
    const { outcome, statuses, data } = await run(services, loose, { only: ['y'] })
    expect(outcome.error).toBeNull()
    expect(outcome.status).toBe('succeeded')
    expect(statuses).toEqual({ x: 'succeeded', y: 'succeeded' })
    expect(data('y')).toBe(6)
    // A whole run still refuses the broken block.
    expect((await run(services, loose, {})).outcome.error?.code).toBe('invalid_definition')
  })

  it('reuses checkpointed ancestors instead of running them again', async () => {
    const first = await run(services, graph(), { input: { data: 1 } })
    t.reset()
    const upstream = first.store.checkpoints().filter((c) => c.key === 'startTrigger' || c.key === 'a')
    const { data, store } = await run(services, graph(), {
      input: { data: 1 },
      only: ['b'],
      checkpoints: upstream,
    })
    expect(data('b')).toBe(20)
    expect([fake.count('a'), fake.count('b')]).toEqual([0, 1])
    expect([...store.results.keys()]).toEqual(['b'])
  })

  it("doesn't go on to the error handler when the block fails; runs a handler block with a test failure (M28)", async () => {
    const def = wf(
      [
        code('boom', 'throw new Error("no")'),
        { name: 'errorHandler', type: 'errorTrigger' },
        code('notify', 'return errorHandler.data.code'),
      ],
      [
        ['startTrigger', 'boom'],
        ['errorHandler', 'notify'],
      ],
    )
    const failed = await run(services, def, { only: ['boom'] })
    expect(failed.outcome.status).toBe('failed')
    expect(failed.statuses).toEqual({ startTrigger: 'succeeded', boom: 'failed' })
    const handler = await run(services, def, { only: ['notify'] })
    expect(handler.outcome.status).toBe('succeeded')
    expect(handler.statuses).toEqual({ errorHandler: 'succeeded', notify: 'succeeded' })
    expect(handler.data('notify')).toBe('test')
  })

  it('fails when a target does not exist', async () => {
    const { outcome } = await run(services, graph(), { only: ['nope'] })
    expect(outcome.error).toEqual({ code: 'invalid_target', message: 'No block is named "nope"' })
  })
})

describe('results, logs and validation', () => {
  it('stores results as plain JSON', async () => {
    const { data, outcome } = await run(
      services,
      wf([fakeQ('when', { date: true })], [['startTrigger', 'when']]),
    )
    expect(data('when')).toEqual({ at: '1970-01-01T00:00:00.000Z' })
    expect(outcome.results.get('when')!.sizeBytes).toBe(
      JSON.stringify({ at: '1970-01-01T00:00:00.000Z' }).length,
    )
  })

  it('refuses results over 10 MB', async () => {
    const { outcome } = await run(
      services,
      wf([code('huge', 'return "x".repeat(11 * 1024 * 1024)')], [['startTrigger', 'huge']]),
    )
    expect(outcome.error).toMatchObject({ code: 'too_large', block: 'huge' })
  })

  it('captures console output per block, with secrets scrubbed', async () => {
    const { store } = await run(
      services,
      wf(
        [
          code(
            'chatty',
            'console.log("token", configVars.TOKEN, { n: 1 }); console.warn("careful"); return 1',
          ),
        ],
        [['startTrigger', 'chatty']],
      ),
      {
        globals: { configVars: { TOKEN: 'hunter22' } },
        secrets: ['hunter22'],
      },
    )
    expect(store.logs).toEqual([
      { blockKey: 'chatty', level: 'log', message: 'token [REDACTED] {"n":1}' },
      { blockKey: 'chatty', level: 'warn', message: 'careful' },
    ])
  })

  it('filters with value and index', async () => {
    const { data, outcome } = await run(
      services,
      wf([filter('keep', '{{ startTrigger.data }}', 'value.ok && index > 0')], [['startTrigger', 'keep']]),
      {
        input: {
          data: [
            { ok: true, n: 0 },
            { ok: true, n: 1 },
            { ok: false, n: 2 },
          ],
        },
      },
    )
    expect(data('keep')).toEqual([{ ok: true, n: 1 }])
    expect(outcome.results.get('keep')!.metadata).toEqual({ inputCount: 3, outputCount: 1 })
  })

  it('fails a filter whose input is not an array', async () => {
    const { outcome } = await run(
      services,
      wf([filter('keep', '{{ startTrigger.data }}', 'value')], [['startTrigger', 'keep']]),
      { input: { data: { not: 'an array' } } },
    )
    expect(outcome.error).toMatchObject({
      code: 'invalid_input',
      message: 'The filter input must be an array, not an object',
    })
  })

  it('refuses an invalid definition before running anything', async () => {
    const { outcome, store } = await run(
      services,
      wf(
        [code('a', 'return b.data'), code('b', 'return 1')],
        [
          ['startTrigger', 'a'],
          ['a', 'b'],
        ],
      ),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error!.code).toBe('invalid_definition')
    expect(outcome.error!.message).toBe('The workflow isn\'t valid: "b" doesn\'t run before "a"')
    expect(store.events).toEqual([])
  })
})
