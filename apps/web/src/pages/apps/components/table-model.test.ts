import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  formatCell,
  parseCell,
  rowKey,
  selectionKey,
  sortedRows,
  tableColumns,
  tableView,
} from './table-model'

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
          { key: 'double', value: '{{ currentRow.score * 2 }}', editable: true, type: 'number' },
        ],
        rows,
      ),
    ).toEqual([
      { key: 'name', label: 'name', type: 'text', editable: false, width: null, computed: false },
      { key: 'score', label: 'Score', type: 'number', editable: true, width: 90, computed: false },
      // A computed column (M24) isn't editable, whatever it says.
      { key: 'double', label: 'double', type: 'number', editable: false, width: null, computed: true },
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
    // Selection matches a row the same way from the data and from selectedRows: by key, or by content without one.
    expect(selectionKey(rows[0], 'id')).toBe('1')
    expect(selectionKey({ name: 'x' }, 'id')).toBe(selectionKey({ name: 'x' }, 'id'))
    expect(selectionKey({ name: 'x' }, 'id')).not.toBe(selectionKey({ name: 'y' }, 'id'))
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

describe('table view', () => {
  const people = Array.from({ length: 23 }, (_, i) => ({
    id: i + 1,
    name: i === 4 ? 'José Gómez' : `person ${i + 1}`,
  }))
  const columns = tableColumns([], people)
  const view = (o: Partial<Parameters<typeof tableView>[0]>) =>
    tableView({
      rows: people,
      columns,
      paging: 'scroll',
      page: 0,
      pageSize: 10,
      sort: null,
      searchText: '',
      totalRowCount: null,
      ...o,
    })
  const ids = (v: ReturnType<typeof tableView>) => v.rows.map((r) => r.row.id)

  it('scroll shows every row', () => {
    expect(view({}).rows).toHaveLength(23)
    expect(view({}).pageCount).toBe(1)
  })

  it('pages slice the sorted, searched rows, keeping positions in the data', () => {
    const second = view({ paging: 'pages', page: 1 })
    expect(ids(second)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(second.rows[0]!.index).toBe(10)
    expect(second).toMatchObject({ total: 23, page: 1, pageCount: 3 })
    expect(ids(view({ paging: 'pages', page: 2 }))).toEqual([21, 22, 23])
    // Past the last page: the last one.
    expect(view({ paging: 'pages', page: 9 })).toMatchObject({ page: 2, pageCount: 3 })
    const desc = view({ paging: 'pages', sort: { key: 'id', desc: true } })
    expect(ids(desc).slice(0, 3)).toEqual([23, 22, 21])
    expect(desc.rows[0]!.index).toBe(22)
  })

  it('search ignores case and accents, in the shown columns only', () => {
    expect(ids(view({ searchText: 'GOMEZ' }))).toEqual([5])
    expect(view({ searchText: 'jose' }).rows[0]!.index).toBe(4)
    const two = view({ paging: 'pages', searchText: 'person 2' })
    expect(ids(two)).toEqual([2, 20, 21, 22, 23])
    expect(two).toMatchObject({ total: 5, pageCount: 1 })
    const nameOnly = tableColumns(['name'], people)
    expect(ids(view({ columns: nameOnly, searchText: '7' }))).toEqual([7, 17])
    expect(view({ searchText: 'nobody' })).toMatchObject({ rows: [], total: 0 })
  })

  it('duplicate rows keep their own positions', () => {
    const row = { id: 1 }
    const v = tableView({
      rows: [row, row, { id: 2 }],
      columns: tableColumns([], [row]),
      paging: 'pages',
      page: 0,
      pageSize: 10,
      sort: { key: 'id', desc: true },
      searchText: '1',
      totalRowCount: null,
    })
    expect(v.rows.map((r) => r.index)).toEqual([0, 1])
  })

  it('an odd page size means 50 rows, as for the pagination the query reads', () => {
    for (const pageSize of [-5, 0, 0.5, Number.NaN]) {
      expect(view({ paging: 'pages', pageSize })).toMatchObject({ pageCount: 1, total: 23 })
    }
    expect(view({ paging: 'server', pageSize: -5, totalRowCount: 120 }).pageCount).toBe(3)
  })

  it('server paging shows the data as it came', () => {
    const server = view({ paging: 'server', page: 4, searchText: 'nobody', sort: { key: 'id', desc: true } })
    expect(ids(server)).toEqual(people.map((p) => p.id))
    expect(server).toMatchObject({ page: 4, total: null, pageCount: null })
    expect(view({ paging: 'server', totalRowCount: 95 })).toMatchObject({ total: 95, pageCount: 10 })
    expect(view({ paging: 'server', totalRowCount: 0 })).toMatchObject({ total: 0, pageCount: 1 })
  })
})
