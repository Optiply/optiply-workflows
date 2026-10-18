// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid on divs, so rows can be virtualized (absolutely positioned)
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid container holds focus and points at the active cell (aria-activedescendant)
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  type ColumnDef,
  type ColumnSizingState,
  getCoreRowModel,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorNote } from '@/components/ui'
import { errorMessage, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import {
  CellView,
  cellText,
  defaultWidth,
  editable,
  parseCell,
  type Row,
  type TableInfo,
  TYPE_LABELS,
  ValueInput,
} from './cells'
import { activeFilters, type Selection } from './filters'

const PAGE = 100
const ROW_HEIGHT = 34
const SELECT_COLUMN = '__select'

type RowsPage = Awaited<ReturnType<typeof trpcClient.database.rows.query>>
interface RowsData {
  pages: RowsPage[]
  pageParams: number[]
}

/** The rows of one table in one environment, under one selection. Invalidating the prefix refetches them all. */
export function rowsKey(environmentId: string, table: string, selection?: Selection) {
  return selection
    ? (['database', 'rows', environmentId, table, selection] as const)
    : (['database', 'rows', environmentId, table] as const)
}

/** A page of rows as the server wants the selection: complete filters only. */
function serverQuery(selection: Selection, offset: number) {
  return {
    offset,
    limit: PAGE,
    sort: selection.sort,
    match: selection.match,
    filters: activeFilters(selection.filters).map((f) => ({ column: f.column, op: f.op, value: f.value })),
  }
}

/**
 * The spreadsheet: rows load a page at a time as you scroll (only the rows on screen are rendered), headers sort,
 * columns resize and hide. Click a cell to select it, arrows to move, Enter or a double click to edit; Enter saves
 * (and moves down), Tab saves (and moves right), Escape cancels. Edits save straight away, one cell at a time.
 */
export function Grid({
  environmentId,
  table,
  selection,
  onSortChange,
  columnVisibility,
  onColumnVisibilityChange,
  selected,
  onSelectedChange,
}: {
  environmentId: string
  table: TableInfo
  selection: Selection
  onSortChange: (sort: Selection['sort']) => void
  columnVisibility: VisibilityState
  onColumnVisibilityChange: (visibility: VisibilityState) => void
  selected: Set<string>
  onSelectedChange: (selected: Set<string>) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const key = table.primaryKey.length === 1 ? table.primaryKey[0]! : null
  const queryKey = rowsKey(environmentId, table.name, selection)
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      trpcClient.database.rows.query({
        environmentId,
        table: table.name,
        query: serverQuery(selection, pageParam),
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.rows.length === PAGE ? pages.length * PAGE : undefined),
  })
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data])
  const first = query.data?.pages[0]

  const [sizing, setSizing] = useState<ColumnSizingState>({})
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      ...(key ? [{ id: SELECT_COLUMN, size: 40, enableResizing: false } satisfies ColumnDef<Row>] : []),
      ...table.columns.map(
        (c): ColumnDef<Row> => ({
          id: c.name,
          accessorFn: (row) => row[c.name],
          size: defaultWidth(c),
          minSize: 60,
          maxSize: 800,
        }),
      ),
    ],
    [table, key],
  )
  const grid = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row, i) => (key ? String(row[key]) : String(i)),
    manualSorting: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: { columnVisibility, columnSizing: sizing },
    onColumnSizingChange: setSizing,
    onColumnVisibilityChange: (updater) =>
      onColumnVisibilityChange(typeof updater === 'function' ? updater(columnVisibility) : updater),
  })
  const visible = grid.getVisibleLeafColumns().filter((c) => c.id !== SELECT_COLUMN)
  const columnInfo = (id: string) => table.columns.find((c) => c.name === id)!

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()
  // Near the end of what's loaded: load the next page.
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (lastIndex >= rows.length - 20 && query.hasNextPage && !query.isFetchingNextPage)
      void query.fetchNextPage()
  }, [lastIndex, rows.length, query])

  // ── Selecting and editing cells ─────────────────────────────────────────
  const [active, setActive] = useState<{ row: number; col: string } | null>(null)
  const [editing, setEditing] = useState<{ row: number; col: string; text: string } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const update = useMutation(trpc.database.updateRow.mutationOptions())
  // A new table or selection starts afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on these changes only
  useEffect(() => {
    setActive(null)
    setEditing(null)
    setEditError(null)
  }, [table.name, environmentId, selection])

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true })
  const moveTo = (row: number, col: string) => {
    const r = Math.max(0, Math.min(rows.length - 1, row))
    setActive({ row: r, col })
    virtualizer.scrollToIndex(r, { align: 'auto' })
  }
  const moveBy = (dRow: number, dCol: number) => {
    if (!active) return
    const ids = visible.map((c) => c.id)
    const col = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(active.col) + dCol))]!
    moveTo(active.row + dRow, col)
  }
  const startEditing = (row: number, col: string) => {
    const column = columnInfo(col)
    if (!editable(column, table)) return
    setActive({ row, col })
    setEditing({ row, col, text: cellText(rows[row]?.[col], column) })
    setEditError(null)
  }
  const stopEditing = () => {
    setEditing(null)
    setEditError(null)
    focusGrid()
  }
  const commit = async (then?: () => void) => {
    if (!editing || !key) return
    const column = columnInfo(editing.col)
    const row = rows[editing.row]!
    const parsed = parseCell(editing.text, column)
    if (!parsed.ok) return setEditError(parsed.error)
    // Unchanged: nothing to save.
    if (JSON.stringify(parsed.value) === JSON.stringify(row[editing.col] ?? null)) {
      stopEditing()
      then?.()
      return
    }
    try {
      const saved = await update.mutateAsync({
        environmentId,
        table: table.name,
        key: row[key] as string | number,
        values: { [editing.col]: parsed.value },
      })
      queryClient.setQueryData<RowsData>(queryKey, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                rows: p.rows.map((r) => (String(r[key]) === String(row[key]) ? saved : r)),
              })),
            }
          : data,
      )
      stopEditing()
      then?.()
    } catch (err) {
      const message = errorMessage(err)
      setEditError(message.startsWith(`${editing.col}: `) ? message.slice(editing.col.length + 2) : message)
    }
  }

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !active) return
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (moves[e.key]) {
      e.preventDefault()
      moveBy(...moves[e.key]!)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEditing(active.row, active.col)
    } else if (e.key === 'Escape') {
      setActive(null)
    }
  }
  const onEditorKey = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit(() => moveBy(1, 0))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      void commit(() => moveBy(0, e.shiftKey ? -1 : 1))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      stopEditing()
    }
  }

  // ── Sorting and selecting rows ──────────────────────────────────────────
  const sortOf = (col: string) => selection.sort.find((s) => s.column === col)
  // None → ascending → descending → none.
  const cycleSort = (col: string) => {
    const current = sortOf(col)
    onSortChange(
      !current ? [{ column: col, desc: false }] : current.desc ? [] : [{ column: col, desc: true }],
    )
  }
  const loadedKeys = key ? rows.map((r) => String(r[key])) : []
  const allSelected = loadedKeys.length > 0 && loadedKeys.every((k) => selected.has(k))
  const toggleRow = (k: string) => {
    const next = new Set(selected)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    onSelectedChange(next)
  }

  const width = grid.getTotalSize()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!key && (
        <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-warning-strong">
          {table.name} has {table.primaryKey.length ? 'a primary key of several columns' : 'no primary key'},
          so its rows can only be read and added here. Use a query to change them.
        </p>
      )}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={table.name}
        aria-rowcount={first ? first.total + 1 : undefined}
        aria-activedescendant={active ? cellId(active.row, active.col) : undefined}
        onKeyDown={onGridKey}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        data-testid="grid"
      >
        <div style={{ width, minWidth: '100%' }}>
          {/* Header */}
          <div className="sticky top-0 z-10 flex border-b border-border bg-canvas" role="row">
            {grid.getHeaderGroups()[0]!.headers.map((header) => {
              if (header.column.id === SELECT_COLUMN) {
                return (
                  <div
                    key={header.id}
                    className="flex items-center justify-center"
                    style={{ width: header.getSize() }}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all loaded rows"
                      className="size-4 accent-accent"
                      checked={allSelected}
                      onChange={() => onSelectedChange(allSelected ? new Set() : new Set(loadedKeys))}
                    />
                  </div>
                )
              }
              const column = columnInfo(header.column.id)
              const sort = sortOf(column.name)
              return (
                <div
                  key={header.id}
                  role="columnheader"
                  aria-sort={sort ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  className="group relative flex h-9 items-center border-r border-border"
                  style={{ width: header.getSize() }}
                >
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 text-left"
                    title={`${column.name} · ${column.sqlType}. Click to sort.`}
                    onClick={() => cycleSort(column.name)}
                  >
                    <span className="truncate text-xs font-semibold text-ink">{column.name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                      {column.primaryKey ? 'key' : TYPE_LABELS[column.type]}
                    </span>
                    {sort && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle for resizing */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      'absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100 hover:bg-accent/40',
                      header.column.getIsResizing() && 'bg-accent opacity-100',
                    )}
                  />
                </div>
              )
            })}
          </div>

          {/* Rows: only those on screen exist. */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = grid.getRowModel().rows[item.index]
              if (!row) return null
              const rowKey = key ? String(row.original[key]) : null
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className={cn(
                    'absolute top-0 left-0 flex border-b border-border',
                    rowKey && selected.has(rowKey) ? 'bg-accent-soft/60' : 'bg-surface hover:bg-canvas/60',
                  )}
                  style={{ height: item.size, transform: `translateY(${item.start}px)`, width: '100%' }}
                  data-testid="grid-row"
                >
                  {row.getVisibleCells().map((cell) => {
                    if (cell.column.id === SELECT_COLUMN) {
                      return (
                        <div
                          key={cell.id}
                          className="flex items-center justify-center"
                          style={{ width: cell.column.getSize() }}
                        >
                          <input
                            type="checkbox"
                            aria-label="Select row"
                            className="size-4 accent-accent"
                            checked={rowKey ? selected.has(rowKey) : false}
                            onChange={() => rowKey && toggleRow(rowKey)}
                          />
                        </div>
                      )
                    }
                    const column = columnInfo(cell.column.id)
                    const isActive = active?.row === item.index && active.col === column.name
                    const isEditing = editing?.row === item.index && editing.col === column.name
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the grid handles the keyboard
                      <div
                        key={cell.id}
                        role="gridcell"
                        id={cellId(item.index, column.name)}
                        aria-selected={isActive}
                        data-column={column.name}
                        className={cn(
                          'relative flex items-center border-r border-border px-2 text-sm',
                          isActive && 'outline-2 -outline-offset-2 outline-accent',
                          isEditing ? 'z-20 overflow-visible p-0' : 'overflow-hidden',
                          !editable(column, table) && 'bg-canvas/40',
                        )}
                        style={{ width: cell.column.getSize() }}
                        onClick={() => {
                          if (editing && !isEditing) void commit()
                          setActive({ row: item.index, col: column.name })
                        }}
                        onDoubleClick={() => startEditing(item.index, column.name)}
                      >
                        {isEditing ? (
                          <>
                            <ValueInput
                              column={column}
                              value={editing.text}
                              autoFocus
                              className="ring-2 ring-accent"
                              onChange={(text) => setEditing({ ...editing, text })}
                              onKeyDown={onEditorKey}
                            />
                            {(editError || update.isPending) && (
                              <div
                                className={cn(
                                  'absolute top-full left-0 z-30 mt-1 w-max max-w-sm rounded-md px-2 py-1 text-xs shadow-md',
                                  editError ? 'bg-danger text-on-accent' : 'bg-ink text-on-accent',
                                )}
                                role={editError ? 'alert' : 'status'}
                              >
                                {editError ?? 'Saving…'}
                              </div>
                            )}
                          </>
                        ) : (
                          <CellView value={cell.getValue()} column={column} />
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {query.isLoading && (
          <div className="flex justify-center py-12 text-muted">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
        {query.data && rows.length === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted">
            {activeFilters(selection.filters).length ? 'No rows match the filters.' : 'No rows yet.'}
          </p>
        )}
      </div>
      <ErrorNote error={query.error} />
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-canvas px-4 text-xs text-muted">
        <span data-testid="row-count">{first ? countText(first.total, first.more, rows.length) : ' '}</span>
        {query.isFetchingNextPage && <Loader2 className="size-3 animate-spin" />}
        {selected.size > 0 && <span>{selected.size.toLocaleString('en')} selected</span>}
      </div>
    </div>
  )
}

/** A DOM id for a cell (column names may hold any character). */
function cellId(row: number, col: string): string {
  return `cell-${row}-${encodeURIComponent(col).replace(/%/g, '_')}`
}

function countText(total: number, more: boolean, loaded: number): string {
  const all = `${total.toLocaleString('en')}${more ? '+' : ''} row${total === 1 && !more ? '' : 's'}`
  return loaded < total || more ? `${all} · ${loaded.toLocaleString('en')} loaded` : all
}
