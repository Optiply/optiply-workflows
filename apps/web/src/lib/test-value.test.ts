import { describe, expect, it } from 'vitest'
import { parseTestValue, showTestValue } from './test-value'

describe('test values', () => {
  it('reads JSON, and plain text as a string', () => {
    expect(parseTestValue('42')).toBe(42)
    expect(parseTestValue('"42"')).toBe('42')
    expect(parseTestValue('[1, 2]')).toEqual([1, 2])
    expect(parseTestValue('hello')).toBe('hello')
    expect(parseTestValue(' ')).toBeUndefined()
  })

  it('shows every value so that it reads back the same', () => {
    for (const value of [
      42,
      '42',
      'true',
      'null',
      ' 7',
      'hello',
      '"quoted"',
      [1, 'a'],
      { a: 1 },
      null,
      false,
    ]) {
      expect(parseTestValue(showTestValue(value))).toEqual(value)
    }
    expect(showTestValue('hello')).toBe('hello')
    expect(showTestValue('42')).toBe('"42"')
    expect(showTestValue(undefined)).toBe('')
  })
})
