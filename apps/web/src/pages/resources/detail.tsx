import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Spinner, Tabs } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { Playground } from './playground'
import { SettingsPanel } from './settings-forms'
import { AccessEditor, atLeast, type Level, LevelBadge, type ResourceDetail, TypeIcon } from './shared'

const route = getRouteApi('/app/resources/$resourceId')

type Tab = 'query' | 'settings' | 'access'

export function ResourceDetailPage() {
  const { resourceId } = route.useParams()
  const trpc = useTRPC()
  const { data: resource, isLoading, error } = useQuery(trpc.resources.get.queryOptions({ id: resourceId }))
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  // Until the user picks a tab: Settings while the environment isn't configured, otherwise Query.
  const [chosenTab, setTab] = useState<Tab | null>(null)
  const [envId, setEnvId] = useState<string | null>(null)

  if (isLoading) return <Spinner />
  if (!resource) return <ErrorNote error={error} />

  const visible = resource.environments
  const current = visible.find((e) => e.environmentId === envId) ?? visible[0]
  const envName = (id: string) => environments?.find((e) => e.id === id)?.name ?? '…'
  const envColor = (id: string) => environments?.find((e) => e.id === id)?.color ?? '#64748b'
  const owns = resource.level === 'own'
  const tab: Tab = chosenTab ?? (current?.config ? 'query' : 'settings')

  return (
    <div className="space-y-5">
      <Link to="/resources" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All resources
      </Link>
      <div className="flex items-start gap-3">
        <TypeIcon type={resource.type} className="size-10" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{resource.name}</h1>
          <p className="font-mono text-xs text-muted">{resource.slug}</p>
          {resource.description && <p className="mt-1 text-sm text-muted">{resource.description}</p>}
        </div>
        {owns && !resource.systemKind && <DeleteResource resource={resource} />}
      </div>

      {current && (
        <div className="flex flex-wrap items-center gap-2">
          {visible.map((e) => (
            <button
              key={e.environmentId}
              type="button"
              onClick={() => setEnvId(e.environmentId)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                e.environmentId === current.environmentId
                  ? 'border-accent bg-accent-soft font-medium text-accent'
                  : 'border-border bg-surface text-muted hover:text-ink',
              )}
            >
              <span className="size-2 rounded-full" style={{ background: envColor(e.environmentId) }} />
              {envName(e.environmentId)}
              {!e.config && <span className="text-xs">(not configured)</span>}
            </button>
          ))}
          <span className="ml-2 text-xs text-muted">
            Your access here: <LevelBadge level={current.level as Level} />
          </span>
        </div>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'query', label: 'Query' },
          { value: 'settings', label: 'Settings' },
          ...(owns ? [{ value: 'access' as const, label: 'Access' }] : []),
        ]}
      />

      {current && tab === 'query' && (
        <Playground key={current.environmentId} resource={resource} environmentId={current.environmentId} />
      )}
      {current && tab === 'settings' && resource.systemKind && (
        <BuiltInSettings
          environmentSlug={environments?.find((e) => e.id === current.environmentId)?.slug}
          user={typeof current.config?.user === 'string' ? current.config.user : undefined}
        />
      )}
      {current && tab === 'settings' && !resource.systemKind && (
        <div className="space-y-6">
          {atLeast(resource.level as Level | null, 'edit') && <GeneralCard resource={resource} />}
          <SettingsPanel
            // Keyed by environment only: remounting after a save would drop the "Saved" confirmation.
            key={current.environmentId}
            resource={resource}
            environmentId={current.environmentId}
            canEdit={atLeast(current.level as Level, 'edit')}
            onSaved={() => setTab('settings')}
          />
        </div>
      )}
      {tab === 'access' && owns && (
        <AccessEditor target={{ objectType: 'resource', objectId: resource.id }} />
      )}
    </div>
  )
}

/** The built-in database resource: the platform sets it up per environment, so there's nothing to edit here. */
function BuiltInSettings({ environmentSlug, user }: { environmentSlug?: string; user?: string }) {
  return (
    <Card className="space-y-3 p-5 text-sm">
      <h2 className="font-semibold">
        Built-in{' '}
        <Badge tone="accent" className="ml-1">
          managed by the platform
        </Badge>
      </h2>
      <p className="text-muted">
        This resource reaches the tables of the managed database. Each environment has its own tables, and
        queries run as that environment's own database user
        {user ? (
          <>
            {' '}
            (<code className="text-xs">{user}</code>)
          </>
        ) : null}
        , which can't reach anything else. Its settings and password are kept up to date by the platform.
      </p>
      <p className="text-muted">
        Who may use it is set on the Access tab: Use covers the tables, their rows and SQL.
      </p>
      <Link
        to="/database"
        search={{ env: environmentSlug }}
        className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
      >
        Open the tables on the Database page
      </Link>
    </Card>
  )
}

function GeneralCard({ resource }: { resource: ResourceDetail }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: folders } = useQuery(trpc.folders.list.queryOptions())
  const [form, setForm] = useState({
    name: resource.name,
    description: resource.description ?? '',
    folderId: resource.folderId ?? '',
  })
  const update = useMutation(
    trpc.resources.update.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.resources.get.queryKey({ id: resource.id }) }),
          queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() }),
        ]),
    }),
  )
  const dirty =
    form.name !== resource.name ||
    form.description !== (resource.description ?? '') ||
    form.folderId !== (resource.folderId ?? '')
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-semibold">
        General <Badge className="ml-1">all environments</Badge>
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Folder">
          <Select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}>
            <option value="">None</option>
            {folders?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorNote error={update.error} />
      <Button
        disabled={!dirty || !form.name.trim()}
        loading={update.isPending}
        onClick={() =>
          update.mutate({
            id: resource.id,
            name: form.name,
            description: form.description || null,
            folderId: form.folderId || null,
          })
        }
      >
        Save details
      </Button>
    </Card>
  )
}

function DeleteResource({ resource }: { resource: ResourceDetail }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation(
    trpc.resources.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() })
        await navigate({ to: '/resources' })
      },
    }),
  )
  return (
    <div className="space-y-2 text-right">
      <Button
        variant="danger"
        size="sm"
        loading={remove.isPending}
        onClick={() => {
          if (
            confirm(`Delete "${resource.name}" and its settings in every environment? This can't be undone.`)
          ) {
            remove.mutate({ id: resource.id })
          }
        }}
      >
        Delete resource
      </Button>
      <ErrorNote error={remove.error} />
    </div>
  )
}
