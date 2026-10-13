import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Workflow } from 'lucide-react'
import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

type WorkflowSummary = RouterOutputs['workflows']['list'][number]

const LEVELS = { use: 'Can run', edit: 'Can edit', own: 'Owner' } as const

/** `Sync Orders!` → `sync-orders`: what webhook URLs (M4) will use. */
export function workflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 'w-$1')
    .slice(0, 63)
}

export function WorkflowsPage() {
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.workflows.list.queryOptions())
  const [creating, setCreating] = useState(false)

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Automated backend processes: blocks that query resources, run code and branch."
        actions={
          <Button variant="primary" onClick={() => setCreating(!creating)}>
            <Plus className="size-4" /> New workflow
          </Button>
        }
      />
      {creating && <NewWorkflowForm onCancel={() => setCreating(false)} />}
      {data.length === 0 ? (
        <EmptyState icon={<Workflow className="size-6" />} title="No workflows yet">
          Create one to start building. If you expected to see workflows here, ask an admin for access.
        </EmptyState>
      ) : (
        <Card className="divide-y divide-border">
          {data.map((w) => (
            <WorkflowRow key={w.id} workflow={w} />
          ))}
        </Card>
      )}
    </>
  )
}

function WorkflowRow({ workflow }: { workflow: WorkflowSummary }) {
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId: workflow.id }}
      className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
    >
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <Workflow className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{workflow.name}</div>
        <div className="truncate font-mono text-xs text-muted">{workflow.slug}</div>
      </div>
      {workflow.liveReleaseId ? <Badge tone="success">Live</Badge> : <Badge>Draft only</Badge>}
      <Badge tone="accent">{LEVELS[workflow.level]}</Badge>
    </Link>
  )
}

function NewWorkflowForm({ onCancel }: { onCancel: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const create = useMutation(
    trpc.workflows.create.mutationOptions({
      onSuccess: async (workflow) => {
        await queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() })
        await navigate({ to: '/workflows/$workflowId', params: { workflowId: workflow.id } })
      },
    }),
  )

  return (
    <Card className="mb-6 p-5">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate({ name, slug })
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugEdited) setSlug(workflowSlug(e.target.value))
            }}
            placeholder="Sync orders"
          />
        </Field>
        <Field label="Slug" hint="Used in webhook URLs. It can't change later.">
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            className="font-mono"
            placeholder="sync-orders"
          />
        </Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name || !slug}>
            Create workflow
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <ErrorNote error={create.error} />
        </div>
      </form>
    </Card>
  )
}
