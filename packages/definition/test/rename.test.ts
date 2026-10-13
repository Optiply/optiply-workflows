import { describe, expect, it } from 'vitest'
import { renameBlock, validateDefinition, type WorkflowDefinition, workflowDefinitionSchema } from '../src'
import { code, sql, start, wf } from './helpers'

const parse = (input: unknown) => workflowDefinitionSchema.parse(input)
const blockOf = (def: WorkflowDefinition, name: string) => def.blocks.find((b) => b.name === name)!
const renamed = (def: WorkflowDefinition, from: string, to: string) => {
  const result = renameBlock(def, from, to)
  if (!result.ok) throw new Error(result.error)
  return result
}

describe('renameBlock', () => {
  const def = parse(
    wf(
      [
        start,
        sql('orders', 'select * from orders where customer = {{ startTrigger.data.id }}'),
        code(
          'total',
          [
            '// orders is fetched upstream',
            'const label = "orders"',
            'const count = orders.data.length',
            'return { orders, count, sum: _.sumBy(orders.data, "amount"), raw: obj.orders }',
          ].join('\n'),
        ),
        {
          name: 'check',
          type: 'branch',
          config: { conditions: [{ id: 'some', expression: 'orders.data.length > 0' }] },
        },
        {
          name: 'reply',
          type: 'response',
          config: {
            status: '200',
            body: '{"n": {{ orders.data.length }}, "first": "{{ orders.data[0].id }}"}',
          },
        },
      ],
      [
        ['startTrigger', 'orders'],
        ['orders', 'total'],
        ['orders', 'check'],
        ['check', 'reply', 'cond:some'],
      ],
      { layout: { blocks: { orders: { x: 1, y: 2 }, total: { x: 3, y: 4 } } } },
    ),
  )

  it('renames the block, its references, edges and layout', () => {
    const { definition, changed, skipped } = renamed(def, 'orders', 'customerOrders')
    expect(blockOf(definition, 'customerOrders').type).toBe('resourceQuery')
    expect(definition.blocks.some((b) => b.name === 'orders')).toBe(false)

    const total = blockOf(definition, 'total')
    expect(total.type === 'code' && total.config.code).toBe(
      [
        '// orders is fetched upstream',
        'const label = "orders"',
        'const count = customerOrders.data.length',
        'return { orders: customerOrders, count, sum: _.sumBy(customerOrders.data, "amount"), raw: obj.orders }',
      ].join('\n'),
    )
    const check = blockOf(definition, 'check')
    expect(check.type === 'branch' && check.config.conditions[0]!.expression).toBe(
      'customerOrders.data.length > 0',
    )
    const reply = blockOf(definition, 'reply')
    expect(reply.type === 'response' && reply.config.body).toBe(
      '{"n": {{ customerOrders.data.length }}, "first": "{{ customerOrders.data[0].id }}"}',
    )

    expect(
      definition.edges.filter((e) => e.from === 'customerOrders' || e.to === 'customerOrders'),
    ).toHaveLength(3)
    expect(definition.layout!.blocks).toEqual({ customerOrders: { x: 1, y: 2 }, total: { x: 3, y: 4 } })
    expect(changed.map((c) => c.block)).toEqual(['total', 'check', 'reply'])
    expect(skipped).toEqual([])
    // The result is exactly as valid as the original (only `obj`, deliberately undefined, is reported).
    const summary = (d: WorkflowDefinition) =>
      validateDefinition(d).diagnostics.map((x) => [x.code, x.block, x.message])
    expect(summary(definition)).toEqual(summary(def))
    expect(summary(def)).toEqual([['unknown_identifier', 'total', '"obj" is not defined']])
  })

  it('leaves the original definition untouched', () => {
    const before = JSON.stringify(def)
    renamed(def, 'orders', 'other')
    expect(JSON.stringify(def)).toBe(before)
  })

  it('rewrites templates inside resource queries', () => {
    const { definition } = renamed(def, 'startTrigger', 'trigger')
    const orders = blockOf(definition, 'orders')
    expect(orders.type === 'resourceQuery' && orders.config.query.sql).toBe(
      'select * from orders where customer = {{ trigger.data.id }}',
    )
  })

  it('refuses invalid, reserved and taken names', () => {
    expect(renameBlock(def, 'orders', '1st')).toMatchObject({ ok: false })
    expect(renameBlock(def, 'orders', 'dayjs')).toEqual({
      ok: false,
      error: '"dayjs" is already a global available to expressions',
    })
    expect(renameBlock(def, 'orders', 'total')).toEqual({
      ok: false,
      error: 'Another block is already named "total"',
    })
    expect(renameBlock(def, 'nope', 'x')).toEqual({ ok: false, error: 'No block is named "nope"' })
  })

  it('refuses a name that a local variable would capture', () => {
    expect(renameBlock(def, 'orders', 'count')).toEqual({
      ok: false,
      error: '"count" is already a variable in block "total"; pick another name',
    })
  })

  it('renames what it can in a field with a syntax error, and reports the field', () => {
    const broken = parse(
      wf(
        [
          start,
          code('a'),
          { name: 'r', type: 'response', config: { body: '{"x": {{ a.data }}, "y": {{ a.data + }}}' } },
        ],
        [
          ['startTrigger', 'a'],
          ['a', 'r'],
        ],
      ),
    )
    const { definition, skipped } = renamed(broken, 'a', 'b')
    const r = blockOf(definition, 'r')
    expect(r.type === 'response' && r.config.body).toBe('{"x": {{ b.data }}, "y": {{ a.data + }}}')
    expect(skipped).toEqual([{ block: 'r', path: ['config', 'body'] }])
  })
})
