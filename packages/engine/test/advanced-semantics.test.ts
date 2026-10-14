/**
 * Golden semantics for M5's Wait, global error handler and cancel (architecture §2.2), on the in-memory store.
 * Their Postgres side (pausing, resuming, cancelling across processes) is in waiting.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRunStore, RunCancelledError } from '../src'
import { code, errorTrigger, fakeQ, response, run, testServices, wait, waitUntil, wf } from './helpers'

const t = testServices()
const { services, fake } = t
beforeEach(() => t.reset())
afterAll(() => t.close())

describe('wait', () => {
  it('finishes a short wait in the process', async () => {
    const started = Date.now()
    const { outcome, statuses, store } = await run(
      services,
      wf(
        [wait('pause', '0.2'), code('after', 'return 1')],
        [
          ['startTrigger', 'pause'],
          ['pause', 'after'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(statuses).toMatchObject({ pause: 'succeeded', after: 'succeeded' })
    expect(store.events.map((e) => `${e.type} ${e.key}`)).toContain('waiting pause')
    expect(outcome.results.get('pause')!.metadata.until).toEqual(expect.any(String))
  })

  it('pauses the run when only waits are left, and resumes at the stored time', async () => {
    const definition = wf(
      [wait('pause', '{{ startTrigger.data.minutes }}', 'minutes'), code('after', 'return "resumed"')],
      [
        ['startTrigger', 'pause'],
        ['pause', 'after'],
      ],
    )
    const before = Date.now()
    const first = await run(services, definition, { input: { data: { minutes: 5 } } })
    expect(first.outcome.status).toBe('waiting')
    const resumeAt = first.outcome.resumeAt!.getTime()
    expect(resumeAt - before).toBeGreaterThanOrEqual(5 * 60_000)
    expect(resumeAt - before).toBeLessThan(5 * 60_000 + 2000)
    expect(first.statuses).toEqual({ startTrigger: 'succeeded' })
    expect(first.store.waits.get('pause')!.until.getTime()).toBe(resumeAt)

    // Too early: still waiting, for the same time (the template isn't evaluated again, so new input changes nothing).
    const early = await run(services, definition, {
      input: { data: { minutes: 1 } },
      checkpoints: first.store.checkpoints(),
      waits: first.store.waits,
    })
    expect(early.outcome).toMatchObject({ status: 'waiting', resumeAt: new Date(resumeAt) })

    // Due: the wait finishes and the run carries on.
    const due = new Map([['pause', { until: new Date(Date.now() - 1) }]])
    const resumed = await run(services, definition, { checkpoints: first.store.checkpoints(), waits: due })
    expect(resumed.outcome.status).toBe('succeeded')
    expect(resumed.data('after')).toBe('resumed')
    expect(resumed.store.events.filter((e) => e.type === 'started').map((e) => e.key)).toEqual(['after'])
  })

  it('keeps running other branches, and pauses once only waits are left', async () => {
    const { outcome, statuses, store } = await run(
      services,
      wf(
        [wait('pause', '10'), fakeQ('slow', { delayMs: 300 }), code('after', 'return 1')],
        [
          ['startTrigger', 'pause'],
          ['startTrigger', 'slow'],
          ['pause', 'after'],
        ],
      ),
    )
    expect(outcome.status).toBe('waiting')
    expect(statuses).toEqual({ startTrigger: 'succeeded', slow: 'succeeded' })
    const order = store.events.map((e) => `${e.type} ${e.key}`)
    expect(order.indexOf('waiting pause')).toBeLessThan(order.indexOf('finished slow'))
  })

  it('waits until a time, and fails on a bad or too distant one', async () => {
    const past = await run(
      services,
      wf([waitUntil('pause', '2020-01-01T00:00:00Z')], [['startTrigger', 'pause']]),
    )
    expect(past.outcome.status).toBe('succeeded')
    expect(past.outcome.results.get('pause')!.metadata.until).toBe('2020-01-01T00:00:00.000Z')

    const bad = await run(services, wf([waitUntil('pause', '{{ "soon" }}')], [['startTrigger', 'pause']]))
    expect(bad.outcome.error).toMatchObject({ code: 'invalid_wait', block: 'pause' })
    const far = await run(services, wf([wait('pause', '{{ 61 }}', 'days')], [['startTrigger', 'pause']]))
    expect(far.outcome.error).toMatchObject({
      code: 'invalid_wait',
      message: 'A wait can last at most 60 days',
    })
  })
})

describe('the global error handler', () => {
  const failing = fakeQ('load', { failTimes: 1 })

  it('runs its path when a block fails, reading the failure and the main path; the run still fails', async () => {
    const { outcome, statuses, data } = await run(
      services,
      wf(
        [
          failing,
          code('never', 'return 1'),
          errorTrigger(),
          code(
            'report',
            'return { failure: onFailure.data, loadError: load.error.code, input: startTrigger.data, never: never.metadata.status }',
          ),
          response('reply', '{"failed": {{ onFailure.data.block }}}', '503'),
        ],
        [
          ['startTrigger', 'load'],
          ['load', 'never'],
          ['onFailure', 'report'],
          ['report', 'reply'],
        ],
      ),
      { input: { data: { id: 3 } } },
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'query', block: 'load' })
    expect(statuses).toEqual({
      startTrigger: 'succeeded',
      load: 'failed',
      onFailure: 'succeeded',
      report: 'succeeded',
      reply: 'succeeded',
    })
    expect(data('report')).toEqual({
      failure: { block: 'load', code: 'query', message: expect.stringContaining('call 1 failed') },
      loadError: 'query',
      input: { id: 3 },
      never: 'skipped',
    })
    expect(outcome.response).toEqual({ status: 503, headers: {}, body: { failed: 'load' } })
  })

  it("doesn't run when nothing fails", async () => {
    const { outcome, statuses } = await run(
      services,
      wf(
        [code('ok', 'return 1'), errorTrigger(), code('report', 'return 1')],
        [
          ['startTrigger', 'ok'],
          ['onFailure', 'report'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(statuses).toEqual({ startTrigger: 'succeeded', ok: 'succeeded' })
  })

  it('reports the original failure when the handler fails too', async () => {
    const { outcome, statuses } = await run(
      services,
      wf(
        [failing, errorTrigger(), code('report', 'throw new Error("handler broke")')],
        [
          ['startTrigger', 'load'],
          ['onFailure', 'report'],
        ],
      ),
    )
    expect(outcome.error).toMatchObject({ code: 'query', block: 'load' })
    expect(statuses).toMatchObject({ load: 'failed', onFailure: 'succeeded', report: 'failed' })
  })

  it('runs after a run timeout, with its own time limit', async () => {
    const { outcome, statuses, data } = await run(
      services,
      wf(
        [
          fakeQ('slow', { delayMs: 5_000 }),
          errorTrigger(),
          code('report', 'return onFailure.data.code'),
          fakeQ('stuck', { delayMs: 5_000 }),
        ],
        [
          ['startTrigger', 'slow'],
          ['onFailure', 'report'],
          ['report', 'stuck'],
        ],
      ),
      { deadline: new Date(Date.now() + 200), handlerTimeoutMs: 300 },
    )
    expect(outcome.error).toMatchObject({ code: 'run_timeout' })
    expect(statuses).toMatchObject({ slow: 'cancelled', report: 'succeeded', stuck: 'cancelled' })
    expect(data('report')).toBe('run_timeout')
    expect(fake.aborted).toEqual(['slow', 'stuck'])
  })

  it('carries on with the handler when a run resumes after its failure', async () => {
    const definition = wf(
      [failing, errorTrigger(), code('first', 'return 1'), code('second', 'return first.data + 1')],
      [
        ['startTrigger', 'load'],
        ['onFailure', 'first'],
        ['first', 'second'],
      ],
    )
    // An earlier lease recorded the failure, the handler's data and its first block, then died.
    const store = new MemoryRunStore((e) => {
      if (e.type === 'started' && e.key === 'second') throw new Error('worker died')
    })
    const first = await run(services, definition, { store })
    expect(first.outcome.status).toBe('interrupted')

    const resumed = await run(services, definition, { checkpoints: store.checkpoints() })
    expect(resumed.outcome).toMatchObject({ status: 'failed', error: { block: 'load', code: 'query' } })
    expect(resumed.data('second')).toBe(2)
    expect(resumed.store.events.map((e) => `${e.type} ${e.key}`)).toEqual([
      'started second',
      'finished second',
    ])
  })
})

describe('cancel', () => {
  it('aborts in-flight blocks, records them as cancelled and skips the error handler', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new RunCancelledError()), 100)
    const { outcome, statuses } = await run(
      services,
      wf(
        [
          fakeQ('slow', { delayMs: 5_000 }),
          code('after', 'return 1'),
          errorTrigger(),
          code('report', 'return 1'),
        ],
        [
          ['startTrigger', 'slow'],
          ['slow', 'after'],
          ['onFailure', 'report'],
        ],
      ),
      { signal: controller.signal },
    )
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } })
    expect(statuses).toEqual({ startTrigger: 'succeeded', slow: 'cancelled' })
    expect(fake.aborted).toEqual(['slow'])
  })

  it('cancels a waiting block, and a run cancelled before it starts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new RunCancelledError()), 100)
    const waiting = await run(services, wf([wait('pause', '0.9')], [['startTrigger', 'pause']]), {
      signal: controller.signal,
    })
    expect(waiting.outcome.status).toBe('cancelled')
    expect(waiting.statuses).toMatchObject({ pause: 'cancelled' })

    const early = await run(services, wf([code('a', 'return 1')], [['startTrigger', 'a']]), {
      signal: AbortSignal.abort(new RunCancelledError()),
    })
    expect(early.outcome.status).toBe('cancelled')
    expect(early.statuses).toEqual({})
  })

  it('still interrupts (rather than cancels) on any other abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('shutting down')), 100)
    const { outcome } = await run(
      services,
      wf([fakeQ('slow', { delayMs: 5_000 })], [['startTrigger', 'slow']]),
      {
        signal: controller.signal,
      },
    )
    expect(outcome.status).toBe('interrupted')
  })
})
