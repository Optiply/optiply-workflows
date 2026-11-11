import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'
import {
  Columns3,
  Database,
  Download,
  FileUp,
  Filter,
  Plus,
  RefreshCw,
  Settings2,
  Table2,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  Button,
  buttonVariants,
  Checkbox,
  EmptyState,
  ErrorNote,
  Input,
  Select,
  Spinner,
  sectionLabelClass,
} from '@/components/ui'
import { trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import type { TableInfo } from './cells'
import { activeFilters, FilterBar, type Selection } from './filters'
import { Grid, rowsKey } from './grid'
import { ImportDialog } from './import-dialog'
import { AddRowDialog } from './row-dialog'
import { NewTableDialog, SchemaDialog } from './schema-dialogs'

const route = getRouteApi('/app/database')

const EMPTY_SELECTION: Selection = { filters: [], match: 'all', sort: [] }
/** The most row keys one delete request takes (the server's DELETE_LIMIT). */
const DELETE_BATCH = 1000

/**
 * The managed database: an environment's tables on the left, the chosen one as a spreadsheet on the right. Each
 * environment has its own tables; who may open them is Use on the built-in resource there.
 */
export function DatabasePage() {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = route.useSearch()
  const status = useQuery(trpc.database.environments.queryOptions())
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null)

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
  const [filter, setFilter] = useState('')
  const shownTables = filter.trim()
    ? tables.data?.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : tables.data

  if (status.isLoading) return <Spinner />
  if (!status.data) return <ErrorNote error={status.error} />

  const go = (env: string, next?: string) =>
    navigate({ to: '/database', search: { env, table: next }, replace: true })
  /** After a table was made, renamed or dropped: the list again, and that table open. */
  const showTable = async (name?: string) => {
    if (!environment) return
    await queryClient.invalidateQueries({
      queryKey: trpc.database.tables.queryKey({ environmentId: environment.id }),
    })
    await go(environment.slug, name)
  }

  return (
    <div className="flex h-full gap-2">
      <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface shadow-card">
        <div className="space-y-2.5 border-b border-border/70 p-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="rounded-md bg-accent-soft p-1.5 text-accent">
              <Database className="size-4" />
            </span>
            Database
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
          {usable && (
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="primary" onClick={() => setDialog('new')}>
                <Plus className="size-4" /> New table
              </Button>
              <Button size="sm" onClick={() => setDialog('import')}>
                <FileUp className="size-4" /> Import CSV
              </Button>
            </div>
          )}
        </div>
        {(tables.data?.length ?? 0) > 8 && (
          <div className="border-b border-border/70 p-2">
            <Input
              type="search"
              aria-label="Find a table"
              placeholder="Find a table"
              className="h-8"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Tables">
          {tables.data && tables.data.length > 0 && (
            <div className={cn(sectionLabelClass, 'flex justify-between px-2.5 pt-1 pb-1.5')}>
              <span>Tables</span>
              <span className="tabular-nums">{tables.data.length}</span>
            </div>
          )}
          {tables.isLoading && <Spinner />}
          {tables.data?.length === 0 && <p className="px-2 py-3 text-xs text-muted">No tables yet.</p>}
          {filter.trim() !== '' && shownTables?.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted">No table matches “{filter.trim()}”.</p>
          )}
          {shownTables?.map((t) => (
            <Link
              key={t.name}
              to="/database"
              search={{ env: environment!.slug, table: t.name }}
              replace
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-hover/60 hover:text-ink',
                t.name === table?.name &&
                  'bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent',
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
        {status.data.resourceSlug && status.data.resourceId && (
          <p className="border-t border-border/70 bg-canvas/50 p-3 text-xs text-muted">
            In workflows, query these tables with the{' '}
            <Link
              to="/resources/$resourceId"
              params={{ resourceId: status.data.resourceId }}
              className="rounded bg-canvas px-1 font-mono text-accent hover:underline"
            >
              {status.data.resourceSlug}
            </Link>{' '}
            resource, where admins also choose who may use them.
          </p>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface shadow-card">
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
          <TableView
            key={`${environment.id}:${table.name}`}
            environmentId={environment.id}
            table={table}
            tables={tables.data ?? []}
            onRenamed={(name) => void showTable(name)}
            onDropped={() => void showTable()}
          />
        ) : tables.data ? (
          <Notice title="No tables yet">
            Tables you create here, or with a query on the{' '}
            <code className="rounded bg-canvas px-1">{status.data.resourceSlug}</code> resource, show up on
            the left.
          </Notice>
        ) : null}
      </section>
      {dialog === 'new' && environment && (
        <NewTableDialog
          environmentId={environment.id}
          onClose={() => setDialog(null)}
          onCreated={(name) => void showTable(name)}
        />
      )}
      {dialog === 'import' && environment && (
        <ImportDialog
          environmentId={environment.id}
          tables={tables.data ?? []}
          onClose={() => setDialog(null)}
          onImported={(name) => void showTable(name)}
        />
      )}
    </div>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-8">
      <EmptyState className="border-0" icon={<Database className="size-5" />} title={title}>
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

function TableView({
  environmentId,
  table,
  tables,
  onRenamed,
  onDropped,
}: {
  environmentId: string
  table: TableInfo
  tables: TableInfo[]
  onRenamed: (name: string) => void
  onDropped: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [showFilters, setShowFilters] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [adding, setAdding] = useState(false)
  const [dialog, setDialog] = useState<'schema' | 'import' | null>(null)
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
  // In batches the server takes (1,000 keys a request), so a select-all of a long table works too.
  const remove = useMutation({
    mutationFn: async (keys: string[]) => {
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        await trpcClient.database.deleteRows.mutate({
          environmentId,
          table: table.name,
          keys: keys.slice(i, i + DELETE_BATCH),
        })
      }
    },
    onSettled: () => {
      setSelected(new Set())
      return refresh()
    },
  })
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
            <div className="absolute top-full left-0 z-30 mt-1 w-60 space-y-1 rounded-lg bg-surface p-2 shadow-menu">
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
            onClick={async () => {
              const n = selected.size
              if (
                !(await confirmDialog(
                  `Delete ${n} row${n === 1 ? '' : 's'} from ${table.name}? This can't be undone.`,
                  { danger: true, confirm: 'Delete' },
                ))
              )
                return
              remove.mutate([...selected])
            }}
          >
            <Trash2 className="size-4" /> Delete {selected.size}
          </Button>
        )}
        <Button size="sm" onClick={() => setDialog('schema')}>
          <Settings2 className="size-4" /> Table
        </Button>
        <Button size="sm" onClick={() => setDialog('import')}>
          <FileUp className="size-4" /> Import
        </Button>
        <Button size="icon" variant="ghost" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
        </Button>
        <a href={exportHref} download className={buttonVariants({ size: 'sm' })}>
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
      {dialog === 'schema' && (
        <SchemaDialog
          environmentId={environmentId}
          table={table}
          onClose={() => setDialog(null)}
          onChanged={() => void refresh()}
          onRenamed={onRenamed}
          onDropped={onDropped}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          environmentId={environmentId}
          tables={tables}
          initialTable={table}
          onClose={() => setDialog(null)}
          onImported={() => void refresh()}
        />
      )}
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
