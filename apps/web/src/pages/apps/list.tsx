import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderPlus, GitBranch, LayoutGrid, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { FolderBrowser, FolderSelect, NewFolderForm, useFolders, useOpenFolder } from '@/components/folders'
import { ProtectDialog, ProtectedBadge, useGitInfo } from '@/components/git'
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
  const { data: folders } = useFolders('app')
  const [panel, setPanel] = useState<'none' | 'app' | 'folder'>('none')

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Apps"
        description="Internal tools built from components and queries: tables, forms and charts on your data."
        actions={
          <>
            {folders?.canManage && (
              <Button onClick={() => setPanel(panel === 'folder' ? 'none' : 'folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
            )}
            <Button variant="primary" onClick={() => setPanel(panel === 'app' ? 'none' : 'app')}>
              <Plus className="size-4" /> New app
            </Button>
          </>
        }
      />
      {panel === 'app' && <NewAppForm onCancel={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderForm type="app" onDone={() => setPanel('none')} />}
      {data.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<LayoutGrid className="size-6" />} title="No apps yet">
          Create one to start building. If you expected to see apps here, ask an admin for access.
        </EmptyState>
      ) : (
        <FolderBrowser type="app" items={data} listKey={trpc.apps.list.queryKey()}>
          {(a) => <AppRow key={a.id} app={a} hasFolders={!!folders?.folders.length} />}
        </FolderBrowser>
      )}
    </>
  )
}

/** An app; owners can move it between folders here (that changes who can reach it). */
function AppRow({ app, hasFolders }: { app: AppSummary; hasFolders: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const move = useMutation(
    trpc.apps.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() }),
    }),
  )
  const canEdit = app.level === 'edit' || app.level === 'own'
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
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
      {app.gitProtected && <ProtectedBadge />}
      {app.liveReleaseId ? <Badge tone="success">Live</Badge> : <Badge>Not published</Badge>}
      <Badge tone="accent">{LEVELS[app.level]}</Badge>
      {git?.configured && app.level === 'own' && !app.gitProtected && (
        <Button
          size="icon"
          variant="ghost"
          title={`Protect ${app.name} in Git`}
          onClick={() => setProtecting(true)}
        >
          <GitBranch className="size-4" />
        </Button>
      )}
      {protecting && <ProtectDialog kind="app" object={app} onClose={() => setProtecting(false)} />}
      {hasFolders && app.level === 'own' && (
        <FolderSelect
          type="app"
          label={`Folder of ${app.name}`}
          className="w-40"
          value={app.folderId}
          onChange={(folderId) => move.mutate({ id: app.id, folderId })}
        />
      )}
      <ErrorNote error={move.error} />
      {canEdit && (
        <Link
          to="/apps/$slug/edit"
          params={{ slug: app.slug }}
          title={`Edit ${app.name}`}
          className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-ink"
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
  // In the folder open in the list, to begin with.
  const [folderId, setFolderId] = useState<string | null>(useOpenFolder('app').id)
  const [inGit, setInGit] = useState(false)
  const { data: folders } = useFolders('app')
  const { data: git } = useGitInfo()
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
          create.mutate({ name, slug, folderId, ...(inGit ? { protected: true } : {}) })
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
        {!!folders?.folders.length && (
          <Field label="Folder">
            <FolderSelect type="app" value={folderId} onChange={setFolderId} />
          </Field>
        )}
        {git?.configured && (
          <div className="sm:col-span-2">
            <Checkbox
              label="Create it in Git: edited on branches and reviewed before it goes live"
              checked={inGit}
              onChange={(e) => setInGit(e.target.checked)}
            />
          </div>
        )}
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
