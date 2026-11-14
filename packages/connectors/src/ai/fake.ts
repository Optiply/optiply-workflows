import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// Fakes of the AI APIs M35 and M37 call, on one HTTP server for tests: Anthropic's Messages API under `/anthropic/v1`,
// an OpenAI-compatible API under `/openai/v1`, the Gemini API under `/gemini/v1beta` and Vertex AI under `/vertex/v1`
// (any `ya29.` bearer token: the Google token fakes issue those). Deterministic, scriptable by markers in the prompt:
//   REFUSE_ME          the model declines (Anthropic: stop_reason refusal, category `cyber`; OpenAI: a refusal)
//   RATE_LIMIT_ONCE    the first such request answers 429 (retry-after 0), the next succeeds
//   LABEL=<label>      a classification picks that label (else the first)
// A structured output is a sample of the schema (strings say which property they are); with tools, the first tool is
// called once (its input sampled from its schema), then the answer is "Done: <the tool's result>". Anything else is
// echoed: "You said: <prompt>". Tests can queue their own replies (`next`).

export interface FakeAi {
  url: string
  /** Base URLs for resources: Anthropic's (`…/anthropic`) and the OpenAI-compatible one (`…/openai/v1`). */
  anthropicUrl: string
  openaiUrl: string
  /** Gemini API (`…/gemini/v1beta`) and Vertex AI (`…/vertex/v1`) base URLs. */
  geminiUrl: string
  vertexUrl: string
  anthropicKey: string
  openaiKey: string
  geminiKey: string
  /** Every request, in order: which API, its path and body. */
  requests: { api: FakeAiApi; path: string; body: Record<string, unknown>; authorization?: string }[]
  /** Queues a reply for the next request to that API (a status and body; checked before the defaults). */
  next(api: FakeAiApi, reply: { status?: number; body: unknown; headers?: Record<string, string> }): void
  stop(): Promise<void>
}

type Json = Record<string, unknown>
export type FakeAiApi = 'anthropic' | 'openai' | 'gemini' | 'vertex'

