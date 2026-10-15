import { checkTaskSubmission, type OpenTaskField } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft, CircleCheck } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Button, Card, ErrorNote, Field, Input, Select, Spinner, Textarea } from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { assigneeText, DueText } from './list'

type Task = RouterOutputs['tasks']['get']
type Values = Record<string, unknown>

const route = getRouteApi('/app/inbox/$taskId')

/** One task: what the workflow asks, the form, and a button per outcome. */
export function TaskPage() {
  const { taskId } = route.useParams()
  const trpc = useTRPC()
  const task = useQuery(trpc.tasks.get.queryOptions({ id: taskId }))
  return (
    <>
      <Link to="/inbox" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Inbox
      </Link>
      {task.isLoading ? (
        <Spinner />
      ) : task.error ? (
        <ErrorNote error={task.error} />
      ) : (
        <TaskView task={task.data!} />
      )}
    </>
  )
}

function TaskView({ task }: { task: Task }) {
  const fields = (task.fields ?? []) as OpenTaskField[]
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="task-title">
            {task.title}
          </h1>
          {task.description && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink/80">{task.description}</p>
          )}
        </div>
        {task.status === 'open' && task.canComplete ? (
          <TaskForm task={task} fields={fields} />
        ) : (
          <Answer task={task} fields={fields} />
        )}
      </div>
      <Card className="h-fit space-y-3 p-4 text-sm">
        <Fact label="Status">
          <StatusBadge status={task.status} />
          {task.status === 'open' && task.runStatus !== 'waiting' && task.runStatus !== 'running' && (
            <span className="ml-2 text-muted">run {task.runStatus}</span>
          )}
        </Fact>
        <Fact label="Workflow">
          <Link
            to="/workflows/$workflowId"
            params={{ workflowId: task.workflow.id }}
            search={{ run: task.runId }}
            className="hover:text-accent"
          >
            {task.workflow.name}
          </Link>
          <span className="text-muted"> · {task.environment}</span>
        </Fact>
        <Fact label="Assigned to">{assigneeText(task)}</Fact>
        <Fact label="Due">
          <DueText dueAt={task.dueAt} status={task.status} />
        </Fact>
        <Fact label="Created">{new Date(task.createdAt).toLocaleString()}</Fact>
        {task.completedBy && (
          <Fact label="Completed by">
            {task.completedBy.name} · {task.completedAt && new Date(task.completedAt).toLocaleString()}
          </Fact>
        )}
      </Card>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div>{children}</div>
    </div>
  )
}

/** The form: starting values from the task's defaults, checked here the same way the server checks them. */
function TaskForm({ task, fields }: { task: Task; fields: OpenTaskField[] }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(fields.map((f) => [f.name, startValue(f)])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const complete = useMutation(
    trpc.tasks.complete.mutationOptions({
      onSuccess: async (done) => {
        queryClient.setQueryData(trpc.tasks.get.queryKey({ id: task.id }), done)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.tasks.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.tasks.openCount.queryKey() }),
        ])
      },
    }),
  )

  const submit = (outcome: string) => {
    const checked = checkTaskSubmission(fields, task.outcomes, outcome, values)
    if (!checked.ok) {
      setErrors(Object.fromEntries(checked.errors.map((e) => [e.field ?? '', e.message])))
      return
    }
    setErrors({})
    complete.mutate({ id: task.id, outcome, values: checked.values })
  }
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }))

  return (
    <Card className="space-y-4 p-5">
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name]}
          error={errors[field.name]}
          onChange={(v) => set(field.name, v)}
        />
      ))}
      {errors[''] && <p className="text-sm text-danger">{errors['']}</p>}
      <ErrorNote error={complete.error} />
      <div className="flex flex-wrap gap-2 pt-1">
        {(task.outcomes ?? []).map((o, i) => (
          <Button
            key={o.id}
            variant={i === 0 ? 'primary' : undefined}
            loading={complete.isPending && complete.variables?.outcome === o.id}
            disabled={complete.isPending}
            onClick={() => submit(o.id)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </Card>
  )
}

function startValue(field: OpenTaskField): unknown {
  const d = field.default
  if (field.type === 'checkbox') return d === true || d === 'true'
  if (d === undefined || d === null) return field.type === 'select' ? (field.options?.[0] ?? '') : ''
  return typeof d === 'string' ? d : String(d)
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: OpenTaskField
  value: unknown
  error?: string
  onChange: (value: unknown) => void
}) {
  const label = (
    <>
      {field.label}
      {field.required && <span className="text-danger"> *</span>}
    </>
  )
  const hint = error ? <span className="text-danger">{error}</span> : field.help
  if (field.type === 'checkbox') {
    return (
      <div className="space-y-1">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
    )
  }
  return (
    <Field label={label} hint={hint}>
      {field.type === 'longText' ? (
        <Textarea rows={4} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : field.type === 'select' ? (
        <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!field.required && <option value="">—</option>}
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type={field.type === 'number' ? 'number' : 'text'}
          step="any"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}

/** A task that's done (or can't be done by me): what was answered, or why it's closed. */
function Answer({ task, fields }: { task: Task; fields: OpenTaskField[] }) {
  if (task.status === 'completed') {
    const outcome = task.outcomes?.find((o) => o.id === task.outcome)?.label ?? task.outcome
    const values = (task.values ?? {}) as Values
    return (
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-success" data-testid="task-outcome">
          <CircleCheck className="size-5" /> {outcome}
        </div>
        {fields.map((f) => (
          <div key={f.name}>
            <div className="text-xs font-medium text-muted">{f.label}</div>
            <div className="whitespace-pre-wrap text-sm">{display(values[f.name])}</div>
          </div>
        ))}
      </Card>
    )
  }
  const pastDue = task.dueAt !== null && new Date(task.dueAt).getTime() <= Date.now()
  const why =
    task.status === 'expired' || (task.status === 'open' && pastDue)
      ? 'Nobody completed this task before it was due.'
      : task.status === 'cancelled'
        ? 'This task was cancelled: its run ended without it.'
        : ['succeeded', 'failed', 'cancelled'].includes(task.runStatus)
          ? 'Its run has already ended.'
          : "This task isn't assigned to you, so you can follow it but not complete it."
  return <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">{why}</p>
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}
