import { type Block, blockSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import { switchBlock, switchTarget } from './switch-block'

const singles: Block[] = [
  {
    name: 'py',
    type: 'code',
    description: 'Doubles',
    config: { code: 'return 2', language: 'python' },
    settings: { timeoutMs: 5000, retry: { count: 2, intervalMs: 100 } },
  },
  { name: 'q', type: 'resourceQuery', config: { resource: 'shop_db', query: { sql: 'select 1' } } },
  {
    name: 'lib',
    type: 'libraryQuery',
    config: { library: 'tens', version: 'latest', params: { n: '{{ 1 }}' } },
  },
  { name: 'call', type: 'function', config: { function: 'double', params: { n: '{{ 2 }}' } } },
  { name: 'child', type: 'workflow', config: { workflow: 'sync-orders', input: '{{ {} }}', mode: 'async' } },
]

describe('switchBlock', () => {
  it.each(singles.map((b) => [b.type, b]))('turns a %s block into a loop and back, unchanged', (_, block) => {
    const loop = switchBlock(block)!
    expect(loop.type).toBe('loop')
    expect(blockSchema.safeParse(loop).success).toBe(true)
    expect(switchBlock(loop)).toEqual(block)
  })

  it("moves the retry into the loop's per-item settings", () => {
    const loop = switchBlock(singles[0]!)!
    expect(loop).toMatchObject({
      name: 'py',
      description: 'Doubles',
      settings: { timeoutMs: 5000 },
      config: {
        input: '{{ [] }}',
        runner: { kind: 'code', language: 'python' },
        iteration: { retry: { count: 2 } },
      },
    })
    expect(loop.type === 'loop' && 'retry' in (loop.settings ?? {})).toBe(false)
  })

  it('names what a block switches to, and nothing where the config would not carry over', () => {
    expect(switchTarget(singles[1]!)).toEqual({ to: 'loop', label: 'Switch to a loop' })
    expect(switchTarget(switchBlock(singles[1]!)!)?.label).toBe('Switch to a resource query')
    const filter: Block = { name: 'f', type: 'filter', config: { input: '{{ [] }}', condition: 'true' } }
    expect(switchTarget(filter)).toBeNull()
    expect(switchBlock(filter)).toBeNull()
  })
})
