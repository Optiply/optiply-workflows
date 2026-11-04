import { agentTools } from '@ow/definition'
import type { ActionQuery, fieldReader } from '../services/common'
import { ConnectorError, type QueryContext, type QueryResult } from '../types'
import {
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  type AiSettings,
  type AiToolCall,
  type AiToolResult,
  completeCounted,
  describe,
} from './core'
import type { AiUsage } from './prices'
import { countAiCall } from './stats'

// The agent action (M35, docs/architecture.md §2.38): a manual tool loop in which the model may call the workflows its
// query names, each call a child run of this run (through the run's tool host), until it answers, runs out of steps,
// or spends the run's budget.

export const DEFAULT_MAX_STEPS = 10
export const MAX_STEPS = 50
/** Tool calls of one turn running at once. */
const TOOL_CONCURRENCY = 4
/** A tool's result over this is cut, with a note, before it goes back to the model. */
const MAX_RESULT_CHARS = 100_000

/** One tool call the agent made: the workflow, its input, the child run, and whether it succeeded. */
export interface AgentStep {
  workflow: string
  input: unknown
  runId: string | null
  ok: boolean
}

export async function runAgent(
  provider: AiProvider,
  settings: AiSettings,
  query: ActionQuery,
  ctx: QueryContext,
  f: ReturnType<typeof fieldReader>,
  base: Omit<AiCompletionRequest, 'prompt'>,
): Promise<QueryResult> {
  const host = ctx.ai?.tools
  if (!host) {
    throw new ConnectorError('invalid_query', 'The agent runs in workflows only (an app can call a workflow)')
  }
  const slugs = agentTools(query)
  if (!slugs.length) throw new ConnectorError('invalid_query', 'Tools: name at least one workflow')
  if (slugs.some((s) => s.includes('{{'))) {
    throw new ConnectorError('invalid_query', 'Tools are workflow slugs written out, not {{ }} expressions')
  }
  const maxSteps = Math.min(
    MAX_STEPS,
    Math.max(1, Math.round((await f.number('maxSteps')) ?? DEFAULT_MAX_STEPS)),
  )
  const system = await f.text('instructions')
  const prompt = await f.required('prompt')
  const tools = await host.describe(slugs)
  const request: AiCompletionRequest = {
    ...base,
    prompt,
    ...(system && { system }),
    tools,
    turns: [],
  }

  const steps: AgentStep[] = []
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let cost: number | null = 0
  let model = base.model
  let durationMs = 0
  const metadata = (last: AiCompletion) => ({
    ...describe(provider, settings, { ...last, model, usage, costUsd: cost }, durationMs, request),
    steps: steps.length,
  })

  for (let turn = 0; ; turn++) {
    let answered: Awaited<ReturnType<typeof completeCounted>>
    try {
      answered = await completeCounted(provider, settings, request, ctx)
    } catch (err) {
      // The calls before this one used tokens too: the failure carries them (the run log line, the budget).
      if (err instanceof ConnectorError && turn > 0) {
        throw new ConnectorError(err.code, err.message, {
          ...err.details,
          ...describe(
            provider,
            settings,
            { text: '', model, usage, stopReason: 'error', costUsd: cost },
            durationMs,
            request,
          ),
          steps,
        })
      }
      throw err
    }
    const { answer } = answered
    model = answer.model
    durationMs += answered.durationMs
    for (const key of Object.keys(usage) as (keyof AiUsage)[]) usage[key] += answer.usage[key]
    cost = cost === null || answer.costUsd === null ? null : Math.round((cost + answer.costUsd) * 1e6) / 1e6
    const calls = answer.toolCalls ?? []
    const outcome =
      answer.stopReason === 'refusal'
        ? 'ai_refused'
        : answer.stopReason === 'max_tokens'
          ? 'ai_max_tokens'
          : calls.length && turn >= maxSteps
            ? 'ai_max_steps'
            : 'ok'
    countAiCall(provider.name, answer.model, outcome, answer)
    if (outcome === 'ai_refused') {
      throw new ConnectorError(
        'ai_refused',
        `The model declined to answer${answer.refusalCategory ? ` (${answer.refusalCategory})` : ''}`,
        { ...metadata(answer), steps },
      )
    }
    if (outcome === 'ai_max_tokens') {
      throw new ConnectorError(
        'ai_max_tokens',
        `The answer was cut off at ${request.maxTokens} tokens: raise Max tokens`,
        { ...metadata(answer), steps },
      )
    }
    if (!calls.length) {
      return { data: { answer: answer.text, steps }, metadata: metadata(answer) }
    }
    if (outcome === 'ai_max_steps') {
      throw new ConnectorError(
        'ai_max_steps',
        `The agent was still calling tools after ${maxSteps} steps: raise Max steps, or give it clearer instructions`,
        { ...metadata(answer), steps },
      )
    }
    const results = await mapLimited(calls, TOOL_CONCURRENCY, (call) =>
      callTool(call, slugs, host, ctx.signal, steps),
    )
    request.turns!.push({ kind: 'assistant', raw: answer.raw }, { kind: 'results', results })
  }
}

async function callTool(
  call: AiToolCall,
  slugs: readonly string[],
  host: NonNullable<NonNullable<QueryContext['ai']>['tools']>,
  signal: AbortSignal,
  steps: AgentStep[],
): Promise<AiToolResult> {
  if (!slugs.includes(call.name)) {
    return { id: call.id, content: `There's no tool named "${call.name}"`, isError: true }
  }
  const step: AgentStep = { workflow: call.name, input: call.input, runId: null, ok: false }
  steps.push(step)
  try {
    const result = await host.run(call.name, call.input, signal, call.id)
    step.runId = result.runId
    step.ok = result.ok
    return { id: call.id, content: clip(JSON.stringify(result.data ?? null)), isError: !result.ok }
  } catch (err) {
    if (signal.aborted) throw err
    return { id: call.id, content: clip((err as Error).message), isError: true }
  }
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[cut: the result was ${text.length} characters, over ${MAX_RESULT_CHARS}]`
    : text
}

/** Maps with at most `limit` running at once, results in order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
