import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anthropicConnector,
  ConnectorError,
  openaiCompatibleConnector,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import type { AiRunContext } from '../src/ai/core'
import { type FakeAi, startFakeAi } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// AI resources (M35, docs/architecture.md §2.38): Anthropic through its SDK and an OpenAI-compatible API, against fakes.

let fake: FakeAi
let pool: PoolManager

beforeAll(async () => {
  fake = await startFakeAi()
  pool = new PoolManager()
})
afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
})

const anthropic = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = { apiKey: fake.anthropicKey },
) =>
  resource(
    { baseUrl: fake.anthropicUrl, allowPrivateNetwork: true, ...config },
    secrets,
    JSON.stringify([config, secrets]),
  )
const openai = (
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = { apiKey: fake.openaiKey },
) =>
  resource(
    { baseUrl: fake.openaiUrl, model: 'fake-llm', allowPrivateNetwork: true, ...config },
    secrets,
    JSON.stringify([config, secrets]),
  )

const run = (
  connector: typeof anthropicConnector | typeof openaiCompatibleConnector,
  r: ReturnType<typeof resource>,
  query: Record<string, string>,
  scope: Record<string, unknown> = {},
  ai?: AiRunContext,
) =>
  runQuery(
    pool,
    connector,
    anthropicConnector === connector ? parsed(r, anthropicConnector) : parsed(r, connector),
    query,
    {
      evaluate: scopeEvaluator(scope),
      ...(ai && { ai }),
    },
  )

/** The resource with its settings parsed as the server stores them (defaults filled in). */
function parsed(
  r: ReturnType<typeof resource>,
  connector: typeof anthropicConnector | typeof openaiCompatibleConnector,
) {
  return {
    ...r,
    config: connector.configSchema.parse(r.config),
    secrets: connector.secretsSchema.parse(r.secrets),
  }
}

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('Expected a failure')
}

const lastBody = (api: 'anthropic' | 'openai') =>
  [...fake.requests].reverse().find((r) => r.api === api && r.path.match(/messages|completions/))!.body

