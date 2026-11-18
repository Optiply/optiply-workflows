import { ChevronDown, ChevronRight, RefreshCw, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { isUsualSchema, type SqlSchemaState, sqlTableName } from '@/lib/sql-schema'

/** At most this many tables are listed at once: a search narrows them. */
const SHOWN_TABLES = 200

/**
 * A SQL resource's tables and their columns (session 57), beside the SQL editor: searchable, a name clicked goes into
 * the SQL (`onInsert`), Refresh reads the database again. Folded until opened; the editor completes from it anyway.
 */
export function SqlSchemaPanel({
  state,
  onRefresh,
  onInsert,
}: {
  state: SqlSchemaState
  onRefresh: () => void
  onInsert: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Opened and closed by hand; while searching, tables with a matching column open unless closed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const schema = state.status === 'loaded' ? state.schema : null
  const several = new Set(schema?.tables.map((t) => t.schema)).size > 1
  const shown = useMemo(() => {
    if (!schema) return []
    const q = search.trim().toLowerCase()
    if (!q) return schema.tables
    return schema.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.schema.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)),
    )
  }, [schema, search])
  if (state.status === 'none') return null
  const nameOf = (t: { schema: string; name: string }) => sqlTableName(t, several)
  const q = search.trim().toLowerCase()
  const columnMatch = (t: { columns: { name: string }[] }) =>
    !!q && t.columns.some((c) => c.name.toLowerCase().includes(q))
  const isOpen = (key: string, t: { columns: { name: string }[] }) =>
    expanded.has(key) || (columnMatch(t) && !collapsed.has(key))
  const flip = (set: (f: (s: Set<string>) => Set<string>) => void, key: string, on: boolean) =>
    set((s) => {
      const next = new Set(s)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  const toggle = (key: string, open: boolean) => {
    flip(setExpanded, key, !open)
    flip(setCollapsed, key, open)
  }

  return (
    <div className="rounded-md border border-border" data-testid="sql-schema">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
          aria-expanded={open}
          data-testid="sql-schema-toggle"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Table2 className="size-3.5 text-muted" />
          Tables
          <span className="truncate font-normal text-muted" data-testid="sql-schema-summary">
            {state.status === 'loaded'
              ? `${state.schema.tables.length}${state.schema.truncated ? '+' : ''}${state.refreshing ? ' · reading…' : ''}`
              : state.status === 'loading'
                ? 'reading…'
                : state.status === 'unsupported'
                  ? 'not available for this driver'
                  : 'couldn’t be read'}
          </span>
        </button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          title="Read the tables again"
          aria-label="Refresh tables"
          loading={state.status === 'loading' || (state.status === 'loaded' && state.refreshing)}
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          {state.status === 'failed' && (
            <p className="text-xs text-danger" data-testid="sql-schema-error">
              {state.message}
            </p>
          )}
          {state.status === 'unsupported' && (
            <p className="text-xs text-muted">
              An uploaded driver’s tables can’t be listed: its SQL dialect is unknown.
            </p>
          )}
          {schema && (
            <>
              <Input
                aria-label="Search tables and columns"
                placeholder="Search tables and columns"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {schema.truncated && (
                <p className="text-xs text-muted">
                  Only the first {schema.limit.toLocaleString('en')} columns are listed.
                </p>
              )}
              <ul className="max-h-72 overflow-auto text-xs" data-testid="sql-schema-tables">
                {shown.length === 0 && <li className="px-1 py-1 text-muted">No tables match.</li>}
                {shown.slice(0, SHOWN_TABLES).map((t) => {
                  const key = `${t.schema}.${t.name}`
                  const open = isOpen(key, t)
                  return (
                    <li key={key}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted hover:bg-canvas"
                          aria-label={open ? `Hide ${key}’s columns` : `Show ${key}’s columns`}
                          onClick={() => toggle(key, open)}
                        >
                          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </button>
                        <button
                          type="button"
                          className="min-w-0 truncate rounded px-1 py-0.5 text-left font-mono hover:bg-canvas"
                          title={`Insert ${nameOf(t)}`}
                          onClick={() => onInsert(nameOf(t))}
                        >
                          {nameOf(t)}
                        </button>
                        {several && isUsualSchema(t.schema) && <span className="text-muted">{t.schema}</span>}
                      </div>
                      {open && (
                        <ul className="ml-6 border-l border-border pl-2">
                          {t.columns.map((c) => (
                            <li key={c.name} className="flex items-center gap-2">
                              <button
                                type="button"
                                className="min-w-0 truncate rounded px-1 py-0.5 text-left font-mono hover:bg-canvas"
                                title={`Insert ${c.name}`}
                                onClick={() => onInsert(c.name)}
                              >
                                {c.name}
                              </button>
                              <span className="shrink-0 text-muted">
                                {c.type}
                                {c.nullable ? '' : ' · not null'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
              {shown.length > SHOWN_TABLES && (
                <p className="text-xs text-muted">
                  {(shown.length - SHOWN_TABLES).toLocaleString('en')} more tables: search to narrow them.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
