import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * M4's done-when: a sync webhook answers in under 50 ms at the median, over real HTTP with the run executed in the
 * API process. Timing-sensitive, so it's left out of `pnpm test` (where every suite runs at once) and run alone:
 * `pnpm --filter @ow/server bench:webhooks` (CI does, after the tests).
 */
describe.runIf(process.env.WEBHOOK_LATENCY === '1')('sync webhook latency', () => {
  let env: TestEnv
  let address: string
  let apiKey: string

  beforeAll(async () => {
    env = await startTestApp()
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    const admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
    const ok = <T>(res: { body: { result?: { data: T }; error?: { message: string } } }): T => {
      if (!res.body.result) throw new Error(res.body.error?.message)
      return res.body.result.data
    }
    const created = ok<{ id: string }>(await admin.mutate('workflows.create', { slug: 'fast', name: 'Fast' }))
    const saved = ok<{ revision: number }>(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            { name: 'double', type: 'code', config: { code: 'return startTrigger.data.n * 2' } },
            { name: 'reply', type: 'response', config: { body: '{"n": {{ double.data }}}' } },
          ],
          edges: [
            { from: 'startTrigger', port: 'out', to: 'double' },
            { from: 'double', port: 'out', to: 'reply' },
          ],
          triggers: { webhook: { enabled: true } },
        },
      }),
    )
    ok(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
    apiKey = ok<{ key: string }>(await admin.mutate('apiKeys.create', { name: 'bench' })).key
    address = await env.app.listen({ port: 0, host: '127.0.0.1' })
  })
  afterAll(async () => {
    await env?.stop()
  })

  it('answers in under 50 ms at the median', async () => {
    const call = async (n: number) => {
      const started = performance.now()
      const res = await fetch(`${address}/api/v1/workflows/fast/webhook`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ n }),
      })
      const body = await res.json()
      const ms = performance.now() - started
      expect(body).toEqual({ n: n * 2 })
      return ms
    }
    for (let i = 0; i < 20; i++) await call(i)
    const times: number[] = []
    for (let i = 0; i < 200; i++) times.push(await call(i))
    times.sort((a, b) => a - b)
    const p = (q: number) => times[Math.floor((times.length - 1) * q)]!
    console.info(
      `sync webhook latency over ${times.length} calls: p50 ${p(0.5).toFixed(1)} ms, p90 ${p(0.9).toFixed(1)} ms, p99 ${p(0.99).toFixed(1)} ms`,
    )
    expect(p(0.5)).toBeLessThan(50)
  })
})
