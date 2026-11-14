import { Agent } from 'undici'
import { z } from 'zod'
import {
  GOOGLE_TOKEN_URL,
  type GoogleTokens,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServerIdentity,
  serviceAccountTokens,
} from '../google-auth'
import { guardedLookup } from '../net-guard'
import { actionQuerySchema, validateActionQuery } from '../services/common'
import { type Connector, ConnectorError, type QueryContext } from '../types'
import {
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  type AiToolCall,
  checkBaseUrl,
  executeAiQuery,
} from './core'
import { aiRequest } from './http'
import { costOf, DEFAULT_GEMINI_MODEL, geminiPrice } from './prices'

// Gemini (M37, docs/architecture.md §2.41): Google's models through `generateContent`, either the Gemini API with an
// API key (AI Studio, `generativelanguage.googleapis.com`) or Vertex AI in a Google Cloud project (a service account's
// key, or the server's own Google identity: admins only). No SDK: plain HTTP over the platform's guarded agent, as the
// OpenAI-compatible connector.

export const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta'

/** This process's Gemini settings, set once by the server (like `configureSheets`). */
export interface GeminiDefaults {
  /** The server's own Google identity (`cloud-platform`), only where the instance allows resources to use it. */
  serverIdentity?: ServerIdentity
  /** Google's token endpoint, for tests. */
  tokenUrl?: string
}

let defaults: GeminiDefaults = {}

export function configureGemini(next: GeminiDefaults): void {
  defaults = next
}

const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const configSchema = z.object({
  /** `gemini`: the Gemini API with an API key; `vertex`: Vertex AI in a Google Cloud project. */
  platform: z.enum(['gemini', 'vertex']).default('gemini'),
  /** Vertex: a service account's key, or the server's own Google identity. */
  identity: z.enum(['key', 'server']).default('key'),
  /** Vertex: the project (the key's own when empty) and the region (`global`, `europe-west4`…). */
  project: optionalText(
    z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/, 'A Google Cloud project id'),
  ),
  location: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/, 'A region, like global or europe-west4')
    .default('global'),
  model: z.string().trim().min(1).max(200).default(DEFAULT_GEMINI_MODEL),
  /** A proxy, or the tests' fake; empty for Google's API. */
  baseUrl: optionalText(z.string().trim().url().max(2048)),
  budgetTokens: z.number().int().positive().max(1_000_000_000).optional(),
  hidePrompts: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({
  apiKey: z.string().optional(),
  serviceAccountKey: z
    .string()
    .min(1)
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account')
    .optional(),
})
type Secrets = z.output<typeof secretsSchema>

interface Client {
  config: Config
  agent: Agent
  /** The API key (Gemini API), or the Vertex identity's tokens. */
  apiKey?: string
  tokens?: GoogleTokens
  /** Vertex: the project the calls go to. */
  project?: string
}

const querySchema = actionQuerySchema('gemini')

// What Gemini sends and answers (the parts this connector uses).
interface Part {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}
interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
  }
  modelVersion?: string
}

const REFUSALS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'OTHER',
])

function provider(client: Client): AiProvider {
  return {
    name: 'gemini',
    defaultModel: client.config.model,
    complete: (request) => complete(client, request),
  }
}

/** Gemini 3 and later take a thinking level; older models answer it with an error. */
function takesThinkingLevel(model: string): boolean {
  const m = /^gemini-(\d+)/.exec(model.replace(/^models\//, ''))
  return !m || Number(m[1]) >= 3
}

async function complete(client: Client, request: AiCompletionRequest): Promise<AiCompletion> {
  const generationConfig = {
    maxOutputTokens: request.maxTokens,
    ...(request.schema && { responseMimeType: 'application/json', responseJsonSchema: request.schema }),
    ...(request.effort &&
      takesThinkingLevel(request.model) && {
        thinkingConfig: { thinkingLevel: request.effort.toUpperCase() },
      }),
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }, ...turnsOf(request)],
    ...(request.system && { systemInstruction: { parts: [{ text: request.system }] } }),
    ...(request.tools?.length && {
      tools: [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.inputSchema,
          })),
        },
      ],
    }),
    generationConfig,
  }
  const res = await call<GenerateResponse>(
    client,
    'POST',
    `${modelPath(client, request.model)}:generateContent`,
    body,
    request.signal,
    request.timeoutMs,
  )
  return completionOf(res, request.model)
}

