// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid on divs, so rows can be virtualized (absolutely positioned)
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid holds focus and points at the active cell (aria-activedescendant)
// biome-ignore-all lint/a11y/useKeyWithClickEvents: rows and cells are clicked; the keyboard works on the grid (arrows, Enter, Space)
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'
import {
  applyEdit,
  changeFor,
  editText,
  formatCell,
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

const ROW_HEIGHT = 32

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
  const columnsProp = useAppValue<unknown>(`${name}.columns`)
  const primaryKey = useAppValue<string>(`${name}.primaryKey`) || 'id'
  const selection = useAppValue<'none' | 'single' | 'multiple'>(`${name}.rowSelection`)
  const emptyMessage = useAppValue<string>(`${name}.emptyMessage`)
  const changeset = useAppValue<Row[]>(`${name}.changesetArray`) ?? []
  const selectedRows = useAppValue<Row[]>(`${name}.selectedRows`) ?? []
  const selectedIndex = useAppValue<number | null>(`${name}.selectedIndex`)
  const showSearch = useAppValue<boolean>(`${name}.search`) === true
  const paging = useAppValue<Paging>(`${name}.paging`) ?? 'scroll'
  const pageSize = useAppValue<number>(`${name}.pageSize`) ?? 50
  const totalRowCount = useAppValue<number | null>(`${name}.totalRowCount`) ?? null
  const page = useAppValue<number>(`${name}.page`) ?? 0
  const sortState = useAppValue<{ column?: unknown; desc?: unknown } | null>(`${name}.sort`)
  const searchText = useAppValue<string>(`${name}.searchText`) ?? ''

  const rows = useMemo(() => (Array.isArray(data) ? (data as Row[]) : []), [data])
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
      }),
    [rows, columns, paging, page, pageSize, sort, searchText, totalRowCount],
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

  const template = columns.map((c) => `minmax(${c.width ?? 140}px, 1fr)`).join(' ')
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
    const next = already
      ? selectedRows.filter((r) => selectionKey(r, primaryKey) !== key)
      : [...selectedRows, row]
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

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface text-sm">
      {showSearch && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
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
            className="sticky top-0 z-10 grid border-b border-border bg-canvas"
            style={{ gridTemplateColumns: template, minWidth: 'max-content' }}
          >
            {columns.map((col) => {
              const sorted = sort?.key === col.key
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  className="truncate"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-semibold text-muted hover:text-ink"
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
                </div>
              )
            })}
          </div>
          {ordered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted">{emptyMessage}</div>
          ) : (
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }}
            >
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
                      'absolute inset-x-0 grid border-b border-border/70',
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
                            isChanged(row, col) && 'bg-amber-50',
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
                              className="size-4 accent-accent"
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
      <div className="flex items-center gap-2 border-t border-border bg-canvas px-3 py-1.5 text-xs text-muted">
        <RowCount
          view={view}
          rows={rows.length}
          searching={paging !== 'server' && typeof searchText === 'string' && searchText.trim() !== ''}
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
        {changeset.length > 0 && (
          <>
            <span className="ml-auto text-ink">
              {changeset.length} changed {changeset.length === 1 ? 'row' : 'rows'}
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 hover:bg-surface hover:text-ink"
              onClick={() => host.call(name, 'clearChangeset')}
            >
              Discard
            </button>
            <button
              type="button"
              className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent/90"
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

/** "23 rows"; "5 of 23 rows" while searching; with server paging, the total when the app gives one. */
function RowCount({ view, rows, searching }: { view: TableView; rows: number; searching: boolean }) {
  const count = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`
  if (view.total === null) return null
  return <span>{searching ? `${view.total} of ${count(rows)}` : count(view.total)}</span>
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
          className="absolute top-full left-0 z-20 mt-0.5 rounded bg-danger px-1.5 py-0.5 text-xs whitespace-nowrap text-white"
        >
          {error}
        </span>
      )}
    </>
  )
}
