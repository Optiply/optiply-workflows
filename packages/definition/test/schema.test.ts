import { describe, expect, it } from 'vitest'
import { blockPorts, resolveBlockSettings, workflowDefinitionSchema } from '../src'
import { code, start, wf } from './helpers'

describe('workflowDefinitionSchema', () => {
  it('accepts every M2 block type', () => {
    const def = wf(
      [
        { ...start, config: { testInput: { customerId: 1 } } },
        code('transform', 'return startTrigger.data'),
        {
          name: 'getOrders',
          type: 'resourceQuery',
          config: { resource: 'warehouse', query: { sql: 'select 1' } },
        },
        {
          name: 'isBig',
          type: 'branch',
          config: { conditions: [{ id: 'big', expression: 'transform.data > 10' }] },
        },
        {
          name: 'onlyOpen',
          type: 'filter',
          config: { input: '{{ getOrders.data }}', condition: 'value.open' },
        },
        { name: 'reply', type: 'response', config: { status: '201', body: '{"ok": true}' } },
      ],
      [],
      {
        settings: { timeoutMs: 60_000 },
        triggers: {
          webhook: { enabled: true },
          schedules: [{ name: 'nightly', enabled: true, cron: '0 3 * * *' }],
        },
        layout: { blocks: { transform: { x: 10, y: 20 } } },
      },
    )
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects unknown keys, so typos in a stored definition surface', () => {
    const result = workflowDefinitionSchema.safeParse(wf([{ ...code('a'), settigns: {} }]))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/settigns/)
  })

  it('rejects unknown block types and other schema versions', () => {
    expect(
      workflowDefinitionSchema.safeParse(wf([{ name: 'a', type: 'teleport', config: {} }])).success,
    ).toBe(false)
    expect(workflowDefinitionSchema.safeParse({ ...wf([start]), schemaVersion: 2 }).success).toBe(false)
  })

  it('requires block names to be identifiers', () => {
    for (const name of ['1query', 'my-query', 'a b', '', 'x'.repeat(65)]) {
      expect(workflowDefinitionSchema.safeParse(wf([code(name)])).success, name).toBe(false)
    }
    for (const name of ['query1', '_tmp', 'getOrders', 'x'.repeat(64)]) {
      expect(workflowDefinitionSchema.safeParse(wf([code(name)])).success, name).toBe(true)
    }
  })

  it('needs exactly one of cron or intervalMs on a schedule', () => {
    const schedule = (s: object) =>
      wf([start], [], { triggers: { schedules: [{ name: 's', enabled: true, ...s }] } })
    expect(workflowDefinitionSchema.safeParse(schedule({})).success).toBe(false)
    expect(
      workflowDefinitionSchema.safeParse(schedule({ cron: '* * * * *', intervalMs: 60_000 })).success,
    ).toBe(false)
    expect(workflowDefinitionSchema.safeParse(schedule({ intervalMs: 60_000 })).success).toBe(true)
  })
})

describe('blockPorts', () => {
  const parse = (block: object) => workflowDefinitionSchema.parse(wf([block])).blocks[0]!

  it('gives an error port only to blocks that continue on failure', () => {
    expect(blockPorts(parse(code('a')))).toEqual(['out'])
    expect(blockPorts(parse(code('a', 'return 1', { finally: 'continue' })))).toEqual(['out', 'error'])
    expect(blockPorts(parse(start))).toEqual(['out'])
  })

  it('gives a branch one port per condition plus else, and no out', () => {
    const branch = {
      name: 'b',
      type: 'branch',
      settings: { finally: 'continue' },
      config: {
        conditions: [
          { id: 'one', expression: 'true' },
          { id: 'two', expression: 'false' },
        ],
      },
    }
    expect(blockPorts(parse(branch))).toEqual(['cond:one', 'cond:two', 'else', 'error'])
  })
})

describe('resolveBlockSettings', () => {
  it('fills in defaults around what the block sets', () => {
    const block = workflowDefinitionSchema.parse(wf([code('a', 'return 1', { retry: { count: 3 } })]))
      .blocks[0]!
    expect(resolveBlockSettings(block)).toEqual({
      timeoutMs: 10_000,
      retry: { count: 3, intervalMs: 1000, exponential: false, coefficient: 2, maxIntervalMs: 60_000 },
      finally: 'stop',
    })
  })
})
