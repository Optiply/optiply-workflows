// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid on divs, so rows can be virtualized (absolutely positioned)
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid holds focus and points at the active cell (aria-activedescendant)
// biome-ignore-all lint/a11y/useKeyWithClickEvents: rows and cells are clicked; the keyboard works on the grid (arrows, Enter, Space)

import { type TableFilter, tableFilters } from '@ow/app-definition'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ListFilter, Plus, Search, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils'
import { EditorActionsContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppScope, useAppValue } from '../runtime/react'
import {
  applyEdit,
  type ColumnType,
  changeFor,
  editText,
  FILTER_OPS_BY_TYPE,
  filterLabel,
  formatCell,
  MIN_COLUMN_WIDTH,
  type Paging,
  parseCell,
  type Row,
  rowKey,
  selectionKey,
  type TableColumn,
  type TableView,
  tableColumns,
  tableView,
} from './table-model'

/** Optiply's table rows (its dashboard tables are 40px; data grids 48px). */
const ROW_HEIGHT = 40

/**
 * The Table: rows from `data` (virtualized, so thousands are fine), sorted by clicking a header (`sort`), searched
 * with the optional search box (`searchText`), shown all at once or a page at a time (`paging`; with `server`, a
 * query fetches each page and the table only keeps `pagination`, `sort` and `searchText`), selected by clicking a
 * row (Cmd/Ctrl-click adds to a multiple selection). Editable columns collect changes in
 * `changesetArray` (the primary key plus the changed fields per row) until Save fires `save` (and clears them once
 * the save succeeded) or Discard drops them. Arrows move between cells, Enter or a double click edits, Enter saves
 * the cell (and moves down), Tab saves it (and moves right), Escape cancels.
 */
