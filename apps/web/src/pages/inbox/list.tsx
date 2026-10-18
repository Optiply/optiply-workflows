import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import {
  Checkbox,
  EmptyState,
  ErrorNote,
  linkClass,
  PageContainer,
  PageHeader,
  Spinner,
  Table,
  Tabs,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

export type TaskSummary = RouterOutputs['tasks']['list'][number]

const app = getRouteApi('/app')

/** Tasks waiting for me (directly or through my groups), and the ones that are done. Admins can see everyone's. */
export function InboxPage() {
  const trpc = useTRPC()
  const { me } = app.useRouteContext()
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [everyone, setEveryone] = useState(false)
  const tasks = useQuery({
    ...trpc.tasks.list.queryOptions({ status, scope: everyone ? 'all' : 'mine' }),
    refetchInterval: 10_000,
  })

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Tasks workflows are waiting for you to complete."
        actions={
          me.isAdmin && (
            <Checkbox
              label="Everyone's tasks"
              checked={everyone}
              onChange={(e) => setEveryone(e.target.checked)}
            />
          )
        }
      />
      <PageContainer>
        <Tabs
          className="mb-2"
          value={status}
          onChange={setStatus}
          tabs={[
            { value: 'open', label: 'To do' },
            { value: 'closed', label: 'Done' },
          ]}
        />
        {tasks.isLoading ? (
          <Spinner />
        ) : tasks.error ? (
          <ErrorNote error={tasks.error} />
        ) : !tasks.data?.length ? (
          <EmptyState
            className="border-0"
            icon={<Inbox className="size-6" />}
            title={status === 'open' ? 'Nothing to do' : 'Nothing yet'}
          >
            {status === 'open'
              ? 'When a workflow needs you, its task shows up here.'
              : 'Tasks you completed, and ones that expired or were cancelled, show up here.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>Workflow</Th>
                <Th>Assigned to</Th>
                <Th>{status === 'open' ? 'Due' : 'Status'}</Th>
                <Th>{status === 'open' ? 'Since' : 'Completed by'}</Th>
              </tr>
            </thead>
            <tbody data-testid="inbox-table">
              {tasks.data.map((task) => (
                <tr key={task.id} className="hover:bg-canvas">
                  <Td>
                    <Link to="/inbox/$taskId" params={{ taskId: task.id }} className={linkClass}>
                      {task.title}
                    </Link>
                  </Td>
                  <Td>
                    {task.workflow.name}
                    <div className="text-xs text-muted">{task.environment}</div>
                  </Td>
                  <Td className="text-muted">{assigneeText(task)}</Td>
                  <Td className="whitespace-nowrap">
                    {status === 'open' ? (
                      <DueText dueAt={task.dueAt} status={task.status} />
                    ) : (
                      <>
                        <StatusBadge status={task.status} />
                        {task.outcome && <span className="ml-2 text-muted">{task.outcome}</span>}
                      </>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">
                    {status === 'open'
                      ? new Date(task.createdAt).toLocaleString()
                      : (task.completedBy?.name ?? '—')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </PageContainer>
    </>
  )
}

export function assigneeText(task: Pick<TaskSummary, 'assignees'>): string {
  return [...task.assignees.users.map((u) => u.name), ...task.assignees.groups].join(', ') || '—'
}

/** "in 3 hours"; once past, an open task has expired (in red): it can no longer be completed. */
export function DueText({ dueAt, status }: { dueAt: string | Date | null; status: string }) {
  if (!dueAt) return <span className="text-muted">No due date</span>
  const ms = new Date(dueAt).getTime() - Date.now()
  const text = relative(ms)
  const past = ms < 0
  return (
    <span
      className={
        past
          ? status === 'open'
            ? 'text-danger'
            : 'text-muted'
          : ms < 3_600_000
            ? 'text-warning-strong'
            : undefined
      }
      title={new Date(dueAt).toLocaleString()}
    >
      {past ? (status === 'open' ? `expired ${text} ago` : `${text} ago`) : `in ${text}`}
    </span>
  )
}

function relative(ms: number): string {
  const abs = Math.abs(ms)
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ]
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size)
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return 'less than a minute'
}
