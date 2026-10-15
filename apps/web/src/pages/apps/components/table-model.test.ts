import { describe, expect, it } from 'vitest'
import { applyEdit, formatCell, parseCell, rowKey, sortedRows, tableColumns } from './table-model'

const rows = [
  { id: 1, name: 'Ada', score: 10, active: true, born: '1815-12-10', meta: { a: 1 } },
  { id: 2, name: 'grace', score: null, active: false, born: '1906-12-09', meta: null },
  { id: 3, name: 'Alan', score: 2, active: true, born: null, meta: null },
]

describe('table model', () => {
  it('infers columns from the data, or takes the configured ones', () => {
    expect(tableColumns([], rows).map((c) => [c.key, c.type])).toEqual([
      ['id', 'number'],
      ['name', 'text'],
      ['score', 'number'],
      ['active', 'boolean'],
      ['born', 'date'],
      ['meta', 'json'],
    ])
    expect(
      tableColumns(
        [
          'name',
          { key: 'score', label: 'Score', editable: true, width: 90 },
          { key: 'id', hidden: true },
          { label: 'no key' },
        ],
        rows,
      ),
    ).toEqual([
      { key: 'name', label: 'name', type: 'text', editable: false, width: null },
      { key: 'score', label: 'Score', type: 'number', editable: true, width: 90 },
    ])
  })

  it('sorts with empty values last, keeping data order for ties', () => {
    expect(sortedRows(rows, { key: 'score', desc: false }).map((r) => r.index)).toEqual([2, 0, 1])
    expect(sortedRows(rows, { key: 'score', desc: true }).map((r) => r.index)).toEqual([0, 2, 1])
    // Case-insensitive, as people read names.
    expect(sortedRows(rows, { key: 'name', desc: false }).map((r) => r.row.name)).toEqual([
      'Ada',
      'Alan',
      'grace',
    ])
    expect(sortedRows(rows, null).map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('collects edits per row by primary key, dropping what goes back to the original', () => {
    let changes = applyEdit([], 'id', rows[0]!, 'name', 'Ada Lovelace')
    changes = applyEdit(changes, 'id', rows[1]!, 'score', 7)
    changes = applyEdit(changes, 'id', rows[0]!, 'score', 11)
    expect(changes).toEqual([
      { id: 2, score: 7 },
      { id: 1, name: 'Ada Lovelace', score: 11 },
    ])
    changes = applyEdit(changes, 'id', rows[1]!, 'score', null)
    expect(changes).toEqual([{ id: 1, name: 'Ada Lovelace', score: 11 }])
    // The key itself, and rows without one, can't be edited.
    expect(applyEdit(changes, 'id', rows[0]!, 'id', 9)).toBe(changes)
    expect(applyEdit([], 'id', { name: 'x' }, 'name', 'y')).toEqual([])
    expect(rowKey(rows[0], 'id', 0)).toBe('1')
    expect(rowKey({ name: 'x' }, 'id', 4)).toBe('#4')
  })

  it('parses and formats cells by type', () => {
    expect(parseCell('12,5', 'number')).toEqual({ value: 12.5 })
    expect(parseCell('abc', 'number')).toEqual({ error: 'Expected a number' })
    expect(parseCell('yes', 'boolean')).toEqual({ value: true })
    expect(parseCell('2026-10-15', 'date')).toEqual({ value: '2026-10-15' })
    expect(parseCell('15-10-2026', 'date')).toMatchObject({ error: expect.any(String) })
    expect(parseCell('{"a":1}', 'json')).toEqual({ value: { a: 1 } })
    expect(parseCell('  ', 'text')).toEqual({ value: null })
    expect(parseCell(' kept ', 'text')).toEqual({ value: ' kept ' })
    expect(formatCell({ a: 1 }, 'json')).toBe('{"a":1}')
    expect(formatCell(null, 'text')).toBe('')
  })
})
