import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { useState } from 'react'
import { Button, ErrorNote, Input, Select, Spinner, Table, Td, Th } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { formatDateTime } from '@/lib/utils'
import { AdminOnly } from './layout'

export function AuditPage() {
  return (
    <AdminOnly>
      <AuditTable />
    </AdminOnly>
  )
}

interface Filters {
  action: string
  objectType: string
  objectId: string
  actorUserId: string
  /** `yyyy-mm-dd` from the date inputs; `until` includes that whole day. */
  since: string
  until: string
}

const EMPTY: Filters = { action: '', objectType: '', objectId: '', actorUserId: '', since: '', until: '' }

/** The filters as the API takes them: empty ones left out, `until` moved to the end of its day. */
function toQuery(f: Filters) {
  const nextDay = (day: string) => new Date(new Date(`${day}T00:00:00`).getTime() + 86_400_000).toISOString()
  return {
    ...(f.action && { action: f.action }),
    ...(f.objectType && { objectType: f.objectType }),
    ...(f.objectId.trim() && { objectId: f.objectId.trim() }),
    ...(f.actorUserId && { actorUserId: f.actorUserId }),
    ...(f.since && { since: new Date(`${f.since}T00:00:00`).toISOString() }),
    ...(f.until && { until: nextDay(f.until) }),
  }
}

function AuditTable() {
  const trpc = useTRPC()
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))
  const query = toQuery(filters)
  const facets = useQuery(trpc.audit.facets.queryOptions())
  const events = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions(
      { limit: 50, ...query },
      { getNextPageParam: (last) => last.nextCursor },
    ),
  )
  const rows = events.data?.pages.flatMap((p) => p.items) ?? []
  const exportUrl = `/api/v1/audit/export.csv?${new URLSearchParams(query as Record<string, string>)}`
  const filtered = Object.keys(query).length > 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2" data-testid="audit-filters">
        <Select aria-label="Action" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
          <option value="">All actions</option>
          {facets.data?.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Person"
          value={filters.actorUserId}
          onChange={(e) => set({ actorUserId: e.target.value })}
        >
          <option value="">Everyone</option>
          {facets.data?.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Object type"
          value={filters.objectType}
          onChange={(e) => set({ objectType: e.target.value })}
        >
          <option value="">Any object</option>
          {facets.data?.objectTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Object id"
          className="w-48 font-mono text-xs"
          placeholder="Object id"
          value={filters.objectId}
          onChange={(e) => set({ objectId: e.target.value })}
        />
        <span className="flex items-center gap-1.5 text-sm text-muted">
          From
          <Input
            type="date"
            aria-label="From"
            className="w-36"
            value={filters.since}
            onChange={(e) => set({ since: e.target.value })}
          />
        </span>
        <span className="flex items-center gap-1.5 text-sm text-muted">
          to
          <Input
            type="date"
            aria-label="To"
            className="w-36"
            value={filters.until}
            onChange={(e) => set({ until: e.target.value })}
          />
        </span>
        {filtered && (
          <Button variant="ghost" onClick={() => setFilters(EMPTY)}>
            <X className="size-4" /> Clear
          </Button>
        )}
        <a
          href={exportUrl}
          download
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium shadow-xs hover:bg-canvas"
        >
          <Download className="size-4" /> Export CSV
        </a>
      </div>
      <ErrorNote error={events.error} />
      {events.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-44">When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Object</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody data-testid="audit-table">
            {rows.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-6 text-center text-muted">
                  {filtered ? 'Nothing matches these filters.' : 'Nothing recorded yet.'}
                </Td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-muted">{formatDateTime(e.at)}</Td>
                <Td>{e.actor?.email ?? <span className="text-muted">system</span>}</Td>
                <Td>
                  <button
                    type="button"
                    className="cursor-pointer rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs hover:bg-accent-soft"
                    title="Show only this action"
                    onClick={() => set({ action: e.action })}
                  >
                    {e.action}
                  </button>
                </Td>
                <Td className="text-xs text-muted">
                  {e.objectType ? (
                    <>
                      {e.objectType}
                      {e.objectId && <span className="ml-1 font-mono">{e.objectId.slice(0, 13)}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                  {e.environment && <div>{e.environment}</div>}
                </Td>
                <Td
                  className="max-w-md truncate font-mono text-xs text-muted"
                  title={JSON.stringify(e.metadata)}
                >
                  {e.metadata ? JSON.stringify(e.metadata) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {events.hasNextPage && (
        <Button onClick={() => events.fetchNextPage()} loading={events.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  )
}
