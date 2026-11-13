import { describe, expect, it } from 'vitest'
import type { BlockView, RunLog } from '@/lib/runs-api'
import { countKinds, filterLines, logLines } from './run-logs'

const view = (
  key: string,
  status: BlockView['status'],
  startedAt: string | null,
  finishedAt: string | null,
) =>
  ({
    key,
    status,
    attempt: 1,
    port: null,
    error: null,
    metadata: null,
    sizeBytes: null,
    startedAt,
    finishedAt,
  }) as BlockView

const logs: RunLog[] = [
  { id: 1, blockKey: 'code1', level: 'log', message: 'hello', at: '2026-10-30T10:00:01.500Z' },
  { id: 2, blockKey: 'code1', level: 'error', message: 'oops', at: '2026-10-30T10:00:01.600Z' },
]
const blocks = [
  view('code1', 'succeeded', '2026-10-30T10:00:01Z', '2026-10-30T10:00:02Z'),
  view('wait1', 'skipped', null, null),
  view('query1', 'failed', '2026-10-30T10:00:03Z', '2026-10-30T10:00:04Z'),
]

describe('logLines', () => {
  it('puts block starts and ends among the logs, in time order, skipped last', () => {
    expect(logLines(logs, blocks).map((l) => l.message)).toEqual([
      '--- Running query: code1 ---',
      'hello',
      'oops',
      '--- Successfully finished running query: code1 ---',
      '--- Running query: query1 ---',
      '--- Query query1 failed ---',
      '--- Skipped query: wait1 ---',
    ])
  })

  it("narrows to one block's lines", () => {
    expect(logLines(logs, blocks, 'query1')).toHaveLength(2)
  })
})

describe('filters', () => {
  const lines = logLines(logs, blocks)
  it('filters by text and level', () => {
    expect(filterLines(lines, 'OOPS', 'all').map((l) => l.message)).toEqual(['oops'])
    expect(filterLines(lines, '', 'error')).toHaveLength(2)
    expect(filterLines(lines, 'query1', 'all')).toHaveLength(2)
  })
  it('counts each kind', () => {
    expect(countKinds(lines)).toEqual({ success: 1, error: 2, warn: 0, info: 4 })
  })
})