/**
 * The agent's turns after the prompt: the model's content sent back exactly as it came (thought signatures included:
 * Gemini wants them unchanged), the tools' results as a user turn of `functionResponse` parts, each named after the
 * call it answers.
 */
function turnsOf(request: AiCompletionRequest): Content[] {
  const out: Content[] = []
  let calls = new Map<string, { name: string; ownId: boolean }>()
  for (const turn of request.turns ?? []) {
    if (turn.kind === 'assistant') {
      const parts = turn.raw as Part[]
      out.push({ role: 'model', parts })
      calls = new Map(callsOf(parts).map((c) => [c.id, { name: c.name, ownId: c.ownId }]))
    } else {
      out.push({
        role: 'user',
        parts: turn.results.map((r) => {
          const call = calls.get(r.id)
          return {
            functionResponse: {
              // Gemini's own id goes back; one we made up (it sent none) doesn't.
              ...(!call?.ownId && { id: r.id }),
              name: call?.name ?? r.id,
              response: r.isError ? { error: r.content } : { result: r.content },
            },
          }
        }),
      })
    }
  }
  return out
}

/** The function calls in a model turn; a call without an id (or a repeated one) gets one from its place. */
function callsOf(parts: Part[]): (AiToolCall & { ownId: boolean })[] {
  const seen = new Set<string>()
  return parts.flatMap((part, i) => {
    if (!part.functionCall?.name) return []
    let id = part.functionCall.id
    const ownId = !id || seen.has(id)
    if (ownId) id = `call_${i}_${seen.size}`
    seen.add(id!)
    return [{ id: id!, name: part.functionCall.name, input: part.functionCall.args ?? {}, ownId }]
  })
}

