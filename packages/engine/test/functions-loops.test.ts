/**
 * Golden semantics for M5's functions and loops (architecture §2.2), on the in-memory store. The Postgres side
 * (iteration checkpoints, the 10k-iteration crash) is in loops-pg.test.ts and crash.test.ts.
 */
import type { WorkflowDefinition } from '@ow/definition'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRunStore, RunCancelledError } from '../src'
import { code, fakeQ, run, testServices, wf } from './helpers'

const t = testServices()
const { services, fake } = t
beforeEach(() => t.reset())
afterAll(() => t.close())

type Edge = [string, string, string?]
const edges = (list: Edge[]) => list.map(([from, to, port = 'out']) => ({ from, port, to }))
const withFunctions = (def: WorkflowDefinition, functions: object[]) =>
  ({ ...def, functions }) as WorkflowDefinition
const fn = (name: string, params: string[], blocks: object[], list: Edge[] = [], extra: object = {}) => ({
  name,
  params: params.map((p) => ({ name: p })),
  blocks,
  edges: edges(list),
  ...extra,
})
const callFn = (name: string, fnName: string, params: Record<string, string>, settings?: object) => ({
  name,
  type: 'function',
  config: { function: fnName, params },
  ...(settings && { settings }),
})
const loop = (name: string, input: string, runner: object, extra: object = {}, settings?: object) => ({
  name,
  type: 'loop',
  config: { input, runner, ...extra },
  ...(settings && { settings }),
})

/** `total(a, b)`: two roots joined, returning their sum; logs on the way. */
const total = fn(
  'total',
  ['a', 'b'],
  [
    code('left', 'console.log("left", params.a); return params.a'),
    code('right', 'return params.b'),
    code('sum', 'return left.data + right.data'),
  ],
  [
    ['left', 'sum'],
    ['right', 'sum'],
  ],
)

