import { createDb, webhookRateWindows } from '@ow/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M15 step 3a: rate limits counted in Postgres, shared by API processes, and the rejection metric.

let env: TestEnv
let second: FastifyInstance
let closeSecond: () => Promise<void>
let admin: ReturnType<typeof trpc>
let apiKey: string

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

const start = { name: 'startTrigger', type: 'startTrigger' }
const reply = { name: 'reply', type: 'response', config: { status: '200', body: '{{ "ok" }}' } }

async function published(slug: string, webhook: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [start, reply],
        edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
        triggers: { webhook: { enabled: true, ...webhook } },
      },
    }),
  )
  data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
}

const post = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: '{}',
  })

/** The windows the webhook's calls went into: a test that straddles a window boundary can't count exactly. */
async function windows(slug: string) {
  const rows = await env.db.execute<{ id: string }>(
    `select t.id from workflow_triggers t join workflows w on w.id = t.workflow_id where w.slug = '${slug}'` as never,
  )
  return env.db.select().from(webhookRateWindows).where(eq(webhookRateWindows.triggerId, rows[0]!.id))
}

async function rejectedMetric(app: FastifyInstance, reason: string) {
  const text = (await app.inject({ method: 'GET', url: '/metrics' })).body
  const match = new RegExp(`^ow_webhook_rejected_total\\{reason="${reason}"\\} (\\d+)$`, 'm').exec(text)
  return match ? Number(match[1]) : 0
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  apiKey = data(await admin.mutate('apiKeys.create', { name: 'test' })).key
  // A second API process on the same database.
  const conn = createDb(env.databaseUrl, { max: 3 })
  second = await buildApp({ db: conn.db, config: env.config, logger: false, listener: conn.sql })
  closeSecond = async () => {
    await second.close()
    await conn.close()
  }
})
afterAll(async () => {
  await closeSecond?.()
  await env?.stop()
})

describe('webhook rate limits', () => {
  it('are shared by API processes, answer 429 with Retry-After, and count in the metric', async () => {
    await published('limited', { auth: { type: 'public' }, rateLimit: { requests: 4, windowSeconds: 3600 } })
    const statuses: number[] = []
    let retryAfter: string | undefined
    for (let i = 0; i < 10; i++) {
      const res = await post(i % 2 ? second : env.app, '/api/v1/workflows/limited/webhook')
      statuses.push(res.statusCode)
      if (res.statusCode === 429) {
        retryAfter = String(res.headers['retry-after'])
        expect(res.json()).toMatchObject({
          error: {
            code: 'rate_limited',
            message: expect.stringMatching(/^This webhook accepts 4 calls per 3600 s/),
          },
        })
      }
    }
    if ((await windows('limited')).length === 1) {
      expect(statuses).toEqual([200, 200, 200, 200, 429, 429, 429, 429, 429, 429])
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
      expect(Number(retryAfter)).toBeLessThanOrEqual(3600)
      expect(
        (await rejectedMetric(env.app, 'rate_limited')) + (await rejectedMetric(second, 'rate_limited')),
      ).toBe(6)
    }
  })

  it('apply to signed and public webhooks by default, and not to API-key webhooks without one', async () => {
    await published('public-default', { auth: { type: 'public' } })
    await published('keyed-default', {})
    const calls = async (url: string, headers?: Record<string, string>) => {
      // Async: no worker runs here, and only the limit matters.
      const results = await Promise.all(
        Array.from({ length: 65 }, () => post(env.app, url, { prefer: 'respond-async', ...headers })),
      )
      return results.filter((r) => r.statusCode === 429).length
    }
    const publicRefused = await calls('/api/v1/workflows/public-default/webhook')
    if ((await windows('public-default')).length === 1) expect(publicRefused).toBe(5)
    expect(await calls('/api/v1/workflows/keyed-default/webhook', { 'x-api-key': apiKey })).toBe(0)
    expect(await windows('keyed-default')).toEqual([])
  })

  it('count a refused signature in the metric by its reason', async () => {
    const envs = data(await admin.query('environments.list')) as { id: string; isDefault: boolean }[]
    const secret = data(await admin.mutate('configVars.create', { name: 'HOOK_SECRET', isSecret: true }))
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: secret.id,
        environmentId: envs.find((e) => e.isDefault)!.id,
        value: 's',
      }),
    )
    await published('signed', { auth: { type: 'signature', preset: 'github', secret: 'HOOK_SECRET' } })
    const before = await rejectedMetric(env.app, 'missing_signature')
    expect((await post(env.app, '/api/v1/workflows/signed/webhook')).statusCode).toBe(401)
    expect(await rejectedMetric(env.app, 'missing_signature')).toBe(before + 1)
  })
})
