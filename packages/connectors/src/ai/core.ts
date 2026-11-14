import { compileBodySchema } from '@ow/definition/body-schema'
import { isPrivateAddress } from '../net-guard'
import { type ActionQuery, fieldReader } from '../services/common'
import { ConnectorError, type QueryContext, type QueryResult } from '../types'
import { runAgent } from './agent'
import { type AiUsage, tokensOf } from './prices'
import { countAiCall } from './stats'

// What the two AI connectors share (M35, docs/architecture.md §2.38): the actions read from a query, turned into one
// model call each (the agent: several, in ai/agent.ts), and their answers checked and described.

export type AiProviderName = 'anthropic' | 'openai_compatible' | 'gemini'

/** One call: a system prompt and a user prompt, optionally an answer as JSON matching `schema`. */
export interface AiCompletionRequest {
  model: string
  system?: string
  prompt: string
  maxTokens: number
  effort?: 'low' | 'medium' | 'high'
  /** Structured output: the answer is JSON valid against this (an object schema). */
  schema?: Record<string, unknown>
  signal: AbortSignal
  timeoutMs: number
  /** The agent's tools (workflows), offered to the model. */
  tools?: AiToolSpec[]
  /** The agent's conversation after the prompt: the model's turns (as it sent them) and the tools' results. */
  turns?: AiTurn[]
}

/** A turn of the agent's conversation after the first prompt. */
export type AiTurn = { kind: 'assistant'; raw: unknown } | { kind: 'results'; results: AiToolResult[] }

/** A tool the model asked to call: the provider's call id, the tool's name and its input. */
export interface AiToolCall {
  id: string
  name: string
  input: unknown
}

/** A tool's result going back to the model. */
export interface AiToolResult {
  id: string
  content: string
  isError: boolean
}

export interface AiCompletion {
  text: string
  /** The model that answered (a refusal fallback may have answered instead of the one asked). */
  model: string
  usage: AiUsage
  /** `end`, `max_tokens`, `refusal`, or the provider's own word for anything else. */
  stopReason: string
  refusalCategory?: string | null
  costUsd: number | null
  /** The tools the model asked to call (the agent; stopReason `tool_use`). */
  toolCalls?: AiToolCall[]
  /** The model's turn as the provider sent it, to send back with the tools' results. */
  raw?: unknown
}

/** A provider as the actions use it. */
export interface AiProvider {
  name: AiProviderName
  defaultModel: string
  complete(request: AiCompletionRequest): Promise<AiCompletion>
}

/** The settings both AI resources have. */
export interface AiSettings {
  /** The run's tokens (input and output, all its AI calls) this resource lets it spend; none: no limit. */
  budgetTokens?: number | undefined
  /** Leaves the prompts out of the query's metadata (so out of run history). */
  hidePrompts?: boolean | undefined
}

/**
 * What a run gives AI queries (M35), through the query context: the tokens its AI calls have used so far, and, in
 * workflows, the workflows an agent may call. Apps give neither tools nor (yet) a budget.
 */
export interface AiRunContext {
  budget?: { spent(): number; add(tokens: number): void }
  tools?: AiToolHost
}

/** Workflows as an agent's tools (M35, step 3): their descriptions, and running one with an input. */
export interface AiToolHost {
  describe(slugs: string[]): Promise<AiToolSpec[]>
  /** Runs the workflow (a child run, keyed by `callKey`: the turn, the call's place in it and its id). */
  run(
    slug: string,
    input: unknown,
    signal: AbortSignal,
    callKey: string,
  ): Promise<{ ok: boolean; data: unknown; runId: string | null }>
}

export interface AiToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const DEFAULT_MAX_TOKENS = 16_000
const MAX_MAX_TOKENS = 128_000

const LENGTHS: Record<string, string> = {
  short: 'in a sentence or two',
  medium: 'in one paragraph',
  long: 'in several paragraphs, covering every main point',
}

