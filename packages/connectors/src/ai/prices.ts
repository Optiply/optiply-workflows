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

/**
 * Gemini's paid-tier prices (M37), from Google's pricing page on 2026-11-13, per million tokens. Some change on a date
 * (Google announced them): each model lists its prices from oldest to newest, `from` an ISO date (UTC). `longInput` is
 * the price for prompts over 200k tokens where Google tiers it. Cache reads are Google's context-caching price.
 */
export interface DatedPrice extends ModelPrice {
  from?: string
  longInput?: ModelPrice
}

export const GEMINI_PRICES: Readonly<Record<string, readonly DatedPrice[]>> = {
  'gemini-4-carbon': [
    { input: 2, output: 10, cacheRead: 0.1 },
    { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 },
  ],
  'gemini-4-argon': [
    { input: 2, output: 10, cacheRead: 0.1 },
    { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 },
  ],
  'gemini-4-hydrogen': [{ input: 1.5, output: 7.5, cacheRead: 0.075 }],
  'gemini-3.8-flash': [
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    { from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 },
  ],
  'gemini-3.6-flash': [
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    { from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 },
  ],
  'gemini-3.5-flash-lite': [{ input: 0.3, output: 2.5, cacheRead: 0.03 }],
  'gemini-3.1-pro-preview': [
    { input: 2, output: 12, cacheRead: 0.2, longInput: { input: 4, output: 18, cacheRead: 0.4 } },
  ],
  'gemini-3.1-flash-lite': [{ input: 0.25, output: 1.5, cacheRead: 0.025 }],
  'gemini-3-flash-preview': [{ input: 0.5, output: 3, cacheRead: 0.05 }],
  'gemini-2.5-pro': [
    { input: 1.25, output: 10, cacheRead: 0.125, longInput: { input: 2.5, output: 15, cacheRead: 0.25 } },
  ],
  'gemini-2.5-flash': [{ input: 0.3, output: 2.5, cacheRead: 0.03 }],
  'gemini-2.5-flash-lite': [{ input: 0.1, output: 0.4, cacheRead: 0.01 }],
}

/** The current Gemini text models offered in the editor (the default first). Any other id may be typed. */
export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
] as const

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'

/** A Gemini model's price at a moment, for a prompt of so many tokens; undefined for a model not listed. */
export function geminiPrice(model: string, promptTokens: number, at = new Date()): ModelPrice | undefined {
  // Vertex answers with a version (`gemini-3.8-flash-001`); the list has the model's name.
  const prices = GEMINI_PRICES[model] ?? GEMINI_PRICES[model.replace(/-\d{3}$/, '')]
  const day = at.toISOString().slice(0, 10)
  const price = prices?.filter((p) => !p.from || p.from <= day).at(-1)
  if (!price) return undefined
  return promptTokens > 200_000 && price.longInput ? price.longInput : price
}

/** The AI resource types (M35, M37): their queries' metadata has the provider, model, usage and cost. */
export const AI_RESOURCE_TYPES: ReadonlySet<string> = new Set(['anthropic', 'openai_compatible', 'gemini'])

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
