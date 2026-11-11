import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { History, Workflow } from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import {
  ActionBar,
  EmptyState,
  ErrorNote,
  LoadMoreFooter,
  linkClass,
  PageHeader,
  Spinner,
  Table,
  Tabs,
  Td,
  Th,
} from '@/components/ui'
import { timeAgo } from '@/lib/list-model'
import { duration, pubsubMessage, queueMessageLine, runsApi } from '@/lib/runs-api'

const STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const
type StatusFilter = '' | (typeof STATUSES)[number]

/** Recent runs of every workflow you can see; each opens in the editor's run panel. */
export function RunsPage() {
  const [status, setStatus] = useState<StatusFilter>('')
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
      <PageHeader title="Runs" description="Every run of the workflows you can see, newest first." />
      <ActionBar className="mb-4" role="group" aria-label="Status">
        <Tabs
          className="mb-0"
          value={status}
          onChange={setStatus}
          tabs={[
            { value: '', label: 'All' },
            ...STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })),
          ]}
        />
        {runs.isFetching && !runs.isLoading && (
          <span className="ml-auto pr-2 text-xs text-muted" aria-live="polite">
            Refreshing…
          </span>
        )}
      </ActionBar>
      {runs.isLoading ? (
        <Spinner />
      ) : runs.error ? (
        <ErrorNote error={runs.error} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<History className="size-6" />} title="No runs">
          {status ? `No ${status} runs.` : 'Runs appear here once a workflow has run.'}
        </EmptyState>
      ) : (
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
              <tr key={run.id}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-md bg-accent-soft p-1.5 text-accent">
                      <Workflow className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                      <Link
                        to="/workflows/$workflowId"
                        params={{ workflowId: run.workflow.id }}
                        search={{ run: run.id }}
                        className={linkClass}
                      >
                        {run.workflow.name}
                      </Link>
                      <div className="font-mono text-xs text-muted">{run.workflow.slug}</div>
                    </div>
                  </div>
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
                  {pubsubMessage(run) && (
                    <span className="font-mono text-xs"> · message {pubsubMessage(run)!.messageId}</span>
                  )}
                  {run.triggerType !== 'pubsub' && queueMessageLine(run) && (
                    <span className="font-mono text-xs"> · {queueMessageLine(run)}</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-muted" title={new Date(run.createdAt).toLocaleString()}>
                  {timeAgo(run.createdAt)}
                </Td>
                <Td className="whitespace-nowrap text-muted">{duration(run.startedAt, run.finishedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