/** The answer's text (thoughts left out), the calls it makes, usage and cost. */
export function completionOf(res: GenerateResponse, asked: string, at = new Date()): AiCompletion {
  const candidate = res.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
  const meta = res.usageMetadata ?? {}
  const cached = meta.cachedContentTokenCount ?? 0
  const prompt = meta.promptTokenCount ?? 0
  const usage = {
    inputTokens: Math.max(0, prompt - cached),
    // Thinking is billed as output.
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
  const model = res.modelVersion ?? asked
  const toolCalls = callsOf(parts).map(({ ownId: _, ...call }) => call)
  const blocked = res.promptFeedback?.blockReason
  const finish = candidate?.finishReason ?? (blocked ? 'BLOCKED' : 'STOP')
  const refused = !!blocked || REFUSALS.has(finish)
  return {
    text,
    ...(toolCalls.length && { toolCalls, raw: parts }),
    model,
    usage,
    stopReason: refused
      ? 'refusal'
      : finish === 'MAX_TOKENS'
        ? 'max_tokens'
        : toolCalls.length
          ? 'tool_use'
          : finish === 'STOP'
            ? 'end'
            : finish.toLowerCase(),
    refusalCategory: refused ? (blocked ?? finish).toLowerCase() : null,
    costUsd: costOf(usage, geminiPrice(model, prompt, at) ?? geminiPrice(asked, prompt, at)),
  }
}

/** Where a model lives: `models/<id>` on the Gemini API, the publisher's model in the project on Vertex. */
function modelPath(client: Client, model: string): string {
  const id = encodeURIComponent(model.replace(/^models\//, ''))
  if (client.config.platform === 'gemini') return `/models/${id}`
  const location = client.config.location
  return `/projects/${client.project}/locations/${location}/publishers/google/models/${id}`
}

function baseUrl(config: Config): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, '')
  if (config.platform === 'gemini') return GEMINI_API
  // The global endpoint has no region in its host.
  return config.location === 'global'
    ? 'https://aiplatform.googleapis.com/v1'
    : `https://${config.location}-aiplatform.googleapis.com/v1`
}

/** One API call with the resource's key or token (Vertex: one retry with a fresh token on 401). */
async function call<T>(
  client: Client,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const url = `${baseUrl(client.config)}${path}`
  checkBaseUrl(url, client.config.allowPrivateNetwork)
  const send = async (force: boolean) =>
    aiRequest<T>({
      method,
      url,
      headers: client.apiKey
        ? { 'x-goog-api-key': client.apiKey }
        : { authorization: `Bearer ${await client.tokens!.token(signal, force)}` },
      body,
      agent: client.agent,
      signal,
      timeoutMs,
      hints:
        client.config.platform === 'gemini'
          ? { 400: '', 401: ' (check the API key)', 403: ' (check the API key)', 404: ' (check the model)' }
          : {
              401: ' (check the service account key)',
              403: ' (the identity needs the Vertex AI User role in the project, and the Vertex AI API enabled)',
              404: ' (check the project, region and model)',
            },
    })
  try {
    return await send(false)
  } catch (err) {
    if (client.tokens && err instanceof ConnectorError && err.details?.status === 401) return send(true)
    throw err
  }
}

function geminiClient(config: Config, secrets: Secrets, agent: Agent): Client {
  if (config.platform === 'gemini') {
    if (!secrets.apiKey) throw new ConnectorError('invalid_config', 'Add the Gemini API key (apiKey)')
    return { config, agent, apiKey: secrets.apiKey }
  }
  if (config.identity === 'server') {
    const identity = defaults.serverIdentity
    if (!identity) {
      throw new ConnectorError(
        'invalid_config',
        "This instance doesn't let resources use its own Google identity; use a service account key",
      )
    }
    if (!config.project) {
      throw new ConnectorError(
        'invalid_config',
        "Name the project: the server's identity has none of its own",
      )
    }
    return { config, agent, tokens: identity, project: config.project }
  }
  if (!secrets.serviceAccountKey) {
    throw new ConnectorError('invalid_config', 'Add the service account key (serviceAccountKey)')
  }
  const key = parseServiceAccountKey(secrets.serviceAccountKey, 'serviceAccountKey')
  const tokens = serviceAccountTokens(key, {
    scope: VERTEX_SCOPE,
    field: 'serviceAccountKey',
    tokenUrl: defaults.tokenUrl ?? GOOGLE_TOKEN_URL,
    dispatcher: agent,
  })
  return { config, agent, tokens, project: config.project ?? key.project_id }
}

/** A client made lazily, so a resource with missing settings still opens (its queries say what's missing). */
interface LazyClient {
  config: Config
  agent: Agent
  get(): Client
}

export const geminiConnector: Connector<Config, Secrets, typeof querySchema._output, LazyClient> = {
  type: 'gemini',
  label: 'Gemini',
  configSchema,
  secretsSchema,
  querySchema,
  createClient(resource) {
    const agent = new Agent({
      connections: 16,
      connect: resource.config.allowPrivateNetwork ? {} : { lookup: guardedLookup },
    })
    let client: Client | undefined
    return {
      config: resource.config,
      agent,
      get: () => {
        client ??= geminiClient(resource.config, resource.secrets, agent)
        return client
      },
    }
  },
  async destroyClient(client) {
    await client.agent.close()
  },
  async testConnection(lazy, ctx) {
    const client = lazy.get()
    if (client.config.platform === 'gemini') {
      const res = await call<{ models?: { name?: string }[] }>(
        client,
        'GET',
        '/models?pageSize=1000',
        undefined,
        ctx.signal,
        ctx.timeoutMs,
      )
      const ids = (res.models ?? []).flatMap((m) => (m.name ? [m.name.replace(/^models\//, '')] : []))
      const known = ids.includes(client.config.model)
      return {
        message: known
          ? `Signed in: ${ids.length} models, ${client.config.model} among them`
          : `Signed in: ${ids.length} models (the default ${client.config.model} isn't listed)`,
      }
    }
    // Vertex lists no publisher models per project: counting a word's tokens checks the identity, the project, the
    // region and the model at once, and costs nothing.
    const res = await call<{ totalTokens?: number }>(
      client,
      'POST',
      `${modelPath(client, client.config.model)}:countTokens`,
      { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      ctx.signal,
      ctx.timeoutMs,
    )
    return {
      message: `Signed in: ${client.config.model} answers in ${client.project} (${client.config.location}), ${res.totalTokens ?? '?'} token for a test word`,
    }
  },
  validateQuery: validateActionQuery,
  async execute(lazy, query, ctx: QueryContext) {
    return executeAiQuery(provider(lazy.get()), lazy.config, query, ctx)
  },
}

export { provider as geminiProvider }