describe('functions', () => {
  it('runs a function from a Function block, starting at every root, and returns its last block', async () => {
    const { outcome, data, store } = await run(
      services,
      withFunctions(
        wf(
          [callFn('call', 'total', { a: '{{ startTrigger.data.x }}', b: '{{ 2 }}' })],
          [['startTrigger', 'call']],
        ),
        [total],
      ),
      { input: { data: { x: 40 } } },
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('call')).toBe(42)
    // Function calls aren't checkpointed: only the workflow's blocks reach the store; logs go to the caller.
    expect([...store.results.keys()]).toEqual(['startTrigger', 'call'])
    expect(store.logs).toEqual([{ blockKey: 'call', level: 'log', message: 'total.left: left 40' }])
  })

  it('lets code await functions with positional arguments, concurrently', async () => {
    const { data } = await run(
      services,
      withFunctions(
        wf(
          [
            code(
              'a',
              'const [x, y] = await Promise.all([total(1, 2), total(10, 20)]); return [x, y, await total(5)]',
            ),
          ],
          [['startTrigger', 'a']],
        ),
        [total],
      ),
    )
    // A missing argument is null: 5 + null = 5.
    expect(data('a')).toEqual([3, 30, 5])
  })

  it('calls functions from functions, returns the chosen block and null when it was skipped', async () => {
    const pick = fn(
      'pick',
      ['n'],
      [
        { name: 'big', type: 'branch', config: { conditions: [{ id: 'yes', expression: 'params.n > 10' }] } },
        code('shout', 'return "big " + params.n'),
        code('after', 'return "never the result"'),
      ],
      [
        ['big', 'shout', 'cond:yes'],
        ['big', 'after', 'else'],
      ],
      { returns: 'shout' },
    )
    const outer = fn('outer', ['n'], [code('go', 'return [await pick(params.n), await total(params.n, 1)]')])
    const { data } = await run(
      services,
      withFunctions(wf([code('a', 'return [await outer(50), await outer(5)]')], [['startTrigger', 'a']]), [
        total,
        pick,
        outer,
      ]),
    )
    expect(data('a')).toEqual([
      ['big 50', 51],
      [null, 6],
    ])
  })

  it('fails the calling block when the function fails, naming the function and its block', async () => {
    const broken = fn('broken', [], [code('inner', 'throw new Error("no stock")')])
    const { outcome, statuses } = await run(
      services,
      withFunctions(
        wf(
          [
            callFn('call', 'broken', {}, { finally: 'continue' }),
            code('caught', 'return call.error.message'),
          ],
          [
            ['startTrigger', 'call'],
            ['call', 'caught', 'error'],
          ],
        ),
        [broken],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(statuses).toMatchObject({ call: 'errored', caught: 'succeeded' })
    expect(outcome.results.get('call')!.error).toMatchObject({
      code: 'function_failed',
      message: 'broken.inner: no stock',
      details: { function: 'broken', block: 'inner' },
    })

    const fromCode = await run(
      services,
      withFunctions(
        wf([code('a', 'try { await broken() } catch (e) { return e.message }')], [['startTrigger', 'a']]),
        [broken],
      ),
    )
    expect(fromCode.data('a')).toBe('broken.inner: no stock')
  })

  it('runs queries inside functions against the run environment', async () => {
    const load = fn('load', ['id'], [fakeQ('q', { value: '{{ params.id * 2 }}' })])
    const { data } = await run(
      services,
      withFunctions(wf([callFn('call', 'load', { id: '{{ 21 }}' })], [['startTrigger', 'call']]), [load]),
    )
    expect(data('call')).toBe(42)
  })
})

describe('loops', () => {
  it('runs a query runner in parallel, up to the concurrency, keeping the input order', async () => {
    const { outcome, data } = await run(
      services,
      wf(
        [
          loop(
            'each',
            '{{ [5, 4, 3, 2, 1, 0] }}',
            {
              kind: 'query',
              resource: 'fake',
              query: { id: 'q', value: '{{ value * 10 + index }}', delayMs: 50 },
            },
            { concurrency: 3 },
          ),
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('each')).toEqual([50, 41, 32, 23, 14, 5])
    expect(fake.maxActive).toBe(3)
    expect(outcome.results.get('each')!.metadata).toEqual({
      iterations: { total: 6, succeeded: 6, failed: 0, resumed: 0 },
    })
  })

  it('runs one at a time when sequential, and in batches with a pause between them', async () => {
    const runner = { kind: 'query', resource: 'fake', query: { id: 'q', delayMs: 20 } }
    await run(
      services,
      wf([loop('each', '{{ [1, 2, 3, 4] }}', runner, { mode: 'sequential' })], [['startTrigger', 'each']]),
    )
    expect(fake.maxActive).toBe(1)

    t.reset()
    const started = Date.now()
    await run(
      services,
      wf(
        [loop('each', '{{ [1, 2, 3, 4, 5] }}', runner, { mode: 'batch', batchSize: 2, batchDelayMs: 100 })],
        [['startTrigger', 'each']],
      ),
    )
    expect(fake.maxActive).toBe(2)
    // Three batches, two pauses.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(fake.timeline.filter((e) => e.startsWith('start')).length).toBe(5)
  })

  it('runs code and function runners with value and index', async () => {
    const { data } = await run(
      services,
      withFunctions(
        wf(
          [
            code('rows', 'return [{ a: 1, b: 2 }, { a: 3, b: 4 }]'),
            loop('codeEach', '{{ rows.data }}', {
              kind: 'code',
              code: 'return { i: index, sum: await total(value.a, value.b) }',
            }),
            loop('fnEach', '{{ rows.data }}', {
              kind: 'function',
              function: 'total',
              params: { a: '{{ value.a }}', b: '{{ index }}' },
            }),
          ],
          [
            ['startTrigger', 'rows'],
            ['rows', 'codeEach'],
            ['rows', 'fnEach'],
          ],
        ),
        [total],
      ),
    )
    expect(data('codeEach')).toEqual([
      { i: 0, sum: 3 },
      { i: 1, sum: 7 },
    ])
    expect(data('fnEach')).toEqual([1, 4])
  })

  it('fails the loop on a failed iteration and aborts the others (onError: stop)', async () => {
    const { outcome } = await run(
      services,
      wf(
        [
          loop('each', '{{ [0, 1, 2, 3] }}', {
            kind: 'code',
            code: 'if (value === 1) throw new Error("bad item"); return value',
          }),
          loop('slowOnes', '{{ each.data }}', { kind: 'query', resource: 'fake', query: { id: 'q' } }),
        ],
        [
          ['startTrigger', 'each'],
          ['each', 'slowOnes'],
        ],
      ),
    )
    expect(outcome.error).toMatchObject({
      block: 'each',
      code: 'iteration_failed',
      message: 'Iteration 1 failed: bad item',
      details: { index: 1, error: { code: 'runtime' } },
    })

    // The other iterations still running are aborted, so the loop fails at once.
    t.reset()
    const started = Date.now()
    const aborting = await run(
      services,
      withFunctions(
        wf(
          [
            loop('each', '{{ [0, 1, 2] }}', {
              kind: 'code',
              code: 'if (value === 0) { await pause(); throw new Error("bad item") }\nreturn await slow()',
            }),
          ],
          [['startTrigger', 'each']],
        ),
        [fn('slow', [], [fakeQ('s', { delayMs: 5000 })]), fn('pause', [], [fakeQ('p', { delayMs: 200 })])],
      ),
    )
    expect(aborting.outcome.error).toMatchObject({ code: 'iteration_failed', details: { index: 0 } })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(fake.aborted).toEqual(['s', 's'])
  })

  it('leaves null in a failed slot and lists the failure (onError: continue)', async () => {
    const { outcome, data } = await run(
      services,
      wf(
        [
          loop(
            'each',
            '{{ [0, 1, 2] }}',
            { kind: 'code', code: 'if (index === 1) throw new Error("bad item"); return value * 2' },
            { onError: 'continue' },
          ),
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('each')).toEqual([0, null, 4])
    expect(outcome.results.get('each')!.metadata).toEqual({
      iterations: { total: 3, succeeded: 2, failed: 1, resumed: 0 },
      failures: [
        { index: 1, error: expect.objectContaining({ message: expect.stringContaining('bad item') }) },
      ],
    })
  })

  it('retries an iteration and times it out on its own settings', async () => {
    const { data, store } = await run(
      services,
      wf(
        [
          loop(
            'each',
            '{{ [1, 2] }}',
            { kind: 'query', resource: 'fake', query: { id: 'q', failTimes: 1, value: '{{ value }}' } },
            { mode: 'sequential', iteration: { retry: { count: 1, intervalMs: 10 } } },
          ),
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(data('each')).toEqual([1, 2])
    expect(store.logs.map((l) => l.message)).toEqual([
      expect.stringMatching(/^\[0\] Attempt 1 failed: call 1 failed/),
    ])

    t.reset()
    const timed = await run(
      services,
      wf(
        [
          loop(
            'each',
            '{{ [1] }}',
            { kind: 'query', resource: 'fake', query: { id: 'slow', delayMs: 2000 } },
            { onError: 'continue', iteration: { timeoutMs: 100 } },
          ),
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(timed.data('each')).toEqual([null])
    expect(timed.outcome.results.get('each')!.metadata.failures).toEqual([
      { index: 0, error: { code: 'timeout', message: 'The iteration timed out after 100 ms' } },
    ])
    expect(fake.aborted).toEqual(['slow'])
  })

  it('checkpoints each iteration and resumes only the ones not committed', async () => {
    const definition = wf(
      [
        loop(
          'each',
          '{{ _.range(10) }}',
          { kind: 'query', resource: 'fake', query: { id: 'q', value: '{{ value * value }}' } },
          { mode: 'sequential' },
        ),
      ],
      [['startTrigger', 'each']],
    )
    const first = await run(services, definition)
    expect(first.data('each')).toEqual([0, 1, 4, 9, 16, 25, 36, 49, 64, 81])
    const keys = [...first.store.results.keys()]
    expect(keys).toContain('each[0]')
    expect(keys).toContain('each[9]')
    expect(keys.indexOf('each[9]')).toBeLessThan(keys.indexOf('each'))

    // A lease that committed iterations 0–5 and then died: the resumed run only runs 6–9.
    const committed = first.store
      .checkpoints()
      .filter((r) => r.key === 'startTrigger' || /^each\[[0-5]\]$/.test(r.key))
    t.reset()
    const resumed = await run(services, definition, { checkpoints: committed })
    expect(resumed.data('each')).toEqual([0, 1, 4, 9, 16, 25, 36, 49, 64, 81])
    expect(fake.count('q')).toBe(4)
    expect(resumed.outcome.results.get('each')!.metadata).toMatchObject({ iterations: { resumed: 6 } })
  })

  it('refuses an input that isnt an array, and stops in-flight iterations when cancelled', async () => {
    const bad = await run(
      services,
      wf([loop('each', '{{ 5 }}', { kind: 'code', code: 'return 1' })], [['startTrigger', 'each']]),
    )
    expect(bad.outcome.error).toMatchObject({
      code: 'invalid_input',
      message: 'The loop input must be an array, not 5',
    })

    const controller = new AbortController()
    setTimeout(() => controller.abort(new RunCancelledError()), 100)
    const cancelled = await run(
      services,
      wf(
        [
          loop('each', '{{ [1, 2, 3] }}', {
            kind: 'query',
            resource: 'fake',
            query: { id: 'q', delayMs: 5000 },
          }),
        ],
        [['startTrigger', 'each']],
      ),
      { signal: controller.signal, store: new MemoryRunStore() },
    )
    expect(cancelled.outcome.status).toBe('cancelled')
    expect(cancelled.statuses).toMatchObject({ each: 'cancelled' })
    expect(fake.aborted).toEqual(['q', 'q', 'q'])
  })
})
