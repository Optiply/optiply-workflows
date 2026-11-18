import { ChevronDown, ChevronRight, RefreshCw, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, Input } from '@/components/ui'
import type { SqlSchemaState } from '@/lib/sql-schema'

/** Schemas tables are usually in, written without it. */
const USUAL = new Set(['public', 'dbo', 'main'])

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
  const nameOf = (t: { schema: string; name: string }) =>
    several && !USUAL.has(t.schema.toLowerCase()) ? `${t.schema}.${t.name}` : t.name
  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

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
              ? `${state.schema.tables.length}${state.schema.truncated ? '+' : ''}`
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
          loading={state.status === 'loading'}
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
                <p className="text-xs text-muted">Only the first 20,000 columns are listed.</p>
              )}
              <ul className="max-h-72 overflow-auto text-xs" data-testid="sql-schema-tables">
                {shown.length === 0 && <li className="px-1 py-1 text-muted">No tables match.</li>}
                {shown.map((t) => {
                  const key = `${t.schema}.${t.name}`
                  const isOpen = expanded.has(key) || !!search.trim()
                  return (
                    <li key={key}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted hover:bg-canvas"
                          aria-label={isOpen ? `Hide ${key}’s columns` : `Show ${key}’s columns`}
                          onClick={() => toggle(key)}
                        >
                          {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </button>
                        <button
                          type="button"
                          className="min-w-0 truncate rounded px-1 py-0.5 text-left font-mono hover:bg-canvas"
                          title={`Insert ${nameOf(t)}`}
                          onClick={() => onInsert(nameOf(t))}
                        >
                          {nameOf(t)}
                        </button>
                        {several && USUAL.has(t.schema.toLowerCase()) && (
                          <span className="text-muted">{t.schema}</span>
                        )}
                      </div>
                      {isOpen && (
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