export function TableRenderer({ component }: RendererProps) {
  const host = useAppHostContext()
  const gridId = useId()
  const name = component.name
  const data = useAppValue<unknown>(`${name}.data`)
  // What it shows: `data` with its computed columns (M24); `data` itself until the runtime has it.
  const shown = useAppValue<unknown>(`${name}.$rows`) ?? data
  const columnsProp = useAppValue<unknown>(`${name}.columns`)
  const primaryKey = useAppValue<string>(`${name}.primaryKey`) || 'id'
  const selection = useAppValue<'none' | 'single' | 'multiple'>(`${name}.rowSelection`)
  const emptyMessage = useAppValue<string>(`${name}.emptyMessage`)
  const changeset = useAppValue<Row[]>(`${name}.changesetArray`) ?? []
  const allowAddRow = useAppValue<boolean>(`${name}.allowAddRow`) === true
  const newRowsValue = useAppValue<unknown>(`${name}.newRows`)
  const newRows = Array.isArray(newRowsValue) ? (newRowsValue as Row[]) : []
  const actions = useContext(EditorActionsContext)
  const scope = useAppScope()
  /** Widths dragged here: while dragging, and in a running app until it reloads (the editor saves them). */
  const [widths, setWidths] = useState<Record<string, number>>({})
  const selectedRows = useAppValue<Row[]>(`${name}.selectedRows`) ?? []
  const selectedIndex = useAppValue<number | null>(`${name}.selectedIndex`)
  const showSearch = useAppValue<boolean>(`${name}.search`) === true
  const paging = useAppValue<Paging>(`${name}.paging`) ?? 'scroll'
  const pageSize = useAppValue<number>(`${name}.pageSize`) ?? 50
  const totalRowCount = useAppValue<number | null>(`${name}.totalRowCount`) ?? null
  const page = useAppValue<number>(`${name}.page`) ?? 0
  const sortState = useAppValue<{ column?: unknown; desc?: unknown } | null>(`${name}.sort`)
  const searchText = useAppValue<string>(`${name}.searchText`) ?? ''
  const showFilters = useAppValue<boolean>(`${name}.showFilters`) === true
  const filtersValue = useAppValue<unknown>(`${name}.filters`)
  const filters = useMemo(() => tableFilters(filtersValue), [filtersValue])
  /** The column whose filter is being set, in the bar above the rows. */
  const [filtering, setFiltering] = useState<string | null>(null)

  const rows = useMemo(() => (Array.isArray(shown) ? (shown as Row[]) : []), [shown])
  const columns = useMemo(() => tableColumns(columnsProp, rows), [columnsProp, rows])
  const sort = useMemo(
    () =>
      sortState && typeof sortState.column === 'string'
        ? { key: sortState.column, desc: sortState.desc === true }
        : null,
    [sortState],
  )
  const view = useMemo(
    () =>
      tableView({
        rows,
        columns,
        paging,
        page,
        pageSize,
        sort,
        searchText: typeof searchText === 'string' ? searchText : '',
        totalRowCount: typeof totalRowCount === 'number' ? totalRowCount : null,
        filters,
      }),
    [rows, columns, paging, page, pageSize, sort, searchText, totalRowCount, filters],
  )
  const ordered = view.rows
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  /**
   * The cell being edited, by its row's key and its column's key (not positions: the data can change while someone
   * types, an automatic query re-running, and the edit must still land on the row it started on).
   */
  const [editing, setEditing] = useState<{ row: string; col: string; text: string; error?: string } | null>(
    null,
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // A page past the last one (the data shrank, a search narrowed it) shows the last; `page` says so too.
  useEffect(() => {
    if (paging === 'pages' && view.page !== page) host.set({ [`${name}.page`]: view.page })
  }, [paging, view.page, page, host, name])

  const goToPage = (next: number) => {
    setActive(null)
    setEditing(null)
    host.call(name, 'setPage', [next])
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const lastPage = view.pageCount === null ? null : view.pageCount - 1
  const hasNext = lastPage === null ? rows.length >= pageSize : view.page < lastPage

  const selectedKeys = useMemo(() => {
    const keys = new Set(selectedRows.map((r) => selectionKey(r, primaryKey)))
    if (selectedIndex !== null && selectedIndex !== undefined && rows[selectedIndex]) {
      keys.add(selectionKey(rows[selectedIndex], primaryKey))
    }
    return keys
  }, [selectedRows, selectedIndex, rows, primaryKey])

  // A width (set, or dragged) is the column's; the others share what's left.
  const template = columns
    .map((c) => {
      const w = widths[c.key] ?? c.width
      return w ? `${w}px` : 'minmax(140px, 1fr)'
    })
    .join(' ')
  /**
   * The rows' least width: the header, the new rows and the body all take it (or the table's width when wider), so
   * their columns line up. (`max-content` sized the header by its labels, while the body's rows, positioned
   * absolutely, only had the table's width: with many columns the header's ran wider than the cells under them.)
   */
  const rowMinWidth = columns.reduce((sum, c) => sum + (widths[c.key] ?? c.width ?? 140), 0)

  /** Drags a header's right edge: the width follows the pointer; in the editor the drop saves it (M24). */
  const startResize = (e: PointerEvent<HTMLDivElement>, col: TableColumn) => {
    e.preventDefault()
    e.stopPropagation()
    const header = e.currentTarget.parentElement!
    const start = header.getBoundingClientRect().width
    const x0 = e.clientX
    let width = start
    const move = (ev: globalThis.PointerEvent) => {
      width = Math.max(MIN_COLUMN_WIDTH, Math.round(start + ev.clientX - x0))
      setWidths((w) => ({ ...w, [col.key]: width }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!actions || width === start) return
      actions.setColumnWidth(name, col.key, width, columns)
      // Saved: the definition has it now (and undo can take it back).
      setWidths(({ [col.key]: _saved, ...rest }) => rest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * Changes `newRows` from what the page has now, not from the last render: adding a row and typing into another
   * can come faster than renders, and every change replaces the whole list. Each goes through `set`, in order.
   */
  const changeNewRows = (change: (rows: Row[]) => Row[]) => {
    const current = host.store.getState().values[`${scope}${name}.newRows`]
    host.set({ [`${name}.newRows`]: change(Array.isArray(current) ? (current as Row[]) : []) })
  }
  /** A new row's field changed (`undefined` drops it). */
  const setNewField = (at: number, key: string, value: unknown) =>
    changeNewRows((rows) =>
      rows.map((r, i) => {
        if (i !== at) return r
        const { [key]: _old, ...rest } = r
        return value === undefined ? rest : { ...rest, [key]: value }
      }),
    )
  const cellValue = (row: Row, col: TableColumn) => {
    const change = changeFor(changeset, primaryKey, row)
    return change && col.key !== primaryKey && col.key in change ? change[col.key] : row[col.key]
  }
  const isChanged = (row: Row, col: TableColumn) => {
    const change = changeFor(changeset, primaryKey, row)
    // The entry names its row by the primary key: that column isn't a change.
    return !!change && col.key !== primaryKey && col.key in change
  }
  const canEdit = (row: Row, col: TableColumn) =>
    col.editable && col.key !== primaryKey && row[primaryKey] !== undefined && row[primaryKey] !== null

  const selectRow = (position: number, additive: boolean) => {
    if (selection === 'none') return
    const { row, index } = ordered[position]!
    if (selection === 'single' || !additive) {
      host.call(name, 'selectRow', [index])
      return
    }
    const key = selectionKey(row, primaryKey)
    const already = selectedRows.some((r) => selectionKey(r, primaryKey) === key)
    // The row as `data` has it (as `selectRow` sets it), without computed columns.
    const dataRow = Array.isArray(data) ? ((data[index] as Row | undefined) ?? row) : row
    const next = already
      ? selectedRows.filter((r) => selectionKey(r, primaryKey) !== key)
      : [...selectedRows, dataRow]
    host.set({
      [`${name}.selectedRows`]: next,
      [`${name}.selectedRow`]: next.at(-1) ?? null,
      [`${name}.selectedIndex`]: already ? null : index,
    })
    host.fire(name, 'rowSelect')
  }

  const commit = (move?: { dr: number; dc: number }) => {
    if (!editing) return
    const r = ordered.findIndex((o) => rowKey(o.row, primaryKey, o.index) === editing.row)
    const c = columns.findIndex((col) => col.key === editing.col)
    // The row (or column) went away while being edited: there's nothing left to change.
    if (r === -1 || c === -1) {
      setEditing(null)
      gridRef.current?.focus()
      return
    }
    const { row } = ordered[r]!
    const col = columns[c]!
    const parsed = parseCell(editing.text, col.type)
    if ('error' in parsed) return setEditing({ ...editing, error: parsed.error })
    host.set({ [`${name}.changesetArray`]: applyEdit(changeset, primaryKey, row, col.key, parsed.value) })
    host.fire(name, 'changeCell')
    setEditing(null)
    if (move) moveTo(r + move.dr, c + move.dc)
    gridRef.current?.focus()
  }

  const moveTo = (r: number, c: number) => {
    const next = {
      r: Math.max(0, Math.min(ordered.length - 1, r)),
      c: Math.max(0, Math.min(columns.length - 1, c)),
    }
    setActive(next)
    virtualizer.scrollToIndex(next.r)
  }

  const startEdit = (r: number, c: number) => {
    const { row } = ordered[r]!
    const col = columns[c]!
    if (!canEdit(row, col)) return
    if (col.type === 'boolean') {
      // Booleans toggle in place.
      host.set({
        [`${name}.changesetArray`]: applyEdit(changeset, primaryKey, row, col.key, !cellValue(row, col)),
      })
      host.fire(name, 'changeCell')
      return
    }
    setEditing({
      row: rowKey(row, primaryKey, ordered[r]!.index),
      col: col.key,
      text: editText(cellValue(row, col), col.type),
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !ordered.length || !columns.length) return
    const at = active ?? { r: 0, c: 0 }
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
    }
    const move = moves[e.key]
    if (move) {
      e.preventDefault()
      moveTo(at.r + move[0], at.c + move[1])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      startEdit(at.r, at.c)
    } else if (e.key === ' ') {
      e.preventDefault()
      selectRow(at.r, e.metaKey || e.ctrlKey)
    }
  }

  const cellId = (r: number, c: number) => `${gridId}-${r}-${c}`

  /** Sets the column's filter (one per column from the header; null removes it), as `setFilters` does. */
  const setFilter = (column: string, filter: TableFilter | null) => {
    setActive(null)
    setFiltering(null)
    const next = filters.filter((f) => f.column !== column)
    host.call(name, 'setFilters', [filter ? [...next, filter] : next])
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const filteringColumn = filtering === null ? undefined : columns.find((c) => c.key === filtering)

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface text-sm">
      {showSearch && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
          <input
            type="search"
            aria-label={`Search ${name}`}
            placeholder="Search"
            className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            value={typeof searchText === 'string' ? searchText : ''}
            onChange={(e) => {
              setActive(null)
              // Set (acknowledged, so fast typing never jumps back), then the event, like setSearchText.
              host.set({ [`${name}.searchText`]: e.target.value, [`${name}.page`]: 0 })
              host.fire(name, 'searchChange')
            }}
          />
        </div>
      )}
      {filteringColumn && (
        <FilterBar
          key={filteringColumn.key}
          column={filteringColumn}
          filter={filters.find((f) => f.column === filteringColumn.key)}
          onApply={(filter) => setFilter(filteringColumn.key, filter)}
          onCancel={() => setFiltering(null)}
        />
      )}
      {filters.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5"
          data-testid="filters"
        >
          {filters.map((f) => {
            const label = columns.find((c) => c.key === f.column)?.label ?? f.column
            return (
              <span
                key={f.column}
                className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2.5 text-xs text-accent"
              >
                <button type="button" onClick={() => setFiltering(f.column)} title="Change this filter">
                  {filterLabel(f, label)}
                </button>
                <button
                  type="button"
                  aria-label={`Remove the filter on ${label}`}
                  className="rounded-full p-0.5 hover:bg-surface"
                  onClick={() => setFilter(f.column, null)}
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
          {filters.length > 1 && (
            <button
              type="button"
              className="text-xs text-muted hover:text-ink"
              onClick={() => host.call(name, 'clearFilters')}
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <div
        ref={gridRef}
        role="grid"
        aria-label={name}
        aria-rowcount={ordered.length + 1}
        aria-colcount={columns.length}
        aria-activedescendant={active ? cellId(active.r, active.c) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid border-b border-border bg-surface"
            style={{ gridTemplateColumns: template, minWidth: rowMinWidth }}
          >
            {columns.map((col) => {
              const sorted = sort?.key === col.key
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  className="relative flex items-center truncate"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="flex h-12 w-full cursor-pointer items-center gap-1 px-3 text-left text-xs font-medium text-muted hover:text-ink"
                    onClick={() => {
                      setActive(null)
                      // Ascending, then descending, then unsorted.
                      host.call(
                        name,
                        'setSort',
                        !sorted ? [col.key, false] : sort.desc ? [null] : [col.key, true],
                      )
                      scrollRef.current?.scrollTo({ top: 0 })
                    }}
                  >
                    <span className="truncate">{col.label}</span>
                    {sorted &&
                      (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                  {/* A computed column isn't in the database: a query can't filter by it. */}
                  {showFilters && col.filterable && !(paging === 'server' && col.computed) && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Filter ${col.label}`}
                      className={cn(
                        'mr-1 shrink-0 rounded p-1 hover:bg-canvas',
                        filters.some((f) => f.column === col.key)
                          ? 'text-accent'
                          : 'text-muted hover:text-ink',
                      )}
                      onClick={() => setFiltering(filtering === col.key ? null : col.key)}
                    >
                      <ListFilter className="size-3.5" />
                    </button>
                  )}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${col.label}`}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/30"
                    onPointerDown={(e) => startResize(e, col)}
                  />
                </div>
              )
            })}
          </div>
          {newRows.length > 0 && (
            <div data-testid="new-rows" style={{ minWidth: rowMinWidth }}>
              {newRows.map((row, at) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: new rows have no identity yet but their place
                  key={at}
                  role="row"
                  aria-label={`New row ${at + 1}`}
                  className="relative grid border-b border-border bg-success/5"
                  style={{ height: ROW_HEIGHT, gridTemplateColumns: template }}
                >
                  {columns.map((col) =>
                    col.computed ? (
                      <div key={col.key} role="gridcell" />
                    ) : (
                      <div key={col.key} role="gridcell" className="flex items-center px-1">
                        <NewCell
                          label={`New ${col.label}`}
                          type={col.type}
                          value={row[col.key]}
                          onChange={(v) => setNewField(at, col.key, v)}
                        />
                      </div>
                    ),
                  )}
                  <button
                    type="button"
                    aria-label={`Remove new row ${at + 1}`}
                    className="absolute top-2.5 right-1 rounded p-0.5 text-muted hover:bg-surface hover:text-ink"
                    onClick={() => changeNewRows((rows) => rows.filter((_, i) => i !== at))}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {ordered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted">{emptyMessage}</div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: rowMinWidth }}>
              {virtualizer.getVirtualItems().map((v) => {
                const { row, index } = ordered[v.index]!
                const selected = selectedKeys.has(selectionKey(row, primaryKey))
                const key = rowKey(row, primaryKey, index)
                return (
                  <div
                    key={v.key}
                    role="row"
                    aria-rowindex={v.index + 2}
                    aria-selected={selection === 'none' ? undefined : selected}
                    data-row={index}
                    className={cn(
                      'absolute inset-x-0 grid border-b border-border',
                      selected ? 'bg-accent-soft' : 'hover:bg-canvas',
                      selection !== 'none' && 'cursor-pointer',
                    )}
                    style={{ top: v.start, height: ROW_HEIGHT, gridTemplateColumns: template }}
                    onClick={(e) => selectRow(v.index, e.metaKey || e.ctrlKey)}
                  >
                    {columns.map((col, c) => {
                      const isEditing = editing?.row === key && editing.col === col.key
                      const value = cellValue(row, col)
                      return (
                        <div
                          key={col.key}
                          id={cellId(v.index, c)}
                          role="gridcell"
                          aria-readonly={!canEdit(row, col)}
                          data-column={col.key}
                          onClick={() => setActive({ r: v.index, c })}
                          onDoubleClick={() => startEdit(v.index, c)}
                          className={cn(
                            'relative flex min-w-0 items-center px-3',
                            col.type === 'number' && 'justify-end tabular-nums',
                            isChanged(row, col) && 'bg-warning-soft',
                            active?.r === v.index &&
                              active.c === c &&
                              'outline-2 -outline-offset-2 outline-accent',
                          )}
                        >
                          {isEditing ? (
                            <CellEditor
                              text={editing.text}
                              error={editing.error}
                              type={col.type}
                              onChange={(text) => setEditing({ ...editing, text, error: undefined })}
                              onCommit={commit}
                              onCancel={() => {
                                setEditing(null)
                                gridRef.current?.focus()
                              }}
                            />
                          ) : col.type === 'boolean' ? (
                            <input
                              type="checkbox"
                              tabIndex={-1}
                              aria-label={col.label}
                              className="size-4 rounded accent-accent"
                              checked={value === true}
                              disabled={!canEdit(row, col)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => startEdit(v.index, c)}
                            />
                          ) : (
                            <span
                              className={cn(
                                'truncate',
                                (value === null || value === undefined) && 'text-muted',
                              )}
                            >
                              {formatCell(value, col.type)}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-11 items-center gap-2 border-t border-border bg-canvas px-3 py-1.5 text-xs text-muted">
        <RowCount
          view={view}
          rows={rows.length}
          searching={
            paging !== 'server' &&
            ((typeof searchText === 'string' && searchText.trim() !== '') || filters.length > 0)
          }
        />
        {paging !== 'scroll' && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              className="rounded p-1 hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={view.page === 0}
              onClick={() => goToPage(view.page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="tabular-nums" aria-live="polite">
              Page {view.page + 1}
              {view.pageCount !== null && ` of ${view.pageCount}`}
            </span>
            <button
              type="button"
              aria-label="Next page"
              className="rounded p-1 hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={!hasNext}
              onClick={() => goToPage(view.page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        )}
        {allowAddRow && (
          <button
            type="button"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1')}
            onClick={() => {
              // As `addRow` does, through `set` like the other changes to the new rows.
              changeNewRows((rows) => [...rows, {}])
              host.fire(name, 'addRow')
            }}
          >
            <Plus className="size-3.5" /> Add row
          </button>
        )}
        {(changeset.length > 0 || newRows.length > 0) && (
          <>
            <span className="ml-auto text-ink">
              {[
                changeset.length > 0 &&
                  `${changeset.length} changed ${changeset.length === 1 ? 'row' : 'rows'}`,
                newRows.length > 0 && `${newRows.length} new ${newRows.length === 1 ? 'row' : 'rows'}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button
              type="button"
              className={buttonVariants({ size: 'sm' })}
              onClick={() => host.call(name, 'clearChangeset')}
            >
              Discard
            </button>
            <button
              type="button"
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
              onClick={() => host.call(name, 'saveChanges')}
            >
              Save changes
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Sets one column's filter (M24): an operator for its type and the value(s) it needs. Apply sets it, Remove drops
 * it; a number typed is kept as a number.
 */
function FilterBar({
  column,
  filter,
  onApply,
  onCancel,
}: {
  column: TableColumn
  filter: TableFilter | undefined
  onApply: (filter: TableFilter | null) => void
  onCancel: () => void
}) {
  const ops = FILTER_OPS_BY_TYPE[column.type]
  const [op, setOp] = useState(filter && ops.some((o) => o.op === filter.op) ? filter.op : ops[0]!.op)
  const initial = filter?.value
  const [from, setFrom] = useState(
    Array.isArray(initial) ? String(initial[0] ?? '') : initial === undefined ? '' : String(initial),
  )
  const [to, setTo] = useState(Array.isArray(initial) ? String(initial[1] ?? '') : '')
  const inputType: Record<ColumnType, string> = {
    text: 'text',
    json: 'text',
    number: 'number',
    boolean: 'text',
    date: 'date',
    datetime: 'datetime-local',
  }
  const parse = (text: string) =>
    column.type === 'number' && text.trim() !== '' && Number.isFinite(Number(text))
      ? Number(text)
      : column.type === 'boolean'
        ? text === 'true'
        : text
  const apply = () => {
    const base = { column: column.key, op, type: column.type }
    if (op === 'empty' || op === 'notEmpty') return onApply(base)
    if (op === 'between') return onApply({ ...base, value: [parse(from), parse(to)] })
    onApply({ ...base, value: parse(column.type === 'boolean' && from === '' ? 'true' : from) })
  }
  const field = (value: string, set: (v: string) => void, label: string) =>
    column.type === 'boolean' ? (
      <select
        aria-label={label}
        value={value || 'true'}
        onChange={(e) => set(e.target.value)}
        className="h-7 rounded border border-border bg-surface px-1 text-xs"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    ) : (
      <input
        aria-label={label}
        type={inputType[column.type]}
        value={value}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        className="h-7 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-xs"
      />
    )
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas px-3 py-2 text-xs"
      data-testid="filter-bar"
    >
      <span className="font-medium">{column.label}</span>
      <select
        aria-label="Operator"
        value={op}
        onChange={(e) => setOp(e.target.value as typeof op)}
        className="h-7 rounded border border-border bg-surface px-1 text-xs"
      >
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {op !== 'empty' && op !== 'notEmpty' && field(from, setFrom, op === 'between' ? 'From' : 'Value')}
      {op === 'between' && (
        <>
          <span>and</span>
          {field(to, setTo, 'To')}
        </>
      )}
      <span className="ml-auto flex gap-1">
        <button type="button" className={buttonVariants({ variant: 'primary', size: 'sm' })} onClick={apply}>
          Apply
        </button>
        {filter && (
          <button type="button" className={buttonVariants({ size: 'sm' })} onClick={() => onApply(null)}>
            Remove
          </button>
        )}
        <button type="button" className={buttonVariants({ variant: 'ghost', size: 'sm' })} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  )
}

/** "23 rows"; "5 of 23 rows" while searching or filtering; with server paging, the total when the app gives one. */
function RowCount({ view, rows, searching }: { view: TableView; rows: number; searching: boolean }) {
  const count = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`
  if (view.total === null) return null
  return <span>{searching ? `${view.total} of ${count(rows)}` : count(view.total)}</span>
}

/**
 * A field of a row being added (M24): typed text kept as typed, its value parsed for the column's type (a
 * checkbox for booleans); an empty field leaves the field out of the row.
 */
function NewCell({
  label,
  type,
  value,
  onChange,
}: {
  label: string
  type: TableColumn['type']
  value: unknown
  onChange: (value: unknown) => void
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : editText(value, type)))
  const [error, setError] = useState<string | null>(null)
  if (type === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="mx-2 size-4 accent-accent"
      />
    )
  }
  return (
    <input
      aria-label={label}
      value={text}
      title={error ?? undefined}
      aria-invalid={error ? true : undefined}
      onChange={(e) => {
        const next = e.target.value
        setText(next)
        if (next === '') {
          setError(null)
          return onChange(undefined)
        }
        const parsed = parseCell(next, type)
        setError('error' in parsed ? parsed.error : null)
        if (!('error' in parsed)) onChange(parsed.value)
      }}
      className={cn(
        'h-7 w-full min-w-0 rounded border bg-surface px-2 text-sm outline-none',
        error ? 'border-danger' : 'border-border focus:border-accent',
      )}
    />
  )
}

function CellEditor({
  text,
  error,
  type,
  onChange,
  onCommit,
  onCancel,
}: {
  text: string
  error?: string
  type: TableColumn['type']
  onChange: (text: string) => void
  onCommit: (move?: { dr: number; dc: number }) => void
  onCancel: () => void
}) {
  // Enter, Tab and Escape finish the edit themselves; the blur that follows mustn't save it again (or at all).
  const finished = useRef(false)
  const finish = (action: () => void) => {
    finished.current = true
    action()
  }
  return (
    <>
      <input
        // biome-ignore lint/a11y/noAutofocus: the cell being edited takes the focus, as in a spreadsheet
        autoFocus
        aria-label="Cell value"
        aria-invalid={!!error}
        type={type === 'date' ? 'date' : 'text'}
        inputMode={type === 'number' ? 'decimal' : undefined}
        className={cn(
          'h-7 w-full rounded border bg-surface px-1.5 text-sm outline-none',
          error ? 'border-danger' : 'border-accent',
        )}
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          finished.current = false
          onChange(e.target.value)
        }}
        onBlur={() => {
          if (!finished.current) onCommit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(() => onCommit({ dr: 1, dc: 0 }))
          } else if (e.key === 'Tab') {
            e.preventDefault()
            finish(() => onCommit({ dr: 0, dc: e.shiftKey ? -1 : 1 }))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(onCancel)
          }
        }}
      />
      {error && (
        <span
          role="alert"
          className="absolute top-full left-0 z-20 mt-0.5 rounded bg-danger px-1.5 py-0.5 text-xs whitespace-nowrap text-on-accent"
        >
          {error}
        </span>
      )}
    </>
  )
}