describe('Anthropic', () => {
  it('generates text with the default model, caching, the refusal fallback, and says what it cost', async () => {
    const result = await run(
      anthropicConnector,
      anthropic(),
      {
        action: 'generate',
        system: 'Be brief.',
        prompt: 'Hello {{ order.customer }}',
      },
      { order: { customer: 'Ada' } },
    )
    expect(result.data).toBe('You said: Hello Ada')
    const meta = result.metadata as Record<string, any>
    expect(meta).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      stopReason: 'end',
      request: { system: 'Be brief.', prompt: 'Hello Ada' },
    })
    expect(meta.usage.inputTokens).toBeGreaterThan(0)
    expect(meta.costUsd).toBeGreaterThan(0)
    const body = lastBody('anthropic')
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      system: 'Be brief.',
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    })
    expect(body).not.toHaveProperty('temperature')
  })

  it('leaves the fallback out for models without one, or when the resource turns it off', async () => {
    await run(anthropicConnector, anthropic(), {
      action: 'generate',
      prompt: 'hi',
      model: 'claude-haiku-5-5',
    })
    expect(lastBody('anthropic')).not.toHaveProperty('fallbacks')
    await run(anthropicConnector, anthropic({ fallback: false }), { action: 'generate', prompt: 'hi' })
    expect(lastBody('anthropic')).not.toHaveProperty('fallbacks')
  })

  it('extracts JSON through structured output, checks it against the schema', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: { customer: { type: 'string' }, total: { type: 'number' } },
      required: ['customer', 'total'],
      additionalProperties: false,
    })
    const result = await run(anthropicConnector, anthropic(), {
      action: 'extract',
      input: 'Ada ordered 3 lamps',
      schema,
      effort: 'low',
    })
    expect(result.data).toEqual({ customer: 'customer from the text', total: 1 })
    expect(lastBody('anthropic')).toMatchObject({
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON.parse(schema) } },
    })
    // An answer the schema refuses.
    fake.next('anthropic', {
      body: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        content: [{ type: 'text', text: '{"customer": 3}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const bad = await failure(run(anthropicConnector, anthropic(), { action: 'extract', input: 'x', schema }))
    expect(bad.code).toBe('ai_invalid_output')
    expect(bad.message).toContain("doesn't match the schema")
    expect(
      (
        await failure(
          run(anthropicConnector, anthropic(), {
            action: 'extract',
            input: 'x',
            schema: '{"type": "string"}',
          }),
        )
      ).message,
    ).toContain('object')
  })

  it('classifies into one label or several, refusing labels it wasn’t given', async () => {
    const one = await run(anthropicConnector, anthropic(), {
      action: 'classify',
      input: 'Where is my parcel? LABEL=question',
      labels: 'complaint, question, order',
    })
    expect(one.data).toEqual({ label: 'question', reason: 'reason from the text' })
    const several = await run(
      anthropicConnector,
      anthropic(),
      {
        action: 'classify',
        input: 'Broken and late',
        labels: '{{ labels }}',
        multiple: 'true',
      },
      { labels: ['complaint', 'question'] },
    )
    expect(several.data).toEqual({ labels: ['complaint'], reason: 'reason from the text' })
    fake.next('anthropic', {
      body: {
        id: 'msg_y',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        content: [{ type: 'text', text: '{"label":"spam","reason":"r"}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    expect(
      (
        await failure(
          run(anthropicConnector, anthropic(), { action: 'classify', input: 'x', labels: 'a, b' }),
        )
      ).code,
    ).toBe('ai_invalid_output')
    expect(
      (await failure(run(anthropicConnector, anthropic(), { action: 'classify', input: 'x', labels: 'a' })))
        .message,
    ).toContain('at least two')
  })

  it('summarizes the text it’s given, as asked', async () => {
    await run(anthropicConnector, anthropic(), {
      action: 'summarize',
      input: 'A long story',
      length: 'short',
      style: 'bullets',
    })
    const prompt = (lastBody('anthropic').messages as { content: string }[])[0]!.content
    expect(prompt).toContain('in a sentence or two, as bullet points')
    expect(prompt).toContain('<text>\nA long story\n</text>')
  })

  it('reports a refusal with its category, a cut-off answer, and retries a rate limit', async () => {
    const refused = await failure(
      run(anthropicConnector, anthropic(), { action: 'generate', prompt: 'REFUSE_ME' }),
    )
    expect(refused.code).toBe('ai_refused')
    expect(refused.message).toContain('cyber')
    const cut = await failure(
      run(anthropicConnector, anthropic(), {
        action: 'generate',
        prompt: 'a long answer please',
        maxTokens: '2',
      }),
    )
    expect(cut.code).toBe('ai_max_tokens')
    const before = fake.requests.length
    const retried = await run(anthropicConnector, anthropic(), {
      action: 'generate',
      prompt: 'RATE_LIMIT_ONCE now',
    })
    expect(retried.data).toBe('You said: RATE_LIMIT_ONCE now')
    expect(fake.requests.length - before).toBe(2)
  })

  it('stops at the run’s budget, and counts every call against it', async () => {
    let spent = 0
    const budget: AiRunContext = {
      budget: {
        spent: () => spent,
        add: (n) => {
          spent += n
        },
      },
    }
    await run(
      anthropicConnector,
      anthropic({ budgetTokens: 1000 }),
      { action: 'generate', prompt: 'one' },
      {},
      budget,
    )
    expect(spent).toBeGreaterThan(0)
    spent = 1000
    const over = await failure(
      run(
        anthropicConnector,
        anthropic({ budgetTokens: 1000 }),
        { action: 'generate', prompt: 'two' },
        {},
        budget,
      ),
    )
    expect(over.code).toBe('ai_budget')
    expect(over.message).toContain('budget of 1000')
  })

  it('hides prompts when asked, and keeps the agent to workflows', async () => {
    const hidden = await run(anthropicConnector, anthropic({ hidePrompts: true }), {
      action: 'generate',
      prompt: 'secret stuff',
    })
    expect(hidden.metadata).toMatchObject({ promptsHidden: true })
    expect(hidden.metadata).not.toHaveProperty('request')
    const agent = await failure(
      run(anthropicConnector, anthropic(), { action: 'agent', prompt: 'do it', tools: 'a' }),
    )
    expect(agent.message).toContain('workflows only')
  })

  it('uses only the resource’s key and address: never the server’s environment, nor a private network unasked', async () => {
    process.env.ANTHROPIC_API_KEY = fake.anthropicKey
    try {
      const keyless = await failure(
        run(anthropicConnector, anthropic({}, {}), { action: 'generate', prompt: 'x' }),
      )
      expect(keyless.message).toContain('no API key')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
    const wrong = await failure(
      run(anthropicConnector, anthropic({}, { apiKey: 'sk-wrong' }), { action: 'generate', prompt: 'x' }),
    )
    expect(wrong.message).toContain('401')
    expect(wrong.message).toContain('check the API key')
    expect(wrong.message).not.toContain('sk-wrong')
    const blocked = await failure(
      run(anthropicConnector, anthropic({ allowPrivateNetwork: false }), { action: 'generate', prompt: 'x' }),
    )
    expect(blocked.code).toBe('blocked')
  })

  it('tests a resource by listing its models', async () => {
    const ok = await testResource(anthropicConnector, parsed(anthropic(), anthropicConnector))
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining('claude-sonnet-5-5 among them') })
    const bad = await testResource(
      anthropicConnector,
      parsed(anthropic({}, { apiKey: 'nope' }), anthropicConnector),
    )
    expect(bad.ok).toBe(false)
  })
})

describe('OpenAI-compatible', () => {
  it('generates, extracts through response_format, and prices with the resource’s own prices', async () => {
    const text = await run(openaiCompatibleConnector, openai({ inputPrice: 1, outputPrice: 2 }), {
      action: 'generate',
      system: 'Be brief.',
      prompt: 'Hello',
    })
    expect(text.data).toBe('You said: Hello')
    expect(text.metadata).toMatchObject({
      provider: 'openai_compatible',
      model: 'fake-llm',
      costUsd: expect.any(Number),
    })
    expect(lastBody('openai')).toMatchObject({
      model: 'fake-llm',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    const extracted = await run(openaiCompatibleConnector, openai(), {
      action: 'extract',
      input: 'Ada',
      schema:
        '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}',
    })
    expect(extracted.data).toEqual({ name: 'name from the text' })
    expect(lastBody('openai')).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    })
    // No prices: no cost.
    expect(
      (await run(openaiCompatibleConnector, openai(), { action: 'generate', prompt: 'x' })).metadata,
    ).toMatchObject({ costUsd: null })
  })

  it('classifies, reports refusals and auth errors, retries a rate limit, tests the models', async () => {
    const one = await run(openaiCompatibleConnector, openai(), {
      action: 'classify',
      input: 'LABEL=b',
      labels: 'a, b',
    })
    expect(one.data).toEqual({ label: 'b', reason: 'reason from the text' })
    expect(
      (await failure(run(openaiCompatibleConnector, openai(), { action: 'generate', prompt: 'REFUSE_ME' })))
        .code,
    ).toBe('ai_refused')
    const wrong = await failure(
      run(openaiCompatibleConnector, openai({}, { apiKey: 'bad' }), { action: 'generate', prompt: 'x' }),
    )
    expect(wrong.message).toContain('401')
    const retried = await run(openaiCompatibleConnector, openai(), {
      action: 'generate',
      prompt: 'RATE_LIMIT_ONCE again',
    })
    expect(retried.data).toBe('You said: RATE_LIMIT_ONCE again')
    expect(
      await testResource(openaiCompatibleConnector, parsed(openai(), openaiCompatibleConnector)),
    ).toMatchObject({
      ok: true,
      message: expect.stringContaining('fake-llm among them'),
    })
  })
})

describe('the agent', () => {
  /** A tool host with `lookup-customer` (an object schema) and `broken` (fails), recording the calls. */
  function host(opts: { fail?: boolean } = {}) {
    const calls: { slug: string; input: unknown; callId: string }[] = []
    let budget = 0
    const ai: AiRunContext = {
      budget: {
        spent: () => budget,
        add: (n) => {
          budget += n
        },
      },
      tools: {
        describe: async (slugs) =>
          slugs.map((name) => ({
            name,
            description: `The ${name} workflow`,
            inputSchema: {
              type: 'object',
              properties: { email: { type: 'string' } },
              required: ['email'],
            },
          })),
        run: async (slug, input, _signal, callId) => {
          calls.push({ slug, input, callId })
          return opts.fail
            ? { ok: false, data: { error: 'no such customer' }, runId: `run-${calls.length}` }
            : { ok: true, data: { name: 'Ada', tier: 'gold' }, runId: `run-${calls.length}` }
        },
      },
    }
    return { ai, calls, spent: () => budget }
  }

  it('calls a workflow as a tool and answers with what it returned (Anthropic)', async () => {
    const h = host()
    const before = fake.requests.length
    const result = await run(
      anthropicConnector,
      anthropic(),
      {
        action: 'agent',
        instructions: 'You help support.',
        prompt: 'Who is ada@example.com?',
        tools: 'lookup-customer',
      },
      {},
      h.ai,
    )
    expect(h.calls).toEqual([
      {
        slug: 'lookup-customer',
        input: { email: 'email from the text' },
        callId: expect.stringMatching(/^toolu_/),
      },
    ])
    expect(result.data).toEqual({
      answer: 'Done: {"name":"Ada","tier":"gold"}',
      steps: [
        { workflow: 'lookup-customer', input: { email: 'email from the text' }, runId: 'run-1', ok: true },
      ],
    })
    expect(result.metadata).toMatchObject({
      provider: 'anthropic',
      steps: 1,
      usage: { inputTokens: expect.any(Number) },
      costUsd: expect.any(Number),
      request: { system: 'You help support.', prompt: 'Who is ada@example.com?' },
    })
    // Two model calls: the second sent the model's tool_use back with the tool's result.
    const sent = fake.requests.slice(before).map((r) => r.body)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.tools).toEqual([
      expect.objectContaining({ name: 'lookup-customer', description: 'The lookup-customer workflow' }),
    ])
    const messages = sent[1]!.messages as { role: string; content: unknown }[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2]!.content).toEqual([
      expect.objectContaining({ type: 'tool_result', content: '{"name":"Ada","tier":"gold"}' }),
    ])
    // Both calls count against the run's budget.
    expect(h.spent()).toBe(
      (result.metadata.usage as { inputTokens: number; outputTokens: number }).inputTokens +
        (result.metadata.usage as { outputTokens: number }).outputTokens,
    )
  })

  it('calls a workflow as a tool through function calling (OpenAI-compatible), a failing tool as an error result', async () => {
    const h = host({ fail: true })
    const before = fake.requests.length
    const result = await run(
      openaiCompatibleConnector,
      openai(),
      { action: 'agent', prompt: 'Who is ada@example.com?', tools: 'lookup-customer' },
      {},
      h.ai,
    )
    expect(result.data).toMatchObject({
      answer: expect.stringContaining('Error: {"error":"no such customer"}'),
      steps: [{ workflow: 'lookup-customer', ok: false, runId: 'run-1' }],
    })
    const second = fake.requests.slice(before)[1]!.body
    expect((second.messages as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(second.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'lookup-customer' }),
      }),
    ])
  })

  it('fails at max steps, and at the budget between steps, with the usage so far', async () => {
    // The model keeps calling tools: with one step allowed, the second turn's call fails the agent.
    fake.next('anthropic', {
      body: {
        id: 'msg_loop',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'lookup-customer', input: { email: 'a' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    fake.next('anthropic', {
      body: {
        id: 'msg_loop2',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'toolu_b', name: 'lookup-customer', input: { email: 'b' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    const h = host()
    const max = await failure(
      run(
        anthropicConnector,
        anthropic(),
        { action: 'agent', prompt: 'Look up ada', tools: 'lookup-customer', maxSteps: '1' },
        {},
        h.ai,
      ),
    )
    expect(max).toMatchObject({
      code: 'ai_max_steps',
      details: {
        steps: [{ workflow: 'lookup-customer', input: { email: 'a' } }],
        usage: { inputTokens: 20 },
      },
    })
    expect(h.calls).toHaveLength(1)

    // A budget the first turn spends: the second call is refused, carrying the first's usage.
    const tight = host()
    const spent = await failure(
      run(
        anthropicConnector,
        anthropic({ budgetTokens: 1 }),
        { action: 'agent', prompt: 'Look up ada', tools: 'lookup-customer' },
        {},
        tight.ai,
      ),
    )
    expect(spent).toMatchObject({
      code: 'ai_budget',
      details: { provider: 'anthropic', usage: { inputTokens: expect.any(Number) }, steps: [{ ok: true }] },
    })
  })

  it('refuses tools written as expressions, an unknown tool name as an error result', async () => {
    const expr = await failure(
      run(
        anthropicConnector,
        anthropic(),
        { action: 'agent', prompt: 'x', tools: '{{ tools }}' },
        {},
        host().ai,
      ),
    )
    expect(expr.message).toContain('not {{ }} expressions')
    fake.next('anthropic', {
      body: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'delete-everything', input: {} }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    const h = host()
    const result = await run(
      anthropicConnector,
      anthropic(),
      { action: 'agent', prompt: 'x', tools: 'lookup-customer' },
      {},
      h.ai,
    )
    expect(h.calls).toHaveLength(0)
    expect(result.data).toMatchObject({
      answer: 'Done: There\'s no tool named "delete-everything"',
      steps: [],
    })
  })
})
