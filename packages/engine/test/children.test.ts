/**
 * Golden semantics for M5's Workflow block and loop workflow runner (architecture §2.2), with fake child runs. The
 * Postgres side (child rows, waking the parent, cancel cascading) is in children-pg.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { code, FakeChildren, run, testServices, wf } from './helpers'

const t = testServices()
beforeEach(() => t.reset())
afterAll(() => t.close())

const child = (name: string, workflow: string, extra: object = {}, settings?: object) => ({
  name,
  type: 'workflow',
  config: { workflow, ...extra },
  ...(settings && { settings }),
})

function services(children: FakeChildren) {
  return { ...t.services, children }
}

describe('the Workflow block', () => {
  it('runs a child and returns its Response body, starting it once per block attempt', async () => {
    const children = new FakeChildren({
      greet: (input) => ({ body: { hello: (input as { name: string }).name } }),
    })
    const { outcome, data } = await run(
      services(children),
      wf(
        [
          child('call', 'greet', { input: '{"name": {{ startTrigger.data.who }}}' }),
          code('after', 'return call.data.hello'),
        ],
        [
          ['startTrigger', 'call'],
          ['call', 'after'],
        ],
      ),
      { input: { data: { who: 'Ada' } } },
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('after')).toBe('Ada')
    expect(outcome.results.get('call')!.metadata).toEqual({
      runId: 'child-1',
      workflow: 'greet',
      status: 'succeeded',
      responseStatus: 200,
    })
    expect(children.started).toEqual([
      { workflow: 'greet', input: { name: 'Ada' }, key: 'child:run-1:call:1', runId: 'child-1' },
    ])
  })

  it('returns { runId } at once in async mode', async () => {
    const children = new FakeChildren({ slow: { delayMs: 60_000 } })
    const { outcome, data } = await run(
      services(children),
      wf([child('fire', 'slow', { mode: 'async' })], [['startTrigger', 'fire']]),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('fire')).toEqual({ runId: 'child-1' })
  })

  it('fails when the child fails or is unknown, and starts a new child per retry', async () => {
    const children = new FakeChildren({ broken: { fail: 'no stock' } })
    const { outcome } = await run(
      services(children),
      wf([child('call', 'broken', {}, { retry: { count: 1, intervalMs: 10 } })], [['startTrigger', 'call']]),
    )
    expect(outcome.error).toMatchObject({
      block: 'call',
      code: 'child_failed',
      message: 'Workflow "broken" failed: no stock',
      details: { runId: 'child-2' },
    })
    expect(children.started.map((s) => s.key)).toEqual(['child:run-1:call:1', 'child:run-1:call:2'])

    const unknown = await run(
      services(new FakeChildren({})),
      wf([child('call', 'nope')], [['startTrigger', 'call']]),
    )
    expect(unknown.outcome.error).toMatchObject({
      code: 'unknown_workflow',
      message: 'No workflow has the slug "nope"',
    })

    const without = await run(t.services, wf([child('call', 'broken')], [['startTrigger', 'call']]))
    expect(without.outcome.error).toMatchObject({ code: 'unsupported' })
  })

  it('pauses the run while a slow child runs, and picks up the same child when resumed', async () => {
    const children = new FakeChildren({ slow: { body: 'done', delayMs: 3000 } })
    const definition = wf(
      [child('call', 'slow'), code('after', 'return call.data')],
      [
        ['startTrigger', 'call'],
        ['call', 'after'],
      ],
    )
    const started = Date.now()
    const first = await run(services(children), definition)
    expect(first.outcome.status).toBe('waiting')
    // It waited ~2 s here first, then paused until its recheck (an hour, or the block's timeout).
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    const state = first.store.waits.get('call')!
    expect(state).toMatchObject({ childRunId: 'child-1', since: expect.any(Date) })
    expect(state.until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000)

    // Woken when the child ends: same child, no second start.
    await new Promise((r) => setTimeout(r, 1200))
    const resumed = await run(services(children), definition, {
      checkpoints: first.store.checkpoints(),
      waits: first.store.waits,
    })
    expect(resumed.outcome.status).toBe('succeeded')
    expect(resumed.data('after')).toBe('done')
    expect(children.started).toHaveLength(1)
  })

  it('fails and cancels the child when it outlasts the block timeout', async () => {
    // A short timeout runs out here.
    const children = new FakeChildren({ slow: { delayMs: 60_000 } })
    const started = Date.now()
    const short = await run(
      services(children),
      wf([child('call', 'slow', {}, { timeoutMs: 1000 })], [['startTrigger', 'call']]),
    )
    expect(short.outcome.error).toMatchObject({
      code: 'timeout',
      message: 'Workflow "slow" didn\'t finish within 1000 ms',
    })
    expect(Date.now() - started).toBeLessThan(1600)
    expect(children.cancelled).toEqual(['child-1'])

    // A longer one pauses the run until the timeout, which then fails the block when it resumes.
    const definition = wf([child('call', 'slow', {}, { timeoutMs: 5000 })], [['startTrigger', 'call']])
    const later = new FakeChildren({ slow: { delayMs: 60_000 } })
    const first = await run(services(later), definition)
    expect(first.outcome.status).toBe('waiting')
    const state = first.store.waits.get('call')!
    expect(first.outcome.resumeAt!.getTime() - state.since!.getTime()).toBe(5000)
    const resumed = await run(services(later), definition, {
      checkpoints: first.store.checkpoints(),
      waits: new Map([['call', { ...state, since: new Date(Date.now() - 6000) }]]),
    })
    expect(resumed.outcome.error).toMatchObject({ code: 'timeout' })
    expect(later.cancelled).toEqual(['child-1'])
  })

  it('looks at the child again while other blocks keep the run here', async () => {
    // Waits 2 s, parks, looks again at ~4 s (the child ended at 3 s) while `busy` still runs until 5 s.
    const children = new FakeChildren({ slow: { body: 'late', delayMs: 3000 } })
    const { outcome, data } = await run(
      services(children),
      wf(
        [
          child('call', 'slow'),
          code('busy', 'const t = Date.now(); while (Date.now() - t < 5000) {} return 1'),
        ],
        [
          ['startTrigger', 'call'],
          ['startTrigger', 'busy'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('call')).toBe('late')
    expect(children.started).toHaveLength(1)
  })
})

describe('the loop workflow runner', () => {
  it('runs a child per item, sync or async, keyed per iteration attempt', async () => {
    const children = new FakeChildren({
      double: (input) => ({ body: (input as { n: number }).n * 2, delayMs: 100 }),
    })
    const { data } = await run(
      services(children),
      wf(
        [
          {
            name: 'each',
            type: 'loop',
            config: {
              input: '{{ [1, 2, 3] }}',
              runner: { kind: 'workflow', workflow: 'double', input: '{"n": {{ value }}}' },
            },
          },
          {
            name: 'fire',
            type: 'loop',
            config: {
              input: '{{ [1, 2] }}',
              runner: { kind: 'workflow', workflow: 'double', input: '{"n": {{ value }}}', mode: 'async' },
            },
          },
        ],
        [
          ['startTrigger', 'each'],
          ['startTrigger', 'fire'],
        ],
      ),
    )
    expect(data('each')).toEqual([2, 4, 6])
    expect((data('fire') as { runId: string }[]).map((r) => typeof r.runId)).toEqual(['string', 'string'])
    expect(children.started.map((s) => s.key).sort()).toEqual([
      'child:run-1:each[0]:1',
      'child:run-1:each[1]:1',
      'child:run-1:each[2]:1',
      'child:run-1:fire[0]:1',
      'child:run-1:fire[1]:1',
    ])
  })

  it('cancels a child whose iteration times out', async () => {
    const children = new FakeChildren({ slow: { delayMs: 60_000 } })
    const { outcome } = await run(
      services(children),
      wf(
        [
          {
            name: 'each',
            type: 'loop',
            config: {
              input: '{{ [1] }}',
              runner: { kind: 'workflow', workflow: 'slow' },
              iteration: { timeoutMs: 300 },
              onError: 'continue',
            },
          },
        ],
        [['startTrigger', 'each']],
      ),
    )
    expect(outcome.results.get('each')!.data).toEqual([null])
    expect(children.cancelled).toEqual(['child-1'])
  })
})
