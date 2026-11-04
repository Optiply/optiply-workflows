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
  add(aiStats.calls, `${provider}\t${model}\t${outcome}`, 1)
  if (!answered) return
  for (const [kind, field] of KINDS) {
    const n = answered.usage[field]
    if (n) add(aiStats.tokens, `${provider}\t${model}\t${kind}`, n)
  }
  if (answered.costUsd) add(aiStats.costUsd, `${provider}\t${model}`, answered.costUsd)
}
