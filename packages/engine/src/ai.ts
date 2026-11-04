import { AI_RESOURCE_TYPES, tokensOf } from '@ow/connectors'
import type { BlockResult } from './types'

// AI calls in runs (M35, docs/architecture.md §2.38): the run's token budget, and the run log's line per call. The
// calls themselves are resource queries on AI resources (the connectors' `ai/`).

interface Usage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** An AI call's metadata (a query's, or a failed one's error details), or null for anything else. */
function aiMetadata(metadata: unknown): (Record<string, unknown> & { usage: Usage }) | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  if (typeof m.provider !== 'string' || !AI_RESOURCE_TYPES.has(m.provider)) return null
  if (!m.usage || typeof m.usage !== 'object') return null
  return m as Record<string, unknown> & { usage: Usage }
}

function tokens(usage: Usage): number {
  return tokensOf({
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  })
}

/**
 * The tokens a run's AI calls have used, which each AI resource's budget is checked against. Kept in the process
 * for the run (its function calls share it); a resumed run starts from its checkpoints' AI calls (a loop's
 * iterations keep only their data, so theirs aren't counted again after a resume).
 */
export class RunAiBudget {
  private total = 0

  static fromCheckpoints(checkpoints: readonly BlockResult[] | undefined): RunAiBudget {
    const budget = new RunAiBudget()
    for (const checkpoint of checkpoints ?? []) {
      const ai = aiMetadata(checkpoint.metadata) ?? aiMetadata(checkpoint.error?.details)
      if (ai) budget.add(tokens(ai.usage))
    }
    return budget
  }

  spent(): number {
    return this.total
  }

  add(n: number): void {
    if (Number.isFinite(n) && n > 0) this.total += n
  }
}

/**
 * The run log's line for an AI call: provider, model, tokens, cost and time (the prompts sent are in the block's
 * metadata, as a REST query's request is, unless the resource hides them). Null when the metadata isn't an AI call's.
 */
export function aiLogLine(metadata: unknown): string | null {
  const ai = aiMetadata(metadata)
  if (!ai) return null
  const u = ai.usage
  const cached = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  const parts = [
    `${num(u.inputTokens)} input + ${num(u.outputTokens)} output tokens${cached ? ` (${num(u.cacheReadTokens)} read from cache, ${num(u.cacheWriteTokens)} written)` : ''}`,
    typeof ai.costUsd === 'number' ? `$${ai.costUsd.toFixed(ai.costUsd < 0.01 ? 6 : 4)}` : 'cost unknown',
    ...(typeof ai.durationMs === 'number' ? [`${(ai.durationMs / 1000).toFixed(1)} s`] : []),
    ...(ai.promptsHidden ? ['prompts hidden'] : []),
  ]
  return `AI call: ${String(ai.provider)} ${String(ai.model)}, ${parts.join(', ')}`
}

function num(n: number | undefined): string {
  return (n ?? 0).toLocaleString('en-US')
}
