import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { draftSchema } from './schema-draft'
import { schemaType, scopeDeclarations } from './scope-types'

/** The type parses as TypeScript (a broken one would break every completion in the field). */
function parses(type: string) {
  const file = ts.createSourceFile('t.ts', `type T = ${type}`, ts.ScriptTarget.Latest)
  return (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0
}

describe('schemaType', () => {
  it('types objects with required and optional properties, descriptions and other keys', () => {
    const type = schemaType({
      type: 'object',
      properties: {
        orderId: { type: 'integer', description: "The shop's order number */ not code" },
        'customer-email': { type: 'string', format: 'email' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            required: ['sku'],
            additionalProperties: false,
          },
        },
      },
      required: ['orderId'],
    })
    expect(type).toBe(
      '{ /** The shop\'s order number * / not code */ orderId: number; "customer-email"?: string; lines?: { sku: string }[]; [key: string]: unknown }',
    )
    expect(parses(type)).toBe(true)
  })

  it('types enums, consts, unions, intersections, tuples, nullable and maps', () => {
    const cases: [object, string][] = [
      [{ enum: ['paid', 'open', 3, null] }, '"paid" | "open" | 3 | null'],
      [{ const: true }, 'true'],
      [{ type: ['string', 'null'] }, 'string | null'],
      [{ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] }, 'string | number[]'],
      [{ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, '(string | number)[]'],
      [
        {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'number' } } },
          ],
        },
        '{ a?: string; [key: string]: unknown } & { b?: number; [key: string]: unknown }',
      ],
      [{ type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }, '[string, number]'],
      [{ type: 'object', additionalProperties: { type: 'boolean' } }, 'Record<string, boolean>'],
      [{ type: 'object' }, 'Record<string, unknown>'],
      [{}, 'unknown'],
      [{ properties: { x: { type: 'string' } } }, '{ x?: string; [key: string]: unknown }'],
    ]
    for (const [schema, expected] of cases) {
      const type = schemaType(schema)
      expect(type, JSON.stringify(schema)).toBe(expected)
      expect(parses(type), type).toBe(true)
    }
  })

  it('follows local $refs, and stops at remote ones and at cycles', () => {
    const schema = {
      type: 'object',
      properties: {
        line: { $ref: '#/$defs/line' },
        remote: { $ref: 'https://example.com/x.json' },
        tree: { $ref: '#' },
      },
      $defs: { line: { type: 'object', properties: { qty: { type: 'integer' } } } },
    }
    const type = schemaType(schema)
    expect(type).toContain('line?: { qty?: number; [key: string]: unknown }')
    expect(type).toContain('remote?: unknown')
    expect(parses(type)).toBe(true)
  })
})

describe('scopeDeclarations', () => {
  it('types startTrigger.data from the body schema, over a run sample', () => {
    const blocks = [{ name: 'startTrigger', type: 'startTrigger' }] as never
    const samples = { startTrigger: { data: { other: 1 }, status: 'succeeded' } }
    const schema = { type: 'object', properties: { orderId: { type: 'integer' } }, required: ['orderId'] }
    expect(scopeDeclarations(blocks, samples, [], undefined, schema).dts).toContain(
      'declare const startTrigger: { data: { orderId: number; [key: string]: unknown };',
    )
    expect(scopeDeclarations(blocks, samples).dts).toContain(
      'declare const startTrigger: { data: { other: number };',
    )
  })
})

describe('draftSchema', () => {
  it('drafts a schema from a sample body', () => {
    expect(
      draftSchema({
        orderId: 7,
        total: 12.5,
        paid: false,
        note: null,
        customer: { email: 'a@optiply.nl' },
        lines: [
          { sku: 'A', qty: 1 },
          { sku: 'B', qty: 2.5, gift: true },
        ],
        tags: [],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        orderId: { type: 'integer' },
        total: { type: 'number' },
        paid: { type: 'boolean' },
        note: { type: 'null' },
        customer: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sku: { type: 'string' }, qty: { type: 'number' }, gift: { type: 'boolean' } },
            required: ['sku', 'qty'],
          },
        },
        tags: { type: 'array' },
      },
      required: ['orderId', 'total', 'paid', 'note', 'customer', 'lines', 'tags'],
    })
  })

  it('makes mixed array items an anyOf, and drafts top-level arrays and scalars', () => {
    expect(draftSchema([1, 'a', 2])).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
    })
    expect(draftSchema('text')).toEqual({ type: 'string' })
  })

  it('drafts schemas whose type matches the sample', () => {
    const sample = { a: [{ b: 1 }, { b: 2, c: 'x' }], d: { e: [true] } }
    expect(schemaType(draftSchema(sample))).toBe(
      '{ a: { b: number; c?: string; [key: string]: unknown }[]; d: { e: boolean[]; [key: string]: unknown }; [key: string]: unknown }',
    )
  })
})