export async function startFakeAi(): Promise<FakeAi> {
  const requests: FakeAi['requests'] = []
  const queued: Record<FakeAiApi, { status?: number; body: unknown; headers?: Record<string, string> }[]> = {
    anthropic: [],
    openai: [],
    gemini: [],
    vertex: [],
  }
  const limited = new Set<string>()
  const anthropicKey = 'sk-ant-fake-key'
  const openaiKey = 'sk-openai-fake-key'
  const geminiKey = 'AIza-fake-gemini-key'
  let ids = 0

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    const body = req.method === 'POST' ? await readJson(req) : {}
    const api: FakeAiApi | null = path.startsWith('/anthropic/')
      ? 'anthropic'
      : path.startsWith('/openai/')
        ? 'openai'
        : path.startsWith('/gemini/')
          ? 'gemini'
          : path.startsWith('/vertex/')
            ? 'vertex'
            : null
    if (!api) return send(res, 404, { error: 'Not found' })
    requests.push({
      api,
      path,
      body,
      ...(req.headers.authorization && { authorization: req.headers.authorization }),
    })
    if (api === 'gemini' || api === 'vertex') {
      const ok =
        api === 'gemini'
          ? req.headers['x-goog-api-key'] === geminiKey
          : /^Bearer (ya29\.|sa-|md-)/.test(req.headers.authorization ?? '')
      if (!ok) {
        return send(res, api === 'gemini' ? 400 : 401, {
          error: {
            code: api === 'gemini' ? 400 : 401,
            message:
              api === 'gemini' ? 'API key not valid. Please pass a valid API key.' : 'Invalid credentials',
            status: api === 'gemini' ? 'INVALID_ARGUMENT' : 'UNAUTHENTICATED',
          },
        })
      }
      const reply = queued[api].shift()
      if (reply) return send(res, reply.status ?? 200, reply.body, reply.headers)
      return googleAnswer(res, path, body, limited, ++ids)
    }
    // The SDK (1.x) sends the key as a bearer token; older clients as x-api-key.
    const anthropicAuth = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '')
    if (api === 'anthropic' && anthropicAuth !== anthropicKey) {
      return send(res, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      })
    }
    if (api === 'openai' && req.headers.authorization !== `Bearer ${openaiKey}`) {
      return send(res, 401, { error: { message: 'Incorrect API key provided' } })
    }
    const reply = queued[api].shift()
    if (reply) return send(res, reply.status ?? 200, reply.body, reply.headers)

    if (path.endsWith('/models')) {
      return send(
        res,
        200,
        api === 'anthropic'
          ? {
              data: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].map((id) => ({
                id,
                type: 'model',
                display_name: id,
                created_at: '2026-10-01T00:00:00Z',
              })),
              has_more: false,
              first_id: 'claude-sonnet-5-5',
              last_id: 'claude-haiku-5-5',
            }
          : { object: 'list', data: [{ id: 'fake-llm', object: 'model' }] },
      )
    }

    const prompt = api === 'anthropic' ? lastUserText(body.messages) : lastUserTextOpenAi(body.messages)
    if (prompt.includes('RATE_LIMIT_ONCE') && !limited.has(prompt)) {
      limited.add(prompt)
      return send(
        res,
        429,
        api === 'anthropic'
          ? { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }
          : { error: { message: 'Rate limited' } },
        { 'retry-after': '0' },
      )
    }

    if (api === 'anthropic' && path.endsWith('/v1/messages'))
      return send(res, 200, anthropicAnswer(body, prompt, ++ids))
    if (api === 'openai' && path.endsWith('/chat/completions'))
      return send(res, 200, openaiAnswer(body, prompt, ++ids))
    send(res, 404, { error: 'Not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    anthropicUrl: `${url}/anthropic`,
    openaiUrl: `${url}/openai/v1`,
    geminiUrl: `${url}/gemini/v1beta`,
    vertexUrl: `${url}/vertex/v1`,
    anthropicKey,
    openaiKey,
    geminiKey,
    requests,
    next: (api, reply) => queued[api].push(reply),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function anthropicAnswer(body: Json, prompt: string, id: number): Json {
  const model = String(body.model)
  const usage = (out: string) => ({
    input_tokens:
      Math.ceil(JSON.stringify(body.messages ?? '').length / 4) +
      Math.ceil(String(body.system ?? '').length / 4),
    output_tokens: Math.ceil(out.length / 4),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  const message = (content: Json[], stop: string, out: string, extra: Json = {}) => ({
    id: `msg_fake_${id}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: usage(out),
    ...extra,
  })
  if (prompt.includes('REFUSE_ME')) {
    return message([], 'refusal', '', {
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined by the fake' },
    })
  }
  const tools = body.tools as { name: string; input_schema: Json }[] | undefined
  if (tools?.length) {
    const results = toolResults(body.messages)
    if (!results.length) {
      const tool = tools[0]!
      const input = sample(tool.input_schema, prompt)
      return message(
        [{ type: 'tool_use', id: `toolu_fake_${id}`, name: tool.name, input }],
        'tool_use',
        JSON.stringify(input),
      )
    }
    const text = `Done: ${results.at(-1)}`
    return message([{ type: 'text', text }], 'end_turn', text)
  }
  const format = (body.output_config as { format?: { schema?: Json } } | undefined)?.format
  const text = format?.schema
    ? JSON.stringify(sample(format.schema, prompt))
    : `You said: ${prompt.slice(0, 200)}`
  if (Number(body.max_tokens) < Math.ceil(text.length / 4)) {
    return message([{ type: 'text', text: text.slice(0, Number(body.max_tokens) * 4) }], 'max_tokens', text)
  }
  return message([{ type: 'text', text }], 'end_turn', text)
}

function openaiAnswer(body: Json, prompt: string, id: number): Json {
  const choice = (message: Json, finish: string) => ({
    id: `chatcmpl-fake-${id}`,
    object: 'chat.completion',
    model: String(body.model),
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: {
      prompt_tokens: Math.ceil(JSON.stringify(body.messages ?? '').length / 4),
      completion_tokens: Math.ceil(JSON.stringify(message).length / 4),
      total_tokens: 0,
    },
  })
  if (prompt.includes('REFUSE_ME'))
    return choice({ content: null, refusal: 'I can’t help with that' }, 'stop')
  const tools = body.tools as { function: { name: string; parameters: Json } }[] | undefined
  if (tools?.length) {
    const messages = (body.messages ?? []) as { role: string; content?: string }[]
    const results = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    if (!results.length) {
      const tool = tools[0]!.function
      return choice(
        {
          content: null,
          tool_calls: [
            {
              id: `call_fake_${id}`,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(sample(tool.parameters, prompt)) },
            },
          ],
        },
        'tool_calls',
      )
    }
    return choice({ content: `Done: ${results.at(-1)}` }, 'stop')
  }
  const format = body.response_format as { json_schema?: { schema?: Json } } | undefined
  const content = format?.json_schema?.schema
    ? JSON.stringify(sample(format.json_schema.schema, prompt))
    : `You said: ${prompt.slice(0, 200)}`
  return choice({ content }, 'stop')
}

/** Gemini's `generateContent` and `countTokens`, and the Gemini API's model list (Vertex has none per project). */
function googleAnswer(res: ServerResponse, path: string, body: Json, limited: Set<string>, id: number) {
  if (path.endsWith('/models')) {
    return send(res, 200, {
      models: ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite'].map((m) => ({
        name: `models/${m}`,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      })),
    })
  }
  const model = /models\/([^/:]+):/.exec(path)?.[1] ?? 'unknown'
  if (path.endsWith(':countTokens')) return send(res, 200, { totalTokens: 1 })
  if (!path.endsWith(':generateContent'))
    return send(res, 404, { error: { code: 404, message: 'Not found' } })
  if (model === 'missing-model') {
    return send(res, 404, {
      error: { code: 404, message: `models/${model} is not found`, status: 'NOT_FOUND' },
    })
  }
  const contents = (body.contents ?? []) as { role: string; parts: Json[] }[]
  const prompt = String(contents[0]?.parts?.[0]?.text ?? '')
  if (prompt.includes('RATE_LIMIT_ONCE') && !limited.has(prompt)) {
    limited.add(prompt)
    return send(
      res,
      429,
      { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } },
      { 'retry-after': '0' },
    )
  }
  const promptTokens = Math.ceil(JSON.stringify(body.contents ?? '').length / 4)
  const answer = (parts: Json[], finishReason: string, extra: Json = {}) => ({
    candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: Math.ceil(JSON.stringify(parts).length / 4),
      thoughtsTokenCount: 7,
      cachedContentTokenCount: prompt.includes('CACHED') ? 4 : 0,
      totalTokenCount: 0,
    },
    modelVersion: model,
    responseId: `fake-${id}`,
    ...extra,
  })
  if (prompt.includes('BLOCK_PROMPT')) {
    return send(res, 200, {
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
      usageMetadata: { promptTokenCount: promptTokens },
      modelVersion: model,
    })
  }
  if (prompt.includes('REFUSE_ME')) return send(res, 200, answer([], 'SAFETY'))
  // A thought first, as Gemini sends one, with its signature (which must come back unchanged).
  const thought = { text: 'Thinking it over', thought: true, thoughtSignature: `sig-${id}` }
  const tools = (
    body.tools as { functionDeclarations?: { name: string; parametersJsonSchema?: Json }[] }[]
  )?.[0]?.functionDeclarations
  if (tools?.length) {
    const results = contents.flatMap((c) =>
      c.role === 'user'
        ? c.parts.flatMap((p) => {
            const r = p.functionResponse as { response?: Json } | undefined
            const value = r?.response?.result ?? r?.response?.error ?? r?.response
            return r ? [typeof value === 'string' ? value : JSON.stringify(value)] : []
          })
        : [],
    )
    if (!results.length) {
      const tool = tools[0]!
      return send(
        res,
        200,
        answer(
          [thought, { functionCall: { name: tool.name, args: sample(tool.parametersJsonSchema, prompt) } }],
          'STOP',
        ),
      )
    }
    // The model's earlier turn must have come back with its thought signature.
    const echoed = contents.some((c) => c.role === 'model' && c.parts.some((p) => p.thoughtSignature))
    return send(
      res,
      200,
      answer([{ text: `Done: ${results.at(-1)}${echoed ? '' : ' (signature lost)'}` }], 'STOP'),
    )
  }
  const config = (body.generationConfig ?? {}) as { responseJsonSchema?: Json; maxOutputTokens?: number }
  const text = config.responseJsonSchema
    ? JSON.stringify(sample(config.responseJsonSchema, prompt))
    : `You said: ${prompt.slice(0, 200)}`
  if (Number(config.maxOutputTokens) < Math.ceil(text.length / 4)) {
    return send(
      res,
      200,
      answer([thought, { text: text.slice(0, Number(config.maxOutputTokens) * 4) }], 'MAX_TOKENS'),
    )
  }
  return send(res, 200, answer([thought, { text }], 'STOP'))
}

/** A value valid against a (simple) JSON Schema: enums pick `LABEL=` or the first, strings name their property. */
export function sample(schema: unknown, prompt: string, name = 'value'): unknown {
  const s = (schema ?? {}) as Json
  if (Array.isArray(s.enum)) {
    const wanted = /LABEL=([^\s,]+)/.exec(prompt)?.[1]
    return wanted && s.enum.includes(wanted) ? wanted : s.enum[0]
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  switch (type) {
    case 'object': {
      const properties = (s.properties ?? {}) as Json
      return Object.fromEntries(
        Object.entries(properties).map(([key, sub]) => [key, sample(sub, prompt, key)]),
      )
    }
    case 'array':
      return [sample(s.items, prompt, name)]
    case 'integer':
    case 'number':
      return 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return `${name} from the text`
  }
}

function lastUserText(messages: unknown): string {
  const list = (messages ?? []) as { role: string; content: unknown }[]
  const user = [...list].reverse().find((m) => m.role === 'user')
  if (!user) return ''
  if (typeof user.content === 'string') return user.content
  return (user.content as { type: string; text?: string }[])
    .flatMap((b) => (b.type === 'text' && b.text ? [b.text] : []))
    .join('\n')
}

function lastUserTextOpenAi(messages: unknown): string {
  const list = (messages ?? []) as { role: string; content: unknown }[]
  const user = [...list].reverse().find((m) => m.role === 'user')
  return typeof user?.content === 'string' ? user.content : ''
}

/** The tool results sent back so far (Anthropic's `tool_result` blocks), as text. */
function toolResults(messages: unknown): string[] {
  const list = (messages ?? []) as { role: string; content: unknown }[]
  return list.flatMap((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? (m.content as { type: string; content?: unknown }[]).flatMap((b) =>
          b.type === 'tool_result'
            ? [typeof b.content === 'string' ? b.content : JSON.stringify(b.content)]
            : [],
        )
      : [],
  )
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
