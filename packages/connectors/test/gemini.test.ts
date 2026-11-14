import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectorError, configureGemini, geminiConnector, PoolManager, runQuery, testResource } from '../src'
import type { AiRunContext } from '../src/ai/core'
import { completionOf } from '../src/ai/gemini'
import { geminiPrice } from '../src/ai/prices'
import { type FakeAi, startFakeAi } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// Gemini (M37, docs/architecture.md §2.41): the Gemini API with an API key and Vertex AI with a service account, both
// through `generateContent`, against the fake.

let fake: FakeAi
let pool: PoolManager
let tokenServer: Server
/** The JWT claims the token endpoint was sent, in order. */
const assertions: Record<string, unknown>[] = []

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const serviceAccountKey = JSON.stringify({
  type: 'service_account',
  project_id: 'acme-ai',
  client_email: 'gemini@acme-ai.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
})

beforeAll(async () => {
  fake = await startFakeAi()
  pool = new PoolManager()
  tokenServer = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      const jwt = new URLSearchParams(body).get('assertion') ?? ''
      assertions.push(JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: `ya29.vertex-${assertions.length}`, expires_in: 3600 }))
    })
  })
  await new Promise<void>((r) => tokenServer.listen(0, '127.0.0.1', r))
  configureGemini({ tokenUrl: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token` })
})
afterAll(async () => {
  configureGemini({})
  await pool.closeAll()
  await fake.stop()
  await new Promise((r) => tokenServer.close(r))
})

const gemini = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = { apiKey: fake.geminiKey },
) =>
  parsed(
    resource(
      { baseUrl: fake.geminiUrl, allowPrivateNetwork: true, ...config },
      secrets,
      JSON.stringify([config, secrets]),
    ),
  )
const vertex = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = { serviceAccountKey },
) =>
  parsed(
    resource(
      {
        platform: 'vertex',
        baseUrl: fake.vertexUrl,
        allowPrivateNetwork: true,
        location: 'europe-west4',
        ...config,
      },
      secrets,
      JSON.stringify([config, secrets]),
    ),
  )

function parsed(r: ReturnType<typeof resource>) {
  return {
    ...r,
    config: geminiConnector.configSchema.parse(r.config),
    secrets: geminiConnector.secretsSchema.parse(r.secrets),
  }
}

const run = (
  r: ReturnType<typeof gemini>,
  query: Record<string, string>,
  scope: Record<string, unknown> = {},
  ai?: AiRunContext,
) => runQuery(pool, geminiConnector, r, query, { evaluate: scopeEvaluator(scope), ...(ai && { ai }) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('Expected a failure')
}

const last = (api: 'gemini' | 'vertex') =>
  [...fake.requests].reverse().find((r) => r.api === api && r.path.endsWith(':generateContent'))!

describe('Gemini API (API key)', () => {
  it('generates text with the default model, its thinking level, and says what it cost', async () => {
    const result = await run(
      gemini(),
      { action: 'generate', system: 'Be brief.', prompt: 'Hello {{ who }}', effort: 'high' },
      { who: 'Ada' },
    )
    // The fake's thought part is left out of the answer.
    expect(result.data).toBe('You said: Hello Ada')
    expect(result.metadata).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      stopReason: 'end',
      costUsd: expect.any(Number),
      request: { system: 'Be brief.', prompt: 'Hello Ada' },
    })
    // Thinking tokens count as output.
    const usage = result.metadata.usage as { outputTokens: number }
    expect(usage.outputTokens).toBeGreaterThan(7)
    const sent = last('gemini')
    expect(sent.path).toBe('/gemini/v1beta/models/gemini-3.8-flash:generateContent')
    expect(sent.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Hello Ada' }] }],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { maxOutputTokens: 16000, thinkingConfig: { thinkingLevel: 'HIGH' } },
    })
  })

  it('sends no thinking level to Gemini 2.5, which refuses one', async () => {
    await run(gemini(), { action: 'generate', prompt: 'x', model: 'gemini-2.5-flash', effort: 'low' })
    expect((last('gemini').body.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
  })

  it('extracts JSON through responseJsonSchema and classifies', async () => {
    const extracted = await run(gemini(), {
      action: 'extract',
      input: 'Ada ordered 3',
      schema:
        '{"type":"object","properties":{"name":{"type":"string"},"qty":{"type":"integer"}},"required":["name"]}',
    })
    expect(extracted.data).toEqual({ name: 'name from the text', qty: 1 })
    expect(last('gemini').body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    })
    const label = await run(gemini(), {
      action: 'classify',
      input: 'LABEL=refund',
      labels: 'question, refund',
    })
    expect(label.data).toEqual({ label: 'refund', reason: 'reason from the text' })
  })

  it('reports blocked prompts and safety stops as refusals, a cut-off answer, and retries a rate limit', async () => {
    const blocked = await failure(run(gemini(), { action: 'generate', prompt: 'BLOCK_PROMPT' }))
    expect(blocked.code).toBe('ai_refused')
    expect(blocked.message).toContain('prohibited_content')
    expect((await failure(run(gemini(), { action: 'generate', prompt: 'REFUSE_ME' }))).code).toBe(
      'ai_refused',
    )
    expect(
      (await failure(run(gemini(), { action: 'generate', prompt: 'a long answer', maxTokens: '1' }))).code,
    ).toBe('ai_max_tokens')
    expect((await run(gemini(), { action: 'generate', prompt: 'RATE_LIMIT_ONCE now' })).data).toBe(
      'You said: RATE_LIMIT_ONCE now',
    )
  })

  it('says what is wrong: a bad key, an unknown model, no key at all', async () => {
    const bad = await failure(run(gemini({}, { apiKey: 'nope' }), { action: 'generate', prompt: 'x' }))
    expect(bad.message).toContain('API key not valid')
    const missing = await failure(run(gemini(), { action: 'generate', prompt: 'x', model: 'missing-model' }))
    expect(missing.message).toMatch(/404.*check the model/)
    const none = await failure(run(gemini({}, {}), { action: 'generate', prompt: 'x' }))
    expect(none.message).toContain('Add the Gemini API key')
    // The key goes in a header, never the URL.
    expect(fake.requests.every((r) => !r.path.includes('key='))).toBe(true)
  })

  it('tests a resource by listing its models', async () => {
    expect(await testResource(geminiConnector, gemini())).toMatchObject({
      ok: true,
      message: expect.stringContaining('gemini-3.8-flash among them'),
    })
  })

  it('refuses a private address unless the resource allows it', async () => {
    const closed = parsed(resource({ baseUrl: 'http://127.0.0.1:9/v1beta' }, { apiKey: 'k' }, 'private'))
    expect((await failure(run(closed, { action: 'generate', prompt: 'x' }))).code).toBe('blocked')
  })
})

describe('Vertex AI (service account)', () => {
  it('calls the project’s model in its region with the service account’s token, cloud-platform scoped', async () => {
    const result = await run(vertex(), { action: 'generate', prompt: 'Hi' })
    expect(result.data).toBe('You said: Hi')
    const sent = last('vertex')
    expect(sent.path).toBe(
      '/vertex/v1/projects/acme-ai/locations/europe-west4/publishers/google/models/gemini-3.8-flash:generateContent',
    )
    expect(sent.authorization).toMatch(/^Bearer ya29\.vertex-/)
    expect(assertions.at(-1)).toMatchObject({
      iss: 'gemini@acme-ai.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    })
    // Another project than the key's when named.
    await run(vertex({ project: 'other-project' }), { action: 'generate', prompt: 'Hi' })
    expect(last('vertex').path).toContain('/projects/other-project/')
  })

  it('tests by counting a word’s tokens; the server identity needs the instance’s leave and a project', async () => {
    expect(await testResource(geminiConnector, vertex())).toMatchObject({
      ok: true,
      message: expect.stringContaining('acme-ai (europe-west4)'),
    })
    const server = await failure(run(vertex({ identity: 'server' }, {}), { action: 'generate', prompt: 'x' }))
    expect(server.message).toContain("doesn't let resources use its own Google identity")
  })
})

describe('the agent', () => {
  it('calls a workflow through function calling, sending the model’s turn back with its thought signature', async () => {
    const calls: unknown[] = []
    const ai: AiRunContext = {
      tools: {
        describe: async (slugs) =>
          slugs.map((name) => ({
            name,
            description: `The ${name} workflow`,
            inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
          })),
        run: async (slug, input) => {
          calls.push({ slug, input })
          return { ok: true, data: { name: 'Ada' }, runId: 'run-1' }
        },
      },
    }
    const before = fake.requests.length
    const result = await run(
      gemini(),
      { action: 'agent', prompt: 'Who is ada@example.com?', tools: 'lookup' },
      {},
      ai,
    )
    expect(calls).toEqual([{ slug: 'lookup', input: { email: 'email from the text' } }])
    // The fake says "(signature lost)" when the thought signature didn't come back.
    expect(result.data).toMatchObject({ answer: 'Done: {"name":"Ada"}' })
    const second = fake.requests.slice(before)[1]!.body
    const contents = second.contents as { role: string; parts: Record<string, unknown>[] }[]
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { name: 'lookup', response: { result: '{"name":"Ada"}' } } },
    ])
    expect(fake.requests[before]!.body.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: 'lookup',
            parametersJsonSchema: expect.objectContaining({ type: 'object' }),
          }),
        ],
      },
    ])
  })
})

describe('prices', () => {
  it('follow Google’s dates, long prompts, and versioned names', () => {
    const usage = (m: string, at: string, prompt = 1000) =>
      completionOf(
        {
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1_000_000 - prompt },
          modelVersion: m,
        },
        m,
        new Date(at),
      ).costUsd
    expect(geminiPrice('gemini-4-carbon', 10, new Date('2026-11-30T23:00:00Z'))?.input).toBe(2)
    expect(geminiPrice('gemini-4-carbon', 10, new Date('2026-12-01T00:00:00Z'))?.input).toBe(4)
    expect(geminiPrice('gemini-3.1-pro-preview', 300_000)?.input).toBe(4)
    expect(geminiPrice('gemini-3.8-flash-001', 10)?.output).toBe(3.75)
    expect(geminiPrice('unknown', 10)).toBeUndefined()
    expect(usage('gemini-3.8-flash', '2026-11-13')).toBeGreaterThan(3.7)
    expect(usage('made-up', '2026-11-13')).toBeNull()
  })
})
