/**
 * What a model costs per million tokens, in US dollars (M35): Anthropic's list prices on 2026-11-04, for its current
 * models. An OpenAI-compatible resource gives its own (settings). Unknown models cost null: shown as unknown, not 0.
 */
export interface ModelPrice {
  input: number
  output: number
  /** Reading from the prompt cache; 10% of input when not listed. */
  cacheRead?: number
  /** Writing to the prompt cache (5 minutes); 125% of input when not listed. */
  cacheWrite?: number
}

export const ANTHROPIC_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** The current Anthropic models offered in the editor (the default first). Any other id may be typed. */
export const ANTHROPIC_MODELS = [
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
] as const

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5'

/** The AI resource types (M35): their queries' metadata has the provider, model, usage and cost. */
export const AI_RESOURCE_TYPES: ReadonlySet<string> = new Set(['anthropic', 'openai_compatible'])

/** Models Anthropic's server-side refusal fallback (`fallbacks: "default"`) accepts. */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
])

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The call's cost in US dollars, or null without a price. */
export function costOf(usage: AiUsage, price: ModelPrice | undefined): number | null {
  if (!price) return null
  const cacheRead = price.cacheRead ?? price.input * 0.1
  const cacheWrite = price.cacheWrite ?? price.input * 1.25
  const dollars =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000
  return Math.round(dollars * 1e6) / 1e6
}

/** Every token the call used, counted against a run's budget. */
export function tokensOf(usage: AiUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}