/** The query's actions, run against a provider. The data is the answer; usage, model and cost the metadata. */
export async function executeAiQuery(
  provider: AiProvider,
  settings: AiSettings,
  query: ActionQuery,
  ctx: QueryContext,
): Promise<QueryResult> {
  const f = fieldReader(provider.name, query, ctx)
  const model = (await f.text('model')) ?? provider.defaultModel
  const maxTokens = Math.min(
    MAX_MAX_TOKENS,
    Math.max(1, Math.round((await f.number('maxTokens')) ?? DEFAULT_MAX_TOKENS)),
  )
  const effortText = await f.text('effort')
  const effort =
    effortText === 'low' || effortText === 'medium' || effortText === 'high' ? effortText : undefined
  const base: Omit<AiCompletionRequest, 'prompt'> = {
    model,
    maxTokens,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    ...(effort && { effort }),
  }

  if (query.action === 'agent') return runAgent(provider, settings, query, ctx, f, base)

  let request: AiCompletionRequest
  let read: (completion: AiCompletion) => unknown
  switch (query.action) {
    case 'generate': {
      const system = await f.text('system')
      request = { ...base, prompt: await f.required('prompt'), ...(system && { system }) }
      read = (c) => c.text
      break
    }
    case 'summarize': {
      const length = LENGTHS[(await f.text('length')) ?? 'medium'] ?? LENGTHS.medium!
      const bullets = (await f.text('style')) === 'bullets'
      const instructions = await f.text('instructions')
      request = {
        ...base,
        system:
          'You summarize texts accurately and plainly. Reply with the summary only, without a preamble.',
        prompt: [
          `Summarize the text below ${length}${bullets ? ', as bullet points' : ''}.`,
          ...(instructions ? [instructions] : []),
          '',
          '<text>',
          await f.required('input'),
          '</text>',
        ].join('\n'),
      }
      read = (c) => c.text.trim()
      break
    }
    case 'extract': {
      const schema = await f.object('schema')
      if (!schema) throw new ConnectorError('invalid_query', 'JSON Schema is empty')
      if (schema.type !== 'object') {
        throw new ConnectorError(
          'invalid_query',
          'The JSON Schema must describe an object ("type": "object")',
        )
      }
      const compiled = compileBodySchema(schema)
      if (!compiled.ok)
        throw new ConnectorError('invalid_query', `The JSON Schema isn't valid: ${compiled.error}`)
      const instructions = await f.text('instructions')
      request = {
        ...base,
        schema,
        system: [
          'You extract data from texts into JSON. Use only what the text says; leave out what it doesn’t say',
          '(or use null where the schema allows it). Never invent values.',
          ...(instructions ? ['', instructions] : []),
        ].join('\n'),
        prompt: ['<text>', await f.required('input'), '</text>'].join('\n'),
      }
      read = (c) => {
        const value = parseJson(c.text)
        const errors = compiled.validate(value)
        if (errors) {
          throw new ConnectorError(
            'ai_invalid_output',
            `The answer doesn't match the schema: ${errors.map((e) => `${e.path || '(root)'} ${e.message}`).join('; ')}`,
            { answer: c.text.slice(0, 2000) },
          )
        }
        return value
      }
      break
    }
    case 'classify': {
      const labels = [...new Set(await f.list('labels'))]
      if (labels.length < 2) throw new ConnectorError('invalid_query', 'Labels: give at least two')
      if (labels.length > 100) throw new ConnectorError('invalid_query', 'Labels: at most 100')
      const multiple = (await f.bool('multiple')) ?? false
      const instructions = await f.text('instructions')
      const label = { type: 'string', enum: labels }
      request = {
        ...base,
        schema: {
          type: 'object',
          properties: {
            ...(multiple ? { labels: { type: 'array', items: label } } : { label }),
            reason: { type: 'string', description: 'Why, in a sentence.' },
          },
          required: [multiple ? 'labels' : 'label', 'reason'],
          additionalProperties: false,
        },
        system: 'You classify texts. Pick only from the labels given.',
        prompt: [
          multiple
            ? `Which of these labels apply to the text below (every one that does)? ${labels.join(', ')}`
            : `Which one of these labels fits the text below best? ${labels.join(', ')}`,
          ...(instructions ? [instructions] : []),
          '',
          '<text>',
          await f.required('input'),
          '</text>',
        ].join('\n'),
      }
      read = (c) => {
        const value = parseJson(c.text) as { label?: unknown; labels?: unknown; reason?: unknown }
        const chosen = multiple ? value.labels : value.label
        const valid = multiple
          ? Array.isArray(chosen) && chosen.every((l) => labels.includes(String(l)))
          : typeof chosen === 'string' && labels.includes(chosen)
        if (!valid) {
          throw new ConnectorError('ai_invalid_output', 'The answer isn’t one of the labels', {
            answer: c.text.slice(0, 2000),
          })
        }
        return multiple
          ? { labels: chosen, reason: value.reason ?? '' }
          : { label: chosen, reason: value.reason ?? '' }
      }
      break
    }
    default:
      throw new ConnectorError('invalid_query', `Unknown action ${query.action}`)
  }

  const completion = await completeCounted(provider, settings, request, ctx)
  const metadata = describe(provider, settings, completion.answer, completion.durationMs, request)
  let outcome = 'ok'
  try {
    if (completion.answer.stopReason === 'refusal') {
      throw new ConnectorError(
        'ai_refused',
        `The model declined to answer${completion.answer.refusalCategory ? ` (${completion.answer.refusalCategory})` : ''}`,
        metadata,
      )
    }
    stoppedEarly(completion.answer, request, metadata)
    return { data: read(completion.answer), metadata }
  } catch (err) {
    if (!(err instanceof ConnectorError)) {
      outcome = 'error'
      throw err
    }
    outcome = err.code
    // The answer's usage and cost go with the failure too (the run log line).
    if (err.code !== 'ai_invalid_output') throw err
    throw new ConnectorError(err.code, err.message, { ...metadata, ...err.details })
  } finally {
    countAiCall(provider.name, completion.answer.model, outcome, completion.answer)
  }
}

