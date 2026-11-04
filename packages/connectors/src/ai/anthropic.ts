import Anthropic from '@anthropic-ai/sdk'
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
import { ANTHROPIC_PRICES, costOf, DEFAULT_ANTHROPIC_MODEL, FALLBACK_MODELS } from './prices'

// Anthropic (M35, docs/architecture.md §2.38): Claude through the official SDK, its requests on an undici agent that
// keeps private addresses out of reach (unless the resource allows them), the API key only from the resource: never
// the server's own environment (the SDK would read ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL otherwise).

const ANTHROPIC_API = 'https://api.anthropic.com'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** An empty text field is no value. */
const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const configSchema = z.object({
  model: z.string().trim().min(1).max(200).default(DEFAULT_ANTHROPIC_MODEL),
  /** A proxy, or the tests' fake; empty for Anthropic's API. */
  baseUrl: optionalText(z.string().trim().url().max(2048)),
  budgetTokens: z.number().int().positive().max(1_000_000_000).optional(),
  hidePrompts: z.boolean().default(false),
  /** Anthropic's server-side refusal fallback (`fallbacks: "default"`), on models that take it. */
  fallback: z.boolean().default(true),
  /** Lets the base URL be on a private network (a proxy inside it). */
  allowPrivateNetwork: z.boolean().default(false),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({ apiKey: z.string().optional() })
type Secrets = z.output<typeof secretsSchema>

interface Client {
  config: Config
  sdk: Anthropic
  agent: Agent
  hasKey: boolean
}

const querySchema = actionQuerySchema('anthropic')

function provider(client: Client): AiProvider {
  return {
    name: 'anthropic',
    defaultModel: client.config.model,
    complete: (request) => complete(client, request),
  }
}

async function complete(client: Client, request: AiCompletionRequest): Promise<AiCompletion> {
  requireKey(client)
  const fallback = client.config.fallback && FALLBACK_MODELS.has(request.model)
  const outputConfig = {
    ...(request.effort && { effort: request.effort }),
    ...(request.schema && { format: { type: 'json_schema' as const, schema: request.schema } }),
  }
  let message: Anthropic.Beta.BetaMessage
  try {
    message = await client.sdk.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.system && { system: request.system }),
        messages: [{ role: 'user', content: request.prompt }, ...turnsOf(request)],
        ...(request.tools?.length && {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
          })),
        }),
        ...(Object.keys(outputConfig).length && { output_config: outputConfig }),
        // Automatic prompt caching: repeated system prompts and inputs cost a tenth.
        cache_control: { type: 'ephemeral' },
        ...(fallback && { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
      },
      { signal: request.signal, timeout: request.timeoutMs },
    )
  } catch (err) {
    throw anthropicError(err, request.signal)
  }
  return completionOf(message)
}

/** The agent's turns after the prompt: the model's own content sent back as it was, the tools' results as a user turn. */
function turnsOf(request: AiCompletionRequest): Anthropic.Beta.BetaMessageParam[] {
  return (request.turns ?? []).map((turn) =>
    turn.kind === 'assistant'
      ? { role: 'assistant', content: turn.raw as Anthropic.Beta.BetaContentBlockParam[] }
      : {
          role: 'user',
          content: turn.results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError && { is_error: true }),
          })),
        },
  )
}

/** The answer's text (thinking left out), the tools it calls, usage and cost. */
export function completionOf(message: Anthropic.Beta.BetaMessage): AiCompletion {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  }
  const stop = message.stop_reason
  const toolCalls = message.content.flatMap((block) =>
    block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
  )
  return {
    text,
    ...(toolCalls.length && { toolCalls, raw: message.content }),
    model: message.model,
    usage,
    stopReason: stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : (stop ?? 'end'),
    refusalCategory: stop === 'refusal' ? (message.stop_details?.category ?? null) : null,
    costUsd: costOf(usage, ANTHROPIC_PRICES[message.model]),
  }
}

/** The SDK's failures as the platform's: the API's own message, the status; aborts and timeouts as such. */
export function anthropicError(err: unknown, signal: AbortSignal): ConnectorError {
  if (err instanceof ConnectorError) return err
  if (signal.aborted) return new ConnectorError('aborted', 'The request was cancelled')
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ConnectorError('timeout', 'Anthropic’s API didn’t answer in time')
  }
  if (err instanceof Anthropic.APIUserAbortError)
    return new ConnectorError('aborted', 'The request was cancelled')
  if (err instanceof Anthropic.APIConnectionError) {
    const cause = (err as { cause?: unknown }).cause
    const blocked = cause instanceof Error && /private address|blocked/i.test(cause.message)
    return new ConnectorError(
      blocked ? 'blocked' : 'connection',
      blocked
        ? `The API's address is on a private network: allow private networks in the resource to reach it`
        : `Couldn't reach Anthropic’s API: ${err.message}`,
    )
  }
  if (err instanceof Anthropic.APIError) {
    const hint =
      err.status === 401
        ? ' (check the API key)'
        : err.status === 429
          ? ' (rate limited, after retries)'
          : err.status === 529
            ? ' (overloaded)'
            : ''
    return new ConnectorError('http', `Anthropic’s API answered ${err.status}: ${err.message}${hint}`, {
      status: err.status,
    })
  }
  return new ConnectorError('connection', `Anthropic’s API failed: ${(err as Error)?.message ?? String(err)}`)
}

function requireKey(client: Client) {
  if (!client.hasKey) throw new ConnectorError('invalid_config', 'The resource has no API key')
  checkBaseUrl(client.config.baseUrl ?? ANTHROPIC_API, client.config.allowPrivateNetwork)
}

export const anthropicConnector: Connector<Config, Secrets, typeof querySchema._output, Client> = {
  type: 'anthropic',
  label: 'Anthropic',
  configSchema,
  secretsSchema,
  querySchema,
  createClient(resource) {
    const agent = new Agent({
      connections: 16,
      connect: resource.config.allowPrivateNetwork ? {} : { lookup: guardedLookup },
    })
    const sdk = new Anthropic({
      // Everything explicit: nothing from the server's environment.
      apiKey: resource.secrets.apiKey || 'missing',
      authToken: null,
      baseURL: resource.config.baseUrl ?? ANTHROPIC_API,
      maxRetries: 2,
      // The SDK's own headers are Node's Headers, which the undici package's fetch doesn't take: plain ones instead.
      fetch: ((url: string, init: RequestInit) =>
        undiciFetch(url, {
          ...init,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          dispatcher: agent,
          // Never followed (the SDK then reports the 3xx): a redirect could lead past the private-network guard.
          redirect: 'manual',
        } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch,
    })
    return { config: resource.config, sdk, agent, hasKey: !!resource.secrets.apiKey }
  },
  async destroyClient(client) {
    await client.agent.close()
  },
  async testConnection(client, ctx) {
    requireKey(client)
    try {
      const page = await client.sdk.models.list(
        { limit: 100 },
        { signal: ctx.signal, timeout: ctx.timeoutMs },
      )
      const ids = page.data.map((m) => m.id)
      const known = ids.includes(client.config.model)
      return {
        message: known
          ? `Signed in: ${ids.length} models, ${client.config.model} among them`
          : `Signed in: ${ids.length} models (the default ${client.config.model} isn't listed)`,
      }
    } catch (err) {
      throw anthropicError(err, ctx.signal)
    }
  },
  validateQuery: validateActionQuery,
  execute(client, query, ctx: QueryContext) {
    return executeAiQuery(provider(client), client.config, query, ctx)
  },
}

export { provider as anthropicProvider }
