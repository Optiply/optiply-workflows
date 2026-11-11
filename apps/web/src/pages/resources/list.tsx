import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { FolderPlus, Plug, Plus, ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { FolderBrowser, FolderSelect, NewFolderDialog, useFolders, useOpenFolder } from '@/components/folders'
import { ProtectedBadge } from '@/components/git'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AccessEditor, LEVEL_LABELS, type ResourceSummary, TypeIcon } from './shared'

const appRoute = getRouteApi('/app')

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'r_$1')
    .slice(0, 63)
}

export function ResourcesPage() {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.resources.list.queryOptions())
  const { data: folders } = useFolders('resource')
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const [panel, setPanel] = useState<'none' | 'resource' | 'folder' | 'access'>('none')

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Resources"
        description="Connections to databases and APIs, configured separately for each environment."
        actions={
          data.canCreate && (
            <>
              {me.isAdmin && (
                <Button onClick={() => setPanel('access')}>
                  <ShieldCheck className="size-4" /> Access to all resources
                </Button>
              )}
              <Button onClick={() => setPanel('folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
              <Button variant="primary" onClick={() => setPanel('resource')}>
                <Plus className="size-4" /> New resource
              </Button>
            </>
          )
        }
      />

      {panel === 'resource' && <NewResourceForm onDone={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderDialog type="resource" onDone={() => setPanel('none')} />}
      {panel === 'access' && (
        <Dialog title="Access to all resources" className="max-w-2xl" onClose={() => setPanel('none')}>
          <p className="mb-4 text-sm text-muted">
            Grants here apply to every resource, including new ones. Edit on all environments also lets a
            group create resources and folders.
          </p>
          <AccessEditor target={{ objectType: 'resource', objectId: null }} />
        </Dialog>
      )}

      {data.resources.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<Plug className="size-6" />} title="No resources yet">
          {data.canCreate
            ? 'Add a database (Postgres, MySQL or BigQuery) or a REST API to query it from workflows.'
            : 'Nothing has been shared with you yet. Ask an admin for access to a resource.'}
        </EmptyState>
      ) : (
        <FolderBrowser type="resource" items={data.resources} listKey={trpc.resources.list.queryKey()}>
          {(r) => <ResourceRow key={r.id} resource={r} environments={environments ?? []} />}
        </FolderBrowser>
      )}
    </>
  )
}

function ResourceRow({
  resource,
  environments,
}: {
  resource: ResourceSummary
  environments: { id: string; name: string }[]
}) {
  return (
    <Link
      to="/resources/$resourceId"
      params={{ resourceId: resource.id }}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/60"
    >
      <TypeIcon type={resource.type} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {resource.name}
          {resource.systemKind && (
            <Badge tone="accent" className="ml-2">
              Built-in
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-xs text-muted">{resource.slug}</div>
      </div>
      {resource.gitProtected && <ProtectedBadge />}
      <div className="flex gap-1.5">
        {resource.environments
          .filter((e) => e.level)
          .map((e) => (
            <Badge
              key={e.environmentId}
              tone={e.configured ? 'success' : 'neutral'}
              title={`${e.configured ? 'Configured' : 'Not configured'} · ${LEVEL_LABELS[e.level!]} access`}
            >
              {environments.find((x) => x.id === e.environmentId)?.name ?? '…'}
            </Badge>
          ))}
      </div>
    </Link>
  )
}

function NewResourceForm({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: types } = useQuery(trpc.resources.types.queryOptions())
  const openFolder = useOpenFolder('resource').id
  // In the folder open in the list, to begin with.
  const [form, setForm] = useState({ type: 'postgres', name: '', slug: '', folderId: openFolder ?? '' })
  const [slugTouched, setSlugTouched] = useState(false)
  const create = useMutation(
    trpc.resources.create.mutationOptions({
      onSuccess: async (resource) => {
        await queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() })
        onDone()
        await navigate({ to: '/resources/$resourceId', params: { resourceId: resource.id } })
      },
    }),
  )
  const submit = () =>
    form.name &&
    form.slug &&
    create.mutate({ type: form.type, name: form.name, slug: form.slug, folderId: form.folderId || null })
  const id = useId()
  return (
    <Dialog
      title="New resource"
      onClose={onDone}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={id}
            variant="primary"
            loading={create.isPending}
            disabled={!form.name || !form.slug}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {['Databases', 'APIs', 'Storage', 'Messaging', 'Services', 'AI'].map((group) => (
              <optgroup key={group} label={group}>
                {types
                  ?.filter((t) => t.group === group)
                  .map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input
            autoFocus
            value={form.name}
            placeholder="Orders database"
            onChange={(e) =>
              setForm({
                ...form,
                name: e.target.value,
                slug: slugTouched ? form.slug : slugify(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Slug" hint="How workflows refer to it. It can't change later.">
          <Input
            className="font-mono"
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true)
              setForm({ ...form, slug: e.target.value })
            }}
          />
        </Field>
        <Field label="Folder">
          <FolderSelect
            type="resource"
            value={form.folderId || null}
            onChange={(folderId) => setForm({ ...form, folderId: folderId ?? '' })}
          />
        </Field>
        <ErrorNote error={create.error} />
      </form>
    </Dialog>
  )
}
