import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { LayoutGrid, Pencil, Plus } from 'lucide-react'
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
import { workflowSlug } from '../workflows/list'

type AppSummary = RouterOutputs['apps']['list'][number]

const LEVELS = { use: 'Can use', edit: 'Can edit', own: 'Owner' } as const

/** The apps the user can open or build. */
export function AppsPage() {
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.apps.list.queryOptions())
  const [creating, setCreating] = useState(false)

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Apps"
        description="Internal tools built from components and queries: tables, forms and charts on your data."
        actions={
          <Button variant="primary" onClick={() => setCreating(!creating)}>
            <Plus className="size-4" /> New app
          </Button>
        }
      />
      {creating && <NewAppForm onCancel={() => setCreating(false)} />}
      {data.length === 0 ? (
        <EmptyState icon={<LayoutGrid className="size-6" />} title="No apps yet">
          Create one to start building. If you expected to see apps here, ask an admin for access.
        </EmptyState>
      ) : (
        <Card className="divide-y divide-border">
          {data.map((a) => (
            <AppRow key={a.id} app={a} />
          ))}
        </Card>
      )}
    </>
  )
}

function AppRow({ app }: { app: AppSummary }) {
  const canEdit = app.level === 'edit' || app.level === 'own'
  const body = (
    <>
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <LayoutGrid className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{app.name}</div>
        <div className="truncate font-mono text-xs text-muted">{app.slug}</div>
      </div>
    </>
  )
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-canvas" data-testid={`app-${app.slug}`}>
      {app.liveReleaseId ? (
        <Link
          to="/apps/$slug/{-$page}"
          params={{ slug: app.slug }}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {body}
        </Link>
      ) : canEdit ? (
        <Link
          to="/apps/$slug/edit"
          params={{ slug: app.slug }}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
      )}
      {app.liveReleaseId ? <Badge tone="success">Live</Badge> : <Badge>Not published</Badge>}
      <Badge tone="accent">{LEVELS[app.level]}</Badge>
      {canEdit && (
        <Link
          to="/apps/$slug/edit"
          params={{ slug: app.slug }}
          title={`Edit ${app.name}`}
          className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
        >
          <Pencil className="size-4" />
        </Link>
      )}
    </div>
  )
}

function NewAppForm({ onCancel }: { onCancel: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const create = useMutation(
    trpc.apps.create.mutationOptions({
      onSuccess: async (app) => {
        await queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() })
        await navigate({ to: '/apps/$slug/edit', params: { slug: app.slug } })
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
            placeholder="Customer lookup"
          />
        </Field>
        <Field label="Slug" hint="The app's address: /apps/<slug>. It can't change later.">
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            className="font-mono"
            placeholder="customer-lookup"
          />
        </Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name || !slug}>
            Create app
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
