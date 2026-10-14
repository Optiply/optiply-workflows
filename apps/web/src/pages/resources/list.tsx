import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { Folder, FolderPlus, Plug, Plus, ShieldCheck, Trash2 } from 'lucide-react'
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
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery(trpc.resources.list.queryOptions())
  const { data: folders } = useQuery(trpc.folders.list.queryOptions())
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const [panel, setPanel] = useState<'none' | 'resource' | 'folder' | 'access'>('none')
  const [folderAccess, setFolderAccess] = useState<string | null>(null)

  const deleteFolder = useMutation(
    trpc.folders.delete.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.folders.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() }),
        ]),
    }),
  )

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  const groups = [
    ...(folders ?? []).map((f) => ({ folder: f, items: data.resources.filter((r) => r.folderId === f.id) })),
    {
      folder: null,
      items: data.resources.filter((r) => !r.folderId || !folders?.some((f) => f.id === r.folderId)),
    },
  ].filter((g) => g.items.length > 0 || (g.folder && data.canCreate))

  return (
    <>
      <PageHeader
        title="Resources"
        description="Connections to databases and APIs, configured separately for each environment."
        actions={
          data.canCreate && (
            <>
              {me.isAdmin && (
                <Button onClick={() => setPanel(panel === 'access' ? 'none' : 'access')}>
                  <ShieldCheck className="size-4" /> Access to all resources
                </Button>
              )}
              <Button onClick={() => setPanel(panel === 'folder' ? 'none' : 'folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
              <Button variant="primary" onClick={() => setPanel(panel === 'resource' ? 'none' : 'resource')}>
                <Plus className="size-4" /> New resource
              </Button>
            </>
          )
        }
      />

      {panel === 'resource' && <NewResourceForm onDone={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderForm onDone={() => setPanel('none')} />}
      {panel === 'access' && (
        <Card className="mb-6 p-5">
          <h2 className="mb-1 font-semibold">Access to all resources</h2>
          <p className="mb-4 text-sm text-muted">
            Grants here apply to every resource, including new ones. Edit on all environments also lets a
            group create resources and folders.
          </p>
          <AccessEditor target={{ objectType: 'resource', objectId: null }} />
        </Card>
      )}

      {data.resources.length === 0 && groups.length === 0 ? (
        <EmptyState icon={<Plug className="size-6" />} title="No resources yet">
          {data.canCreate
            ? 'Add a database (Postgres or MySQL) or a REST API to query it from workflows.'
            : 'Nothing has been shared with you yet. Ask an admin for access to a resource.'}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <ErrorNote error={deleteFolder.error} />
          {groups.map(({ folder, items }) => (
            <section key={folder?.id ?? 'none'}>
              {(folder || (folders?.length ?? 0) > 0) && (
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted">
                  <Folder className="size-4" /> {folder?.name ?? 'Not in a folder'}
                  {folder && me.isAdmin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setFolderAccess(folderAccess === folder.id ? null : folder.id)}
                    >
                      Access
                    </Button>
                  )}
                  {folder && data.canCreate && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Delete folder"
                      onClick={() => {
                        if (confirm(`Delete folder "${folder.name}"? Its resources move out of it.`)) {
                          deleteFolder.mutate({ id: folder.id })
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              )}
              {folder && folderAccess === folder.id && (
                <Card className="mb-3 p-4">
                  <p className="mb-3 text-sm text-muted">
                    Grants on this folder apply to every resource inside it.
                  </p>
                  <AccessEditor target={{ objectType: 'folder', objectId: folder.id }} />
                </Card>
              )}
              <Card className="divide-y divide-border">
                {items.length === 0 && <p className="px-4 py-4 text-sm text-muted">Empty folder.</p>}
                {items.map((r) => (
                  <ResourceRow key={r.id} resource={r} environments={environments ?? []} />
                ))}
              </Card>
            </section>
          ))}
        </div>
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
      className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
    >
      <TypeIcon type={resource.type} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{resource.name}</div>
        <div className="truncate font-mono text-xs text-muted">{resource.slug}</div>
      </div>
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
  const { data: folders } = useQuery(trpc.folders.list.queryOptions())
  const [form, setForm] = useState({ type: 'postgres', name: '', slug: '', folderId: '' })
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
  return (
    <Card className="mb-6 space-y-4 p-5">
      <h2 className="font-semibold">New resource</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {types?.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
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
      <ErrorNote error={create.error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={!form.name || !form.slug}
          onClick={() =>
            create.mutate({
              type: form.type,
              name: form.name,
              slug: form.slug,
              folderId: form.folderId || null,
            })
          }
        >
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

function NewFolderForm({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation(
    trpc.folders.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.folders.list.queryKey() })
        onDone()
      },
    }),
  )
  return (
    <Card className="mb-6 space-y-3 p-5">
      <h2 className="font-semibold">New folder</h2>
      <div className="flex max-w-md gap-2">
        <Input autoFocus value={name} placeholder="Finance" onChange={(e) => setName(e.target.value)} />
        <Button
          variant="primary"
          disabled={!name.trim()}
          loading={create.isPending}
          onClick={() => create.mutate({ name })}
        >
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </Card>
  )
}
