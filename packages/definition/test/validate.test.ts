import { postgresConnector, restConnector } from '@ow/connectors'
import { describe, expect, it } from 'vitest'
import { type Diagnostic, type QueryValidator, validateDefinition } from '../src'
import { code, sql, start, wf } from './helpers'

const codes = (input: unknown) => validateDefinition(input).diagnostics.map((d) => d.code)
const only = (input: unknown) => {
  const { diagnostics } = validateDefinition(input)
  expect(diagnostics).toHaveLength(1)
  return diagnostics[0]!
}

describe('validateDefinition', () => {
  it('accepts a well-formed workflow with no diagnostics', () => {
    const result = validateDefinition(
      wf(
        [
          start,
          sql('getOrders', 'select * from orders where customer_id = {{ startTrigger.data.customerId }}'),
          code('total', 'return _.sumBy(getOrders.data, "amount")'),
          {
            name: 'isBig',
            type: 'branch',
            config: { conditions: [{ id: 'big', expression: 'total.data > 100' }] },
          },
          {
            name: 'reply',
            type: 'response',
            config: { status: '200', body: '{"total": {{ total.data }}, "big": {{ isBig.data }}}' },
          },
        ],
        [
          ['startTrigger', 'getOrders'],
          ['getOrders', 'total'],
          ['total', 'isBig'],
          ['isBig', 'reply', 'cond:big'],
          ['isBig', 'reply', 'else'],
        ],
      ),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.definition?.blocks).toHaveLength(5)
  })

  it('reports schema problems alone, with the path and block name', () => {
    const result = validateDefinition(wf([start, { name: 'q', type: 'code', config: {} }], [['x', 'y']]))
    expect(result.ok).toBe(false)
    expect(result.definition).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'schema', path: ['blocks', 1, 'config', 'code'], block: 'q' }),
    ])
  })

  describe('names', () => {
    it('rejects keywords and names that would shadow globals', () => {
      expect(codes(wf([start, code('return')]))).toContain('invalid_name')
      for (const name of ['_', 'dayjs', 'Math', 'configVars', 'undefined']) {
        const d = validateDefinition(wf([start, code(name)], [['startTrigger', name]])).diagnostics
        expect(
          d.map((x) => x.code),
          name,
        ).toContain('invalid_name')
      }
    })

    it('rejects duplicate names', () => {
      const d = only(wf([start, code('a'), code('a')], [['startTrigger', 'a']]))
      expect(d).toMatchObject({ code: 'duplicate_name', path: ['blocks', 2, 'name'], block: 'a' })
    })

    it('rejects duplicate branch condition ids', () => {
      const branch = {
        name: 'b',
        type: 'branch',
        config: {
          conditions: [
            { id: 'x', expression: 'true' },
            { id: 'x', expression: 'false' },
          ],
        },
      }
      expect(only(wf([start, branch], [['startTrigger', 'b']]))).toMatchObject({
        code: 'duplicate_condition',
        path: ['blocks', 1, 'config', 'conditions', 1, 'id'],
      })
    })
  })

  describe('start trigger', () => {
    it('needs exactly one', () => {
      expect(codes(wf([code('a')]))).toEqual(['start_trigger'])
      const two = validateDefinition(wf([start, { ...start, name: 'other' }]))
      expect(two.diagnostics).toEqual([expect.objectContaining({ code: 'start_trigger', block: 'other' })])
    })

    it("can't have incoming edges", () => {
      const d = validateDefinition(
        wf(
          [start, code('a')],
          [
            ['startTrigger', 'a'],
            ['a', 'startTrigger'],
          ],
        ),
      ).diagnostics.map((x) => x.code)
      expect(d).toContain('edge_into_start')
      expect(d).toContain('cycle')
    })
  })

  describe('edges', () => {
    it('must name existing blocks', () => {
      expect(only(wf([start], [['startTrigger', 'ghost']]))).toMatchObject({
        code: 'unknown_block',
        path: ['edges', 0, 'to'],
        message: 'No block is named "ghost"',
      })
    })

    it('must use a port the source block has', () => {
      const d = only(
        wf(
          [start, code('a'), code('b')],
          [
            ['startTrigger', 'a'],
            ['a', 'b', 'error'],
          ],
        ),
      )
      expect(d).toMatchObject({ code: 'invalid_port', block: 'a', path: ['edges', 1, 'port'] })
      expect(d.hint).toMatch(/finally: continue/)

      const ok = wf(
        [start, code('a', 'return 1', { finally: 'continue' }), code('b')],
        [
          ['startTrigger', 'a'],
          ['a', 'b', 'error'],
        ],
      )
      expect(codes(ok)).toEqual([])
    })

    it('checks branch ports against the condition ids', () => {
      const branch = {
        name: 'b',
        type: 'branch',
        config: { conditions: [{ id: 'yes', expression: 'true' }] },
      }
      const d = codes(
        wf(
          [start, branch, code('c')],
          [
            ['startTrigger', 'b'],
            ['b', 'c', 'cond:no'],
            ['b', 'c', 'out'],
          ],
        ),
      )
      expect(d).toEqual(['invalid_port', 'invalid_port'])
    })

    it('rejects duplicate edges', () => {
      expect(
        only(
          wf(
            [start, code('a')],
            [
              ['startTrigger', 'a'],
              ['startTrigger', 'a'],
            ],
          ),
        ),
      ).toMatchObject({ code: 'duplicate_edge', path: ['edges', 1] })
    })
  })

  describe('graph shape', () => {
    it('rejects cycles, naming the loop', () => {
      const d = only(
        wf(
          [start, code('a'), code('b')],
          [
            ['startTrigger', 'a'],
            ['a', 'b'],
            ['b', 'a'],
          ],
        ),
      )
      expect(d).toMatchObject({ code: 'cycle', message: "Blocks can't form a loop: a → b → a" })
    })

    it('warns about blocks the start trigger never reaches, without failing', () => {
      const result = validateDefinition(wf([start, code('a'), code('orphan')], [['startTrigger', 'a']]))
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ severity: 'warning', code: 'unreachable', block: 'orphan' }),
      ])
    })
  })

  describe('references', () => {
    // startTrigger → a → b, startTrigger → c (a sibling branch).
    const graph = (blocks: object[]) =>
      wf(
        [start, ...blocks],
        [
          ['startTrigger', 'a'],
          ['a', 'b'],
          ['startTrigger', 'c'],
        ],
      )

    it('allows ancestors, globals and declared locals', () => {
      const body = [
        'const rows = a.data.map((r) => ({ ...r, at: dayjs().toISOString() }))',
        'console.log(JSON.stringify(configVars), workflowContext, idempotencyKey)',
        'return _.uniq(rows).length + startTrigger.data.n + Math.max(1, 2)',
      ].join('\n')
      expect(codes(graph([code('a'), code('b', body), code('c')]))).toEqual([])
    })

    it('rejects a block that runs downstream or on another path, with the exact source range', () => {
      const result = validateDefinition(
        graph([code('a', 'return b.data'), code('b'), code('c', 'return a.data')]),
      )
      expect(result.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'not_ancestor',
          message: '"b" doesn\'t run before "a"',
          hint: 'Connect "b" upstream of "a" to use its result',
          path: ['blocks', 1, 'config', 'code'],
          block: 'a',
          start: 7,
          end: 8,
        },
        expect.objectContaining({ code: 'not_ancestor', block: 'c', message: '"a" doesn\'t run before "c"' }),
      ])
    })

    it('rejects reading itself', () => {
      expect(only(graph([code('a', 'return a.data'), code('b'), code('c')]))).toMatchObject({
        code: 'self_reference',
      })
    })

    it('rejects unknown names, including host APIs the sandbox lacks', () => {
      const result = validateDefinition(
        graph([code('a', 'setTimeout(f, 1); return query9.data'), code('b'), code('c')]),
      )
      expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
        ['unknown_identifier', '"setTimeout" is not defined'],
        ['unknown_identifier', '"f" is not defined'],
        ['unknown_identifier', '"query9" is not defined'],
      ])
    })

    it('respects shadowing in code blocks', () => {
      expect(
        codes(graph([code('a'), code('b'), code('c', 'const b = 1; return [b].map((a) => a)')])),
      ).toEqual([])
    })

    it('finds references inside templates with offsets into the field', () => {
      const d = only(graph([code('a'), code('b'), sql('c', 'select {{ b.data }}')]))
      expect(d).toMatchObject({
        code: 'not_ancestor',
        path: ['blocks', 3, 'config', 'query', 'sql'],
        start: 10,
        end: 11,
      })
    })

    it('walks every string of a connector-specific query', () => {
      const rest = {
        name: 'c',
        type: 'resourceQuery',
        config: {
          resource: 'crm',
          query: { method: 'POST', path: '/x/{{ a.data }}', headers: [{ key: 'X', value: '{{ b.data }}' }] },
        },
      }
      const d = validateDefinition(graph([code('a'), code('b'), rest])).diagnostics
      expect(d.map((x) => x.path)).toEqual([
        ['blocks', 3, 'config', 'query', 'headers', 0, 'value'],
        ['blocks', 3, 'config', 'query', 'path'],
      ])
    })

    it('gives filter conditions value and index', () => {
      const filter = {
        name: 'c',
        type: 'filter',
        config: { input: '{{ startTrigger.data }}', condition: 'value.ok && index < 10' },
      }
      expect(codes(graph([code('a'), code('b'), filter]))).toEqual([])
    })

    it('checks branch conditions and response fields', () => {
      const branch = {
        name: 'c',
        type: 'branch',
        config: { conditions: [{ id: 'x', expression: 'b.data' }] },
      }
      const response = {
        name: 'c',
        type: 'response',
        config: {
          status: '{{ b.data }}',
          headers: [{ key: 'X', value: '{{ b.data }}' }],
          body: '{{ b.data }}',
        },
      }
      expect(codes(graph([code('a'), code('b'), branch]))).toEqual(['not_ancestor'])
      expect(codes(graph([code('a'), code('b'), response]))).toEqual([
        'not_ancestor',
        'not_ancestor',
        'not_ancestor',
      ])
    })

    it('reports syntax errors at their position', () => {
      const [bad] = validateDefinition(
        graph([code('a'), code('b'), sql('c', 'select {{ a.data + }}')]),
      ).diagnostics
      expect(bad).toMatchObject({ code: 'syntax', path: ['blocks', 3, 'config', 'query', 'sql'] })
      expect(bad!.start).toBeGreaterThanOrEqual(9)

      expect(codes(graph([code('a'), code('b'), sql('c', 'select {{ a.data')]))).toEqual(['syntax'])
      expect(codes(graph([code('a', 'return 1 })( {'), code('b'), code('c')]))).toEqual(['syntax'])
    })
  })

  describe('queries against connectors', () => {
    const resources: Record<string, QueryValidator> = { warehouse: postgresConnector, crm: restConnector }
    const resolveResource = (slug: string) => resources[slug]
    const check = (block: { name: string; [key: string]: unknown }) =>
      validateDefinition(wf([start, block], [['startTrigger', block.name]]), { resolveResource }).diagnostics

    it('passes valid queries', () => {
      expect(check(sql('q', 'select {{ startTrigger.data.id }}'))).toEqual([])
    })

    it('rejects an unknown resource', () => {
      expect(check(sql('q', 'select 1', 'nope'))).toEqual([
        expect.objectContaining({ code: 'unknown_resource', path: ['blocks', 1, 'config', 'resource'] }),
      ])
    })

    it("rejects a query that doesn't match the connector's schema", () => {
      const d = check({
        name: 'q',
        type: 'resourceQuery',
        config: { resource: 'warehouse', query: { sq: 'x' } },
      })
      expect(d.map((x: Diagnostic) => x.code)).toEqual(['invalid_query'])
      expect(d[0]!.path).toEqual(['blocks', 1, 'config', 'query', 'sql'])
    })

    it("surfaces the connector's own checks, with its fix-it hint", () => {
      const [d] = check(sql('q', "select * from t where name = '{{ startTrigger.data.name }}'"))
      expect(d).toMatchObject({ code: 'invalid_query', block: 'q' })
      expect(d!.hint).toBeTruthy()
    })

    it('skips connector checks when no resolver is given (the browser)', () => {
      expect(codes(wf([start, sql('q', 'select 1', 'nope')], [['startTrigger', 'q']]))).toEqual([])
    })
  })
})
