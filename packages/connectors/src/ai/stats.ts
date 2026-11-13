import type { AiUsage } from './prices'

// What this process's AI calls used (M35, docs/architecture.md §2.38), for the server's metrics:
// `ow_ai_calls_total{provider,model,outcome}`, `ow_ai_tokens_total{provider,model,kind}`,
// `ow_ai_cost_usd_total{provider,model}`. Keys are tab-joined labels, as `queryStats`'.

export const aiStats = {
  /** `provider\tmodel\toutcome` (outcome: `ok` or the error's code). */
  calls: new Map<string, number>(),
  /** `provider\tmodel\tkind` (kind: input, output, cache_read, cache_write). */
  tokens: new Map<string, number>(),
  /** `provider\tmodel`, in US dollars (calls without a price add nothing). */
  costUsd: new Map<string, number>(),
}

const KINDS = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cache_read', 'cacheReadTokens'],
  ['cache_write', 'cacheWriteTokens'],
] as const

/** Model labels seen; past this many, others count as `other` (a model can be any text, even a template's value). */
const MAX_MODELS = 100
const models = new Set<string>()

function modelLabel(model: string): string {
  if (models.has(model)) return model
  if (models.size >= MAX_MODELS) return 'other'
  models.add(model)
  return model
}

function add(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n)
}

/** Counts one call: its outcome, and (when the model answered) its tokens and cost. */
export function countAiCall(
  provider: string,
  model: string,
  outcome: string,
  answered?: { usage: AiUsage; costUsd: number | null },
): void {
  const label = modelLabel(model)
  add(aiStats.calls, `${provider}\t${label}\t${outcome}`, 1)
  if (!answered) return
  for (const [kind, field] of KINDS) {
    const n = answered.usage[field]
    if (n) add(aiStats.tokens, `${provider}\t${label}\t${kind}`, n)
  }
  if (answered.costUsd) add(aiStats.costUsd, `${provider}\t${label}`, answered.costUsd)
}
