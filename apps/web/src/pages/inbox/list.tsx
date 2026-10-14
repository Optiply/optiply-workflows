import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Checkbox, EmptyState, ErrorNote, PageHeader, Spinner, Table, Tabs, Td, Th } from '@/components/ui'
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
      <Tabs
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
                  <Link
                    to="/inbox/$taskId"
                    params={{ taskId: task.id }}
                    className="font-medium hover:text-accent"
                  >
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
                    <DueText dueAt={task.dueAt} />
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
    </>
  )
}

export function assigneeText(task: Pick<TaskSummary, 'assignees'>): string {
  return [...task.assignees.users.map((u) => u.name), ...task.assignees.groups].join(', ') || '—'
}

/** "in 3 hours", or overdue in red. */
export function DueText({ dueAt }: { dueAt: string | Date | null }) {
  if (!dueAt) return <span className="text-muted">No due date</span>
  const ms = new Date(dueAt).getTime() - Date.now()
  const text = relative(ms)
  return (
    <span
      className={ms < 0 ? 'text-danger' : ms < 3_600_000 ? 'text-amber-700' : undefined}
      title={new Date(dueAt).toLocaleString()}
    >
      {ms < 0 ? `${text} overdue` : `in ${text}`}
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
