import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'
import { Columns3, Database, Download, Filter, Plus, RefreshCw, Table2, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, EmptyState, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import type { TableInfo } from './cells'
import { activeFilters, FilterBar, type Selection } from './filters'
import { Grid, rowsKey } from './grid'
import { AddRowDialog } from './row-dialog'

const route = getRouteApi('/app/database')

const EMPTY_SELECTION: Selection = { filters: [], match: 'all', sort: [] }

/**
 * The managed database: an environment's tables on the left, the chosen one as a spreadsheet on the right. Each
 * environment has its own tables; who may open them is Use on the built-in resource there.
 */
export function DatabasePage() {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const search = route.useSearch()
  const status = useQuery(trpc.database.environments.queryOptions())

  const environments = status.data?.environments ?? []
  const environment =
    environments.find((e) => e.slug === search.env) ??
    environments.find((e) => e.canUse && e.ready) ??
    environments[0]
  const usable = Boolean(environment?.ready && environment.canUse)
  const tables = useQuery({
    ...trpc.database.tables.queryOptions({ environmentId: environment?.id ?? '' }),
    enabled: usable,
  })
  const table = tables.data?.find((t) => t.name === search.table) ?? tables.data?.[0]

  if (status.isLoading) return <Spinner />
  if (!status.data) return <ErrorNote error={status.error} />

  const go = (env: string, next?: string) =>
    navigate({ to: '/database', search: { env, table: next }, replace: true })

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center gap-2 font-semibold">
            <Database className="size-4 text-accent" /> Database
          </div>
          <Select
            aria-label="Environment"
            className="w-full"
            value={environment?.slug ?? ''}
            onChange={(e) => void go(e.target.value)}
          >
            {environments.map((e) => (
              <option key={e.id} value={e.slug}>
                {e.name}
                {!e.canUse ? ' (no access)' : !e.ready ? ' (not set up)' : ''}
              </option>
            ))}
          </Select>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Tables">
          {tables.isLoading && <Spinner />}
          {tables.data?.length === 0 && <p className="px-2 py-3 text-xs text-muted">No tables yet.</p>}
          {tables.data?.map((t) => (
            <Link
              key={t.name}
              to="/database"
              search={{ env: environment!.slug, table: t.name }}
              replace
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-black/5',
                t.name === table?.name && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft',
              )}
            >
              <Table2 className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {t.estimatedRows !== null && (
                <span className="text-xs text-muted tabular-nums">
                  {t.estimatedRows.toLocaleString('en')}
                </span>
              )}
            </Link>
          ))}
        </nav>
        {status.data.resourceSlug && (
          <p className="border-t border-border p-3 text-xs text-muted">
            In workflows, query these tables with the{' '}
            <code className="rounded bg-canvas px-1">{status.data.resourceSlug}</code> resource.
          </p>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!environment?.ready ? (
          <Notice title="The database isn't set up yet">
            It's created when the server starts. If it stays like this, the server log says why (usually: the
            platform's database user needs CREATEROLE).
          </Notice>
        ) : !environment.canUse ? (
          <Notice title={`No access in ${environment.name}`}>
            Ask an admin for Use access to the Optiply Database resource in {environment.name}.
          </Notice>
        ) : tables.error ? (
          <div className="p-6">
            <ErrorNote error={tables.error} />
          </div>
        ) : table ? (
          <TableView key={`${environment.id}:${table.name}`} environmentId={environment.id} table={table} />
        ) : tables.data ? (
          <Notice title="No tables yet">
            Tables you create here, or with a query on the{' '}
            <code className="rounded bg-canvas px-1">{status.data.resourceSlug}</code> resource, show up on
            the left.
          </Notice>
        ) : null}
      </section>
    </div>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-8">
      <EmptyState icon={<Database className="size-5" />} title={title}>
        {children}
      </EmptyState>
    </div>
  )
}

/** Hidden columns are remembered per environment and table, in this browser. */
function useHiddenColumns(storageKey: string) {
  const [visibility, setVisibility] = useState<VisibilityState>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    } catch {
      return {}
    }
  })
  const update = useCallback(
    (next: VisibilityState) => {
      setVisibility(next)
      localStorage.setItem(storageKey, JSON.stringify(next))
    },
    [storageKey],
  )
  return [visibility, update] as const
}