/**
 * One model call, within the run's budget: refused when it's spent, its tokens added once answered. A call that
 * never answers is counted here; one that did, by the caller once it has read the answer.
 */
export async function completeCounted(
  provider: AiProvider,
  settings: AiSettings,
  request: AiCompletionRequest,
  ctx: Pick<QueryContext, 'ai'>,
): Promise<{ answer: AiCompletion; durationMs: number }> {
  try {
    checkBudget(settings, ctx)
  } catch (err) {
    countAiCall(provider.name, request.model, 'ai_budget')
    throw err
  }
  const started = Date.now()
  let answer: AiCompletion
  try {
    answer = await provider.complete(request)
  } catch (err) {
    countAiCall(provider.name, request.model, err instanceof ConnectorError ? err.code : 'error')
    throw err
  }
  ctx.ai?.budget?.add(tokensOf(answer.usage))
  return { answer, durationMs: Date.now() - started }
}

/**
 * An answer that stopped before it was finished: cut off at Max tokens or the model's context window, or any stop the
 * actions don't expect (an agent's `tool_use` aside). Refusals are reported before this.
 */
export function stoppedEarly(
  answer: AiCompletion,
  request: Pick<AiCompletionRequest, 'maxTokens'>,
  metadata: Record<string, unknown>,
): void {
  if (answer.stopReason === 'end' || answer.stopReason === 'tool_use') return
  if (answer.stopReason === 'max_tokens') {
    throw new ConnectorError(
      'ai_max_tokens',
      `The answer was cut off at ${request.maxTokens} tokens: raise Max tokens`,
      metadata,
    )
  }
  if (answer.stopReason === 'model_context_window_exceeded') {
    throw new ConnectorError(
      'ai_max_tokens',
      "The input and answer didn't fit in the model's context window: shorten the input",
      metadata,
    )
  }
  throw new ConnectorError(
    'ai_invalid_output',
    `The model stopped before finishing (${answer.stopReason})`,
    metadata,
  )
}

/** Refuses a call when the run has spent the resource's budget already. */
export function checkBudget(settings: AiSettings, ctx: Pick<QueryContext, 'ai'>): void {
  const budget = settings.budgetTokens
  if (!budget || !ctx.ai?.budget) return
  const spent = ctx.ai.budget.spent()
  if (spent >= budget) {
    throw new ConnectorError(
      'ai_budget',
      `This run has used ${spent} AI tokens, over the resource's budget of ${budget} per run`,
    )
  }
}

/** What's kept with the answer: provider, model, usage, cost, time, and (unless hidden) the prompts sent. */
export function describe(
  provider: AiProvider,
  settings: AiSettings,
  completion: AiCompletion,
  durationMs: number,
  request: Pick<AiCompletionRequest, 'system' | 'prompt'>,
): Record<string, unknown> {
  return {
    provider: provider.name,
    model: completion.model,
    usage: completion.usage,
    costUsd: completion.costUsd,
    stopReason: completion.stopReason,
    durationMs,
    ...(settings.hidePrompts
      ? { promptsHidden: true }
      : { request: { ...(request.system && { system: request.system }), prompt: request.prompt } }),
  }
}

/**
 * A base URL whose host is a private address written out (the guarded lookup sees names only) is refused unless the
 * resource allows private networks.
 */
export function checkBaseUrl(url: string, allowPrivateNetwork: boolean): void {
  if (allowPrivateNetwork) return
  const host = new URL(url).hostname
  if (host === 'localhost' || isPrivateAddress(host)) {
    throw new ConnectorError(
      'blocked',
      `${host} is on a private network: allow private networks in the resource to reach it`,
    )
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ConnectorError('ai_invalid_output', 'The answer isn’t JSON', { answer: text.slice(0, 2000) })
  }
}
