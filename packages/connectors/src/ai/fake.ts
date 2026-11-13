import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// Fakes of the AI APIs M35 calls, on one HTTP server for tests: Anthropic's Messages API under `/anthropic/v1` and an
// OpenAI-compatible API under `/openai/v1`. Deterministic, scriptable by markers in the prompt:
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
  anthropicKey: string
  openaiKey: string
  /** Every request, in order: which API, its path and body. */
  requests: { api: 'anthropic' | 'openai'; path: string; body: Record<string, unknown> }[]
  /** Queues a reply for the next request to that API (a status and body; checked before the defaults). */
  next(
    api: 'anthropic' | 'openai',
    reply: { status?: number; body: unknown; headers?: Record<string, string> },
  ): void
  stop(): Promise<void>
}

type Json = Record<string, unknown>

export async function startFakeAi(): Promise<FakeAi> {
  const requests: FakeAi['requests'] = []
  const queued: Record<
    'anthropic' | 'openai',
    { status?: number; body: unknown; headers?: Record<string, string> }[]
  > = { anthropic: [], openai: [] }
  const limited = new Set<string>()
  const anthropicKey = 'sk-ant-fake-key'
  const openaiKey = 'sk-openai-fake-key'
  let ids = 0

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    const body = req.method === 'POST' ? await readJson(req) : {}
    const api = path.startsWith('/anthropic/') ? 'anthropic' : path.startsWith('/openai/') ? 'openai' : null
    if (!api) return send(res, 404, { error: 'Not found' })
    requests.push({ api, path, body })
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
    anthropicKey,
    openaiKey,
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