function TableView({ environmentId, table }: { environmentId: string; table: TableInfo }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [showFilters, setShowFilters] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visibility, setVisibility] = useHiddenColumns(`ow.database.hidden.${environmentId}.${table.name}`)

  // A different selection shows different rows: selected ones may be gone from view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the selection changes
  useEffect(() => setSelected(new Set()), [selection])

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: rowsKey(environmentId, table.name) }),
      queryClient.invalidateQueries({ queryKey: trpc.database.tables.queryKey({ environmentId }) }),
    ])
  const remove = useMutation(
    trpc.database.deleteRows.mutationOptions({
      onSuccess: () => {
        setSelected(new Set())
        return refresh()
      },
    }),
  )
  const onFilters = useCallback(
    (filters: Selection['filters'], match: Selection['match']) =>
      setSelection((s) => ({ ...s, filters, match })),
    [],
  )
  const active = activeFilters(selection.filters).length
  const hidden = table.columns.filter((c) => visibility[c.name] === false).length

  const exportHref = useMemo(() => {
    const qs = new URLSearchParams({
      environmentId,
      table: table.name,
      selection: JSON.stringify({
        sort: selection.sort,
        match: selection.match,
        filters: activeFilters(selection.filters),
      }),
    })
    return `/api/v1/database/export.csv?${qs}`
  }, [environmentId, table.name, selection])

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="mr-2 truncate font-semibold">{table.name}</h1>
        <Button
          size="sm"
          variant={showFilters || active ? 'primary' : 'secondary'}
          onClick={() => {
            if (!showFilters && selection.filters.length === 0) {
              const column = table.columns.find((c) => !c.primaryKey) ?? table.columns[0]!
              setSelection({ ...selection, filters: [{ column: column.name, op: 'contains', value: '' }] })
            }
            setShowFilters(!showFilters)
          }}
        >
          <Filter className="size-4" /> Filter{active ? ` (${active})` : ''}
        </Button>
        <div className="relative">
          <Button size="sm" onClick={() => setShowColumns(!showColumns)}>
            <Columns3 className="size-4" /> Columns{hidden ? ` (${hidden} hidden)` : ''}
          </Button>
          {showColumns && (
            <div className="absolute top-full left-0 z-30 mt-1 w-60 space-y-1 rounded-lg border border-border bg-surface p-2 shadow-lg">
              {table.columns.map((c) => (
                <Checkbox
                  key={c.name}
                  className="flex w-full rounded px-1.5 py-1 hover:bg-canvas"
                  label={c.name}
                  checked={visibility[c.name] !== false}
                  onChange={(e) => setVisibility({ ...visibility, [c.name]: e.target.checked })}
                />
              ))}
              <div className="flex justify-end border-t border-border pt-1">
                <Button size="sm" variant="ghost" onClick={() => setShowColumns(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex-1" />
        {selected.size > 0 && (
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              const n = selected.size
              if (!confirm(`Delete ${n} row${n === 1 ? '' : 's'} from ${table.name}? This can't be undone.`))
                return
              remove.mutate({ environmentId, table: table.name, keys: [...selected] })
            }}
          >
            <Trash2 className="size-4" /> Delete {selected.size}
          </Button>
        )}
        <Button size="icon" variant="ghost" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
        </Button>
        <a
          href={exportHref}
          download
          className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium shadow-xs hover:bg-canvas"
        >
          <Download className="size-4" /> Export CSV
        </a>
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add row
        </Button>
      </div>
      {remove.error && (
        <div className="px-4 pt-2">
          <ErrorNote error={remove.error} />
        </div>
      )}
      {showFilters && (
        <FilterBar
          columns={table.columns}
          filters={selection.filters}
          match={selection.match}
          onChange={onFilters}
        />
      )}
      <Grid
        environmentId={environmentId}
        table={table}
        selection={selection}
        onSortChange={(sort) => setSelection({ ...selection, sort })}
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        selected={selected}
        onSelectedChange={setSelected}
      />
      {adding && (
        <AddRowDialog
          environmentId={environmentId}
          table={table}
          onClose={() => setAdding(false)}
          onAdded={() => void refresh()}
        />
      )}
    </>
  )
}
