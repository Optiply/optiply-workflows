import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { guardedLookup } from '../net-guard'
import { actionQuerySchema, validateActionQuery } from '../services/common'
import { type Connector, ConnectorError, type QueryContext } from '../types'
import {
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  checkBaseUrl,
  executeAiQuery,
} from './core'
import { costOf } from './prices'

// OpenAI-compatible providers (M35, docs/architecture.md §2.38): OpenAI, Azure OpenAI's v1 API, Mistral, Ollama, vLLM,
// LiteLLM… through `POST <base>/chat/completions`. No SDK: the request is small, and many servers speak only this.

const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const configSchema = z.object({
  /** The API's base, up to `/v1` (`https://api.openai.com/v1`, `http://ollama:11434/v1`). */
  baseUrl: z.string().trim().url().max(2048),
  model: z.string().trim().min(1).max(200),
  budgetTokens: z.number().int().positive().max(1_000_000_000).optional(),
  hidePrompts: z.boolean().default(false),
  /** US dollars per million tokens, for the cost; none: unknown. */
  inputPrice: optionalText(z.number().min(0).max(10_000)),
  outputPrice: optionalText(z.number().min(0).max(10_000)),
  /** A model served inside the network (Ollama, vLLM). */
  allowPrivateNetwork: z.boolean().default(false),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({ apiKey: z.string().optional() })
type Secrets = z.output<typeof secretsSchema>

interface Client {
  config: Config
  apiKey: string | undefined
  agent: Agent
}

const querySchema = actionQuerySchema('openai_compatible')
const RETRIES = 2

interface ChatResponse {
  model?: string
  choices?: {
    message?: {
      content?: string | null
      refusal?: string | null
      tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function provider(client: Client): AiProvider {
  return {
    name: 'openai_compatible',
    defaultModel: client.config.model,
    complete: (request) => complete(client, request),
  }
}

async function complete(client: Client, request: AiCompletionRequest): Promise<AiCompletion> {
  const body = {
    model: request.model,
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      { role: 'user', content: request.prompt },
      // The agent's turns: the model's message as it sent it, then a `tool` message per result.
      ...(request.turns ?? []).flatMap((turn) =>
        turn.kind === 'assistant'
          ? [turn.raw]
          : turn.results.map((r) => ({
              role: 'tool',
              tool_call_id: r.id,
              content: r.isError ? `Error: ${r.content}` : r.content,
            })),
      ),
    ],
    max_tokens: request.maxTokens,
    ...(request.tools?.length && {
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }),
    ...(request.schema && {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: request.schema, strict: true },
      },
    }),
  }
  const res = await call(client, 'POST', '/chat/completions', body, request.signal, request.timeoutMs)
  const choice = res.choices?.[0]
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const usage = {
    inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
    outputTokens: res.usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
  const finish = choice?.finish_reason ?? 'stop'
  const refused = !!choice?.message?.refusal || finish === 'content_filter'
  const price =
    client.config.inputPrice !== undefined && client.config.outputPrice !== undefined
      ? {
          input: client.config.inputPrice,
          output: client.config.outputPrice,
          cacheRead: client.config.inputPrice,
        }
      : undefined
  const toolCalls = (choice?.message?.tool_calls ?? []).flatMap((call) =>
    call.function?.name
      ? [{ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }]
      : [],
  )
  return {
    text: choice?.message?.content ?? '',
    ...(toolCalls.length && {
      toolCalls,
      raw: {
        role: 'assistant',
        content: choice?.message?.content ?? null,
        tool_calls: choice?.message?.tool_calls,
      },
    }),
    model: res.model ?? request.model,
    usage,
    stopReason: refused
      ? 'refusal'
      : finish === 'length'
        ? 'max_tokens'
        : finish === 'tool_calls'
          ? 'tool_use'
          : finish === 'stop'
            ? 'end'
            : finish,
    refusalCategory: refused ? (choice?.message?.refusal ?? 'content_filter') : null,
    costUsd: costOf(usage, price),
  }
}

/** A tool call's arguments: JSON text, kept as text when it isn't JSON (the workflow sees what the model wrote). */
function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** One API call, retried twice on 408/409/429/5xx and connection failures (the `retry-after` header honoured). */
async function call(
  client: Client,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ChatResponse & { data?: { id?: string }[] }> {
  checkBaseUrl(client.config.baseUrl, client.config.allowPrivateNetwork)
  const url = `${client.config.baseUrl.replace(/\/+$/, '')}${path}`
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    let res: Awaited<ReturnType<typeof undiciFetch>>
    try {
      res = await undiciFetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(client.apiKey && { authorization: `Bearer ${client.apiKey}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        dispatcher: client.agent,
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      })
    } catch (err) {
      if (signal.aborted) throw new ConnectorError('aborted', 'The request was cancelled')
      if (Date.now() >= deadline) throw new ConnectorError('timeout', 'The API didn’t answer in time')
      const cause = (err as { cause?: unknown }).cause
      if (cause instanceof Error && /private address|blocked/i.test(cause.message)) {
        throw new ConnectorError(
          'blocked',
          'The API is on a private network: allow private networks in the resource to reach it',
        )
      }
      if (attempt < RETRIES) {
        await wait(500 * 2 ** attempt, signal)
        continue
      }
      throw new ConnectorError(
        'connection',
        `Couldn't reach ${url}: ${(cause as Error)?.message ?? (err as Error).message}`,
      )
    }
    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new ConnectorError('http', `${url} answered ${res.status} with something that isn't JSON`)
      }
    }
    if ([408, 409, 429].includes(res.status) || res.status >= 500) {
      if (attempt < RETRIES) {
        const after = Number(res.headers.get('retry-after'))
        await wait(
          Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt,
          signal,
        )
        continue
      }
    }
    let message = text.slice(0, 500)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string }
      message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? message)
    } catch {}
    const hint =
      res.status === 401
        ? ' (check the API key)'
        : res.status === 404
          ? ' (check the base URL and model)'
          : ''
    throw new ConnectorError('http', `The API answered ${res.status}: ${message}${hint}`, {
      status: res.status,
    })
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ConnectorError('aborted', 'The request was cancelled'))
      },
      { once: true },
    )
  })
}

export const openaiCompatibleConnector: Connector<Config, Secrets, typeof querySchema._output, Client> = {
  type: 'openai_compatible',
  label: 'OpenAI-compatible',
  configSchema,
  secretsSchema,
  querySchema,
  createClient(resource) {
    const agent = new Agent({
      connections: 16,
      connect: resource.config.allowPrivateNetwork ? {} : { lookup: guardedLookup },
    })
    return { config: resource.config, apiKey: resource.secrets.apiKey || undefined, agent }
  },
  async destroyClient(client) {
    await client.agent.close()
  },
  async testConnection(client, ctx) {
    const res = await call(client, 'GET', '/models', undefined, ctx.signal, ctx.timeoutMs)
    const ids = (res.data ?? []).map((m) => m.id).filter(Boolean)
    return {
      message: ids.length
        ? `Answered: ${ids.length} models${ids.includes(client.config.model) ? `, ${client.config.model} among them` : ''}`
        : 'Answered',
    }
  },
  validateQuery: validateActionQuery,
  execute(client, query, ctx: QueryContext) {
    return executeAiQuery(provider(client), client.config, query, ctx)
  },
}

export { provider as openaiCompatibleProvider }
