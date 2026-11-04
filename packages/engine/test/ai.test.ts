import { describe, expect, it } from 'vitest'
import { aiLogLine, RunAiBudget } from '../src/ai'
import type { BlockResult } from '../src/types'

// The run's AI budget and log line (M35): the calls themselves are tested in connectors and the server.

const checkpoint = (key: string, over: Partial<BlockResult>): BlockResult => ({
  key,
  status: 'succeeded',
  data: null,
  sizeBytes: 4,
  error: null,
  metadata: {},
  port: 'out',
  attempt: 1,
  startedAt: null,
  finishedAt: new Date(),
  ...over,
})

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }

describe('the run AI budget', () => {
  it("starts from the checkpoints' AI calls, failed ones included, and nothing else", () => {
    const budget = RunAiBudget.fromCheckpoints([
      checkpoint('a', { metadata: { provider: 'anthropic', model: 'm', usage } }),
      checkpoint('b', {
        status: 'errored',
        error: { code: 'ai_refused', message: 'no', details: { provider: 'openai_compatible', usage } },
      }),
      checkpoint('c', { metadata: { rowCount: 3, usage } }),
    ])
    expect(budget.spent()).toBe(250)
    budget.add(10)
    budget.add(Number.NaN)
    budget.add(-5)
    expect(budget.spent()).toBe(260)
  })
})

describe('the AI log line', () => {
  it('names the provider, model, tokens, cost and time', () => {
    expect(
      aiLogLine({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        usage,
        costUsd: 0.0123,
        durationMs: 1234,
      }),
    ).toBe(
      'AI call: anthropic claude-sonnet-5-5, 100 input + 20 output tokens (5 read from cache, 0 written), $0.0123, 1.2 s',
    )
    expect(
      aiLogLine({ provider: 'openai_compatible', model: 'x', usage, costUsd: null, promptsHidden: true }),
    ).toMatch(/cost unknown, prompts hidden$/)
    expect(aiLogLine({ rowCount: 1 })).toBeNull()
    expect(aiLogLine(undefined)).toBeNull()
  })
})
