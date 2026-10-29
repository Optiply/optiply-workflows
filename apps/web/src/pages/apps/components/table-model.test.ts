import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  filterLabel,
  filterRows,
  formatCell,
  parseCell,
  rowKey,
  selectionKey,
  sortedRows,
  tableColumns,
  tableView,
  withColumnWidth,
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
          {
            key: 'double',
            value: '{{ currentRow.score * 2 }}',
            editable: true,
            type: 'number',
            filterable: false,
          },
        ],
        rows,
      ),
    ).toEqual([
      {
        key: 'name',
        label: 'name',
        type: 'text',
        editable: false,
        width: null,
        computed: false,
        filterable: true,
      },
      {
        key: 'score',
        label: 'Score',
        type: 'number',
        editable: true,
        width: 90,
        computed: false,
        filterable: true,
      },
      // A computed column (M24) isn't editable, whatever it says.
      {
        key: 'double',
        label: 'double',
        type: 'number',
        editable: false,
        width: null,
        computed: true,
        filterable: false,
      },
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

describe('filters (M24)', () => {
  const rows = [
    { id: 1, name: 'Ada', qty: 3, day: '2026-01-05', ok: true },
    { id: 2, name: 'Grace', qty: 10, day: '2026-02-01', ok: false },
    { id: 3, name: 'Gómez', qty: null, day: null, ok: null },
    { id: 4, name: '', qty: 7, day: '2026-01-20', ok: true },
  ]
  const columns = tableColumns([], rows)
  const ids = (filters: Parameters<typeof filterRows>[2]) =>
    filterRows(rows, columns, filters).map((i) => rows[i]!.id)

  it('filters by each operator, the way sql.where has the database do it', () => {
    expect(ids([{ column: 'name', op: 'contains', value: 'GÓ' }])).toEqual([3])
    // As in SQL: contains ignores case but not accents; equals and the order are exact.
    expect(ids([{ column: 'name', op: 'contains', value: 'GO' }])).toEqual([])
    expect(ids([{ column: 'name', op: 'equals', value: 'Ada' }])).toEqual([1])
    expect(ids([{ column: 'name', op: 'equals', value: 'ada' }])).toEqual([])
    expect(ids([{ column: 'name', op: 'lt', value: 'B' }])).toEqual([1, 4])
    expect(ids([{ column: 'name', op: 'empty' }])).toEqual([4])
    expect(ids([{ column: 'qty', op: 'notEquals', value: '3' }])).toEqual([2, 3, 4])
    expect(ids([{ column: 'qty', op: 'gte', value: '7' }])).toEqual([2, 4])
    expect(ids([{ column: 'qty', op: 'lt', value: 7 }])).toEqual([1])
    expect(ids([{ column: 'qty', op: 'between', value: [3, 7] }])).toEqual([1, 4])
    expect(ids([{ column: 'day', op: 'gt', value: '2026-01-10', type: 'date' }])).toEqual([2, 4])
    expect(ids([{ column: 'day', op: 'between', value: ['2026-01-01', '2026-01-31'] }])).toEqual([1, 4])
    expect(ids([{ column: 'ok', op: 'equals', value: true }])).toEqual([1, 4])
    expect(ids([{ column: 'ok', op: 'notEmpty' }])).toEqual([1, 2, 4])
  })

  it('ANDs filters, ignores a column the table lacks, and comes before the search', () => {
    expect(
      ids([
        { column: 'qty', op: 'gt', value: 2 },
        { column: 'day', op: 'lt', value: '2026-01-31' },
        { column: 'gone', op: 'empty' },
      ]),
    ).toEqual([1, 4])
    const view = tableView({
      rows,
      columns,
      paging: 'pages',
      page: 0,
      pageSize: 50,
      sort: { key: 'qty', desc: true },
      searchText: 'a',
      totalRowCount: null,
      filters: [{ column: 'qty', op: 'gte', value: 3 }],
    })
    expect(view.rows.map((r) => r.row.id)).toEqual([2, 1])
    expect(view.total).toBe(2)
    // Server paging: the query filtered.
    expect(
      tableView({
        ...{ rows, columns, page: 0, pageSize: 50, sort: null, searchText: '', totalRowCount: null },
        paging: 'server',
        filters: [{ column: 'qty', op: 'gt', value: 100 }],
      }).rows,
    ).toHaveLength(4)
  })

  it('reads as a chip', () => {
    expect(filterLabel({ column: 'qty', op: 'gte', value: 3, type: 'number' }, 'Qty')).toBe('Qty ≥ 3')
    expect(filterLabel({ column: 'day', op: 'lt', value: '2026-01-01', type: 'date' }, 'day')).toBe(
      'day before 2026-01-01',
    )
    expect(filterLabel({ column: 'n', op: 'between', value: [1, 2], type: 'number' }, 'n')).toBe(
      'n between 1 and 2',
    )
    expect(filterLabel({ column: 'n', op: 'empty' }, 'n')).toBe('n is empty')
  })
})

describe('withColumnWidth (M24)', () => {
  const shown = tableColumns([], [{ id: 1, name: 'a' }])

  it('sets one column’s width in the stored columns, listing inferred ones first', () => {
    expect(withColumnWidth(undefined, shown, 'name', 181.6)).toEqual([
      { key: 'id' },
      { key: 'name', width: 182 },
    ])
    expect(withColumnWidth([], shown, 'id', 10)).toEqual([{ key: 'id', width: 40 }, { key: 'name' }])
    expect(withColumnWidth(['id', { key: 'name', label: 'Name', width: 90 }], shown, 'name', 200)).toEqual([
      'id',
      { key: 'name', label: 'Name', width: 200 },
    ])
    expect(withColumnWidth(['id'], shown, 'id', 120)).toEqual([{ key: 'id', width: 120 }])
  })

  it('leaves columns written as a template alone', () => {
    expect(withColumnWidth('{{ cols.value }}', shown, 'id', 120)).toBeNull()
  })
})
