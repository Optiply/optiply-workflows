import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { History } from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import {
  EmptyState,
  ErrorNote,
  LoadMoreFooter,
  linkClass,
  PageContainer,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { duration, runsApi } from '@/lib/runs-api'

const STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const

/** Recent runs of every workflow you can see; each opens in the editor's run panel. */
export function RunsPage() {
  const [status, setStatus] = useState<string>('')
  const runs = useInfiniteQuery({
    queryKey: ['runs', status],
    queryFn: ({ pageParam }) => runsApi.list({ status: status || undefined, before: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 5000,
  })
  const rows = runs.data?.pages.flatMap((p) => p.runs) ?? []

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every run of the workflows you can see, newest first."
        actions={
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        }
      />
      {runs.isLoading ? (
        <Spinner />
      ) : runs.error ? (
        <ErrorNote error={runs.error} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<History className="size-6" />} title="No runs">
          {status ? `No ${status} runs.` : 'Runs appear here once a workflow has run.'}
        </EmptyState>
      ) : (
        <PageContainer>
          <Table
            footer={
              <LoadMoreFooter
                count={rows.length}
                noun={['run', 'runs']}
                more={!!runs.hasNextPage}
                loading={runs.isFetchingNextPage}
                onMore={() => runs.fetchNextPage()}
              />
            }
          >
            <thead>
              <tr>
                <Th>Workflow</Th>
                <Th>Status</Th>
                <Th>Environment</Th>
                <Th>What ran</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
              </tr>
            </thead>
            <tbody data-testid="runs-table">
              {rows.map((run) => (
                <tr key={run.id} className="hover:bg-canvas">
                  <Td>
                    <Link
                      to="/workflows/$workflowId"
                      params={{ workflowId: run.workflow.id }}
                      search={{ run: run.id }}
                      className={linkClass}
                    >
                      {run.workflow.name}
                    </Link>
                    <div className="font-mono text-xs text-muted">{run.workflow.slug}</div>
                  </Td>
                  <Td>
                    <StatusBadge status={run.status} />
                    {run.error?.block && (
                      <div className="mt-0.5 font-mono text-xs text-danger">{run.error.block}</div>
                    )}
                  </Td>
                  <Td>{run.environment}</Td>
                  <Td className="text-muted">
                    {run.targetBlocks ? `block ${run.targetBlocks.join(', ')}` : run.version} ·{' '}
                    {run.triggerType}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{new Date(run.createdAt).toLocaleString()}</Td>
                  <Td className="whitespace-nowrap text-muted">{duration(run.startedAt, run.finishedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </PageContainer>
      )}
    </>
  )
}
