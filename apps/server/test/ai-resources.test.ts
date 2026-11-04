import { type FakeAi, startFakeAi } from '@ow/connectors/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// AI resources (M35, docs/architecture.md §2.38) through the API: settings and the key (a secret), Test, a query
// from the playground with its usage and cost, nothing of the key coming back.

let env: TestEnv
let fake: FakeAi
let admin: ReturnType<typeof trpc>
let prodId: string
const seen: string[] = []

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function resourceOf(type: string, slug: string, config: unknown, secrets: unknown) {
  const created = data(await admin.mutate('resources.create', { type, name: slug, slug }))
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config,
      secrets,
    }),
  )
  return created.id as string
}

beforeAll(async () => {
  fake = await startFakeAi()
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@example.com'), { record: seen })
  prodId = data(await admin.query('environments.list')).find(
    (e: { slug: string }) => e.slug === 'production',
  ).id
})
afterAll(async () => {
  await env?.stop()
  await fake?.stop()
})

describe('AI resources', () => {
  it('saves an Anthropic resource, tests it, and runs an extraction from the playground', async () => {
    const id = await resourceOf(
      'anthropic',
      'claude',
      { baseUrl: fake.anthropicUrl, allowPrivateNetwork: true, budgetTokens: 50_000 },
      { apiKey: fake.anthropicKey },
    )
    const tested = data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId }))
    expect(tested).toMatchObject({ ok: true, message: expect.stringContaining('claude-sonnet-5-5') })
    const ran = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: {
          action: 'extract',
          input: '{{ email }}',
          schema:
            '{"type":"object","properties":{"customer":{"type":"string"}},"required":["customer"],"additionalProperties":false}',
        },
        scope: { email: 'Hi, Ada here: 3 lamps please' },
      }),
    )
    expect(ran).toMatchObject({
      ok: true,
      data: { customer: 'customer from the text' },
      metadata: { provider: 'anthropic', model: 'claude-sonnet-5-5', costUsd: expect.any(Number) },
    })
    // The settings come back with the model filled in; the key never does.
    const resource = data(await admin.query('resources.get', { id }))
    expect(JSON.stringify(resource)).toContain('claude-sonnet-5-5')
    expect(seen.join('\n')).not.toContain(fake.anthropicKey)
  })

  it('saves an OpenAI-compatible resource, refusing settings without a model or base URL', async () => {
    const bad = await admin.mutate('resources.create', {
      type: 'openai_compatible',
      name: 'llm_bad',
      slug: 'llm_bad',
    })
    const refused = await admin.mutate('resources.saveConfig', {
      resourceId: data(bad).id,
      environmentId: prodId,
      config: { baseUrl: fake.openaiUrl },
      secrets: {},
    })
    expect(refused.status).toBe(400)
    const id = await resourceOf(
      'openai_compatible',
      'llm',
      { baseUrl: fake.openaiUrl, model: 'fake-llm', allowPrivateNetwork: true },
      { apiKey: fake.openaiKey },
    )
    const ran = data(
      await admin.mutate('resources.run', {
        resourceId: id,
        environmentId: prodId,
        query: { action: 'classify', input: 'LABEL=refund please', labels: 'refund, question' },
        scope: {},
      }),
    )
    expect(ran).toMatchObject({ ok: true, data: { label: 'refund' } })
  })
})
