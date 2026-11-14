import { Agent } from 'undici'
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
import { aiRequest } from './http'
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
    // OpenAI's own API (and Azure's) takes max_completion_tokens (its reasoning models refuse max_tokens); other
    // OpenAI-compatible servers still know max_tokens only.
    ...(usesCompletionTokens(client.config.baseUrl)
      ? { max_completion_tokens: request.maxTokens }
      : { max_tokens: request.maxTokens }),
    ...(request.tools?.length && {
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }),
    ...(request.schema && {
      response_format: {
        type: 'json_schema',
        // Strict mode refuses schemas with optional properties or open objects: those are sent non-strict (the
        // answer is checked against the schema here either way).
        json_schema: { name: 'answer', schema: request.schema, strict: strictCompatible(request.schema) },
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
  // A server that leaves ids out (or repeats them) gets ids of our own, so each result goes back to its call.
  const seen = new Set<string>()
  const toolCalls = (choice?.message?.tool_calls ?? []).flatMap((call, i) => {
    if (!call.function?.name) return []
    if (!call.id || seen.has(call.id)) call.id = `call_${i}_${seen.size}`
    seen.add(call.id)
    return [{ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }]
  })
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

/** OpenAI's API and Azure OpenAI's take `max_completion_tokens`. */
function usesCompletionTokens(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com')
}

/**
 * Whether OpenAI's strict structured outputs take the schema: every object lists all its properties as required and
 * has `additionalProperties: false`, all the way down.
 */
export function strictCompatible(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true
  if (Array.isArray(schema)) return schema.every(strictCompatible)
  const s = schema as Record<string, unknown>
  if (s.type === 'object' || s.properties) {
    const keys = Object.keys((s.properties as Record<string, unknown> | undefined) ?? {})
    const required = new Set(Array.isArray(s.required) ? s.required : [])
    if (s.additionalProperties !== false || !keys.every((k) => required.has(k))) return false
  }
  return Object.entries(s).every(([key, value]) =>
    key === 'enum' || key === 'const' || key === 'required' ? true : strictCompatible(value),
  )
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

/** One API call (`aiRequest`: retried, redirects refused, the API's message kept). */
function call(
  client: Client,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ChatResponse & { data?: { id?: string }[] }> {
  checkBaseUrl(client.config.baseUrl, client.config.allowPrivateNetwork)
  return aiRequest({
    method,
    url: `${client.config.baseUrl.replace(/\/+$/, '')}${path}`,
    headers: client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {},
    body,
    agent: client.agent,
    signal,
    timeoutMs,
    hints: { 401: ' (check the API key)', 404: ' (check the base URL and model)' },
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
