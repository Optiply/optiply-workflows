import Immutable from 'immutable'
import { describe, expect, it } from 'vitest'
import { decodeTransit, TransitError } from '../src'
import { PluginTemplate, plugin, writer } from './fixtures'

describe('decodeTransit', () => {
  it('reads what transit-immutable-js writes: maps, ordered maps, lists, sets, records and dates', () => {
    const value = Immutable.Map({
      plugins: Immutable.OrderedMap({ table1: plugin('table1', { subtype: 'TableWidget2' }) }),
      list: Immutable.List([1, 2.5, true, null, '~tilde', '^caret', '`tick', new Date(0)]),
      set: Immutable.Set(['s']),
      empty: Immutable.Map(),
    })
    expect(decodeTransit(writer.toJSON(value))).toEqual({
      plugins: {
        table1: expect.objectContaining({
          $record: 'pluginTemplate',
          id: 'table1',
          subtype: 'TableWidget2',
          template: {},
          position2: null,
        }),
      },
      list: [1, 2.5, true, null, '~tilde', '^caret', '`tick', '1970-01-01T00:00:00.000Z'],
      set: ['s'],
      empty: {},
    })
  })

  it('follows cache codes past one character and past the cache wrapping around', () => {
    // 3,000 unique keys fill the 1,936-entry cache, which wraps; 120 repeated ones are referred to by one- and
    // two-character codes (^0…^[, then ^10…), before and after the wrap.
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      [`unique_${i}`]: i,
      [`repeated_${i % 120}`]: `v${i}`,
    }))
    // Plain objects are written as transit maps (`^ `), whose keys are cached; Immutable maps are tagged lists.
    const value = Immutable.Map({
      rows: Immutable.List(rows),
      records: Immutable.List(rows.slice(0, 50).map((_, i) => new PluginTemplate({ id: `p${i}` } as never))),
    })
    const json = writer.toJSON(value)
    expect(json).toMatch(/"\^[0-9:;<=>?@A-Z[]{2}"/) // two-character codes are really there
    const decoded = decodeTransit(json) as { rows: unknown[]; records: { $record: string; id: string }[] }
    expect(decoded.rows).toEqual(rows)
    expect(decoded.records.map((r) => [r.$record, r.id])).toEqual(
      rows.slice(0, 50).map((_, i) => ['pluginTemplate', `p${i}`]),
    )
  })

  it('reads the scalar escapes and the verbose map form', () => {
    expect(decodeTransit('["~#\'", "~_"]')).toBeNull()
    expect(
      decodeTransit(
        '["~?t", "~?f", "~i12", "~d1.5", "~zNaN", "~:kw", "~$sym", "~u1-2", "~rhttp://x", "~m86400000"]',
      ),
    ).toEqual([true, false, 12, 1.5, null, 'kw', 'sym', '1-2', 'http://x', '1970-01-02T00:00:00.000Z'])
    expect(decodeTransit('{"~#iL": [1, 2]}')).toEqual([1, 2])
    expect(decodeTransit('{"a": "~i1", "bcde": ["^ ", "^0", 2]}')).toEqual({ a: 1, bcde: { bcde: 2 } })
  })

  it('keeps an unknown tag with its value, and a two-item list that is not tagged as a list', () => {
    expect(decodeTransit('["~#point", [1, 2]]')).toEqual({ $tag: 'point', value: [1, 2] })
    expect(decodeTransit('["a", "b"]')).toEqual(['a', 'b'])
  })

  it('fails on text that is not JSON and on an unknown cache code', () => {
    expect(() => decodeTransit('{')).toThrow(TransitError)
    expect(() => decodeTransit('["^ ", "^5", 1]')).toThrow('Unknown cache code ^5')
  })
})
