import { describe, expect, it } from 'vitest'
import { cellText, childSummary, expandablePaths, pathExpression, shapeOf, typeLabel } from './result-model'

describe('shapeOf', () => {
  it('makes a table of an array of objects, columns in first-seen order', () => {
    const shape = shapeOf([
      { id: 1, name: 'a' },
      { id: 2, price: 3 },
    ])
    expect(shape).toMatchObject({ kind: 'table', columns: ['id', 'name', 'price'] })
  })

  it('lists arrays of scalars, mixed arrays and empty arrays', () => {
    expect(shapeOf(['a', 'b']).kind).toBe('list')
    expect(shapeOf([{ a: 1 }, 2]).kind).toBe('list')
    expect(shapeOf([]).kind).toBe('list')
  })

  it('shows an object as key/value rows and anything else as a value', () => {
    expect(shapeOf({ waitTimeMs: 10 })).toEqual({ kind: 'object', entries: [['waitTimeMs', 10]] })
    expect(shapeOf(null)).toEqual({ kind: 'scalar', value: null })
  })
})

describe('labels', () => {
  it('names the type with an array length', () => {
    expect(typeLabel([1, 2])).toBe('array (2)')
    expect(typeLabel({})).toBe('object')
    expect(typeLabel(null)).toBe('null')
  })

  it('summarizes children', () => {
    expect(childSummary([1])).toBe('[] 1 item')
    expect(childSummary({ a: 1, b: 2 })).toBe('{} 2 keys')
    expect(childSummary('x')).toBeNull()
  })

  it('keeps cells short, strings unquoted', () => {
    expect(cellText('abc')).toBe('abc')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText('x'.repeat(10), 4)).toBe('xxxx…')
  })
})

describe('paths', () => {
  it('writes the expression that reads a node', () => {
    expect(pathExpression('query1.data', [0, 'name'])).toBe('query1.data[0].name')
    expect(pathExpression('x', ['first name'])).toBe('x["first name"]')
    // A block's inputs, by block name.
    expect(pathExpression('', ['code1', 0, 'id'])).toBe('code1.data[0].id')
  })

  it('lists expandable nodes, capped', () => {
    expect(expandablePaths({ a: [1, { b: 2 }] })).toEqual(['[]', '["a"]', '["a",1]'])
    expect(expandablePaths([[], [], []], 2)).toHaveLength(2)
  })
})
