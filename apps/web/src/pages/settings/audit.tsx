import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, ErrorNote, Spinner, Table, Td, Th } from '@/components/ui'
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

function AuditTable() {
  const trpc = useTRPC()
  const query = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions({ limit: 50 }, { getNextPageParam: (last) => last.nextCursor }),
  )
  const events = query.data?.pages.flatMap((p) => p.items) ?? []

  if (query.isLoading) return <Spinner />
  return (
    <div className="space-y-3">
      <ErrorNote error={query.error} />
      <Table>
        <thead>
          <tr>
            <Th className="w-44">When</Th>
            <Th>Who</Th>
            <Th>Action</Th>
            <Th>Details</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-muted">{formatDateTime(e.at)}</Td>
              <Td>{e.actor?.email ?? <span className="text-muted">anonymous</span>}</Td>
              <Td>
                <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{e.action}</code>
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
      {query.hasNextPage && (
        <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  )
}
