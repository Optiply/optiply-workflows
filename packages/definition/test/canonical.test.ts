import { describe, expect, it } from 'vitest'
import { canonicalize, canonicalJson, definitionHash, workflowDefinitionSchema } from '../src'
import { code, start, wf } from './helpers'

const parse = (input: unknown) => workflowDefinitionSchema.parse(input)

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}',
    )
  })

  it('sorts integer-like keys as strings, unlike JSON.stringify', () => {
    expect(canonicalJson({ 10: 'a', 9: 'b', x: 'c' })).toBe('{"10":"a","9":"b","x":"c"}')
  })

  it('writes undefined array items as null, like JSON', () => {
    expect(canonicalJson([1, undefined])).toBe('[1,null]')
  })

  it('has a pretty form for Git', () => {
    expect(canonicalJson({ b: [1, {}], a: [] }, { pretty: true })).toBe(
      '{\n  "a": [],\n  "b": [\n    1,\n    {}\n  ]\n}\n',
    )
  })

  it('refuses values JSON would silently change', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/Date/)
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError)
  })
})

describe('canonicalize and definitionHash', () => {
  const base = wf(
    [start, code('b'), code('a')],
    [
      ['startTrigger', 'b'],
      ['startTrigger', 'a'],
    ],
    { layout: { blocks: { a: { x: 0, y: 0 } } } },
  )

  it('sorts blocks by name and edges by from, port, to', () => {
    const c = canonicalize(parse(base))
    expect(c.blocks.map((b) => b.name)).toEqual(['a', 'b', 'startTrigger'])
    expect(c.edges.map((e) => e.to)).toEqual(['a', 'b'])
  })

  it('keeps branch condition order, which decides which edge fires', () => {
    const branch = {
      name: 'x',
      type: 'branch',
      config: {
        conditions: [
          { id: 'z', expression: 'true' },
          { id: 'a', expression: 'true' },
        ],
      },
    }
    const c = canonicalize(parse(wf([start, branch])))
    const kept = c.blocks.find((b) => b.name === 'x')
    expect(kept?.type === 'branch' && kept.config.conditions.map((x) => x.id)).toEqual(['z', 'a'])
  })

  it("doesn't change with block, edge or key order, or with layout", async () => {
    const hash = await definitionHash(parse(base))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const reordered = {
      layout: { blocks: { b: { x: 5, y: 5 } } },
      edges: [...base.edges].reverse(),
      blocks: [...base.blocks].reverse().map((b) => Object.fromEntries(Object.entries(b).reverse())),
      schemaVersion: 1,
    }
    expect(await definitionHash(parse(reordered))).toBe(hash)
  })

  it('changes when the logic changes', async () => {
    const hash = await definitionHash(parse(base))
    const edited = { ...base, blocks: [start, code('b', 'return 2'), code('a')] }
    expect(await definitionHash(parse(edited))).not.toBe(hash)
  })
})
