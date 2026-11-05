import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Folder,
  FolderInput,
  FolderPlus,
  GitBranch,
  GripVertical,
  LayoutGrid,
  Pencil,
  Plus,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { APP_DRAG_TYPE, FolderTree } from '@/components/folder-tree'
import {
  FolderBrowser,
  FolderSelect,
  folderPath,
  NewFolderForm,
  useFolders,
  useOpenFolder,
} from '@/components/folders'
import { ProtectDialog, ProtectedBadge, useGitInfo } from '@/components/git'
import { ListToolbar, useStoredChoice } from '@/components/list-toolbar'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui'
import { matchesSearch, sortListed, timeAgo } from '@/lib/list-model'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { workflowSlug } from '../workflows/list'

type AppSummary = RouterOutputs['apps']['list'][number]

const LEVELS = { use: 'Can use', edit: 'Can edit', own: 'Owner' } as const

type SortKey = 'name' | 'edited' | 'published'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'edited', label: 'Last edited' },
  { key: 'published', label: 'Last published' },
]

const isSortKey = (value: unknown): value is SortKey => SORTS.some((s) => s.key === value)

/** Name A–Z; last edited and last published newest first (never published last), then by name. */
export function sortApps<T extends AppSummary>(items: readonly T[], key: SortKey): T[] {
  return sortListed(items, key === 'published' ? 'recent' : key, (a) => a.liveRelease?.publishedAt)
}

/**
 * The apps the user can open or build (session 40, as the Workflows page): a folder tree that takes dragged apps,
 * a search across every folder and a remembered sort.
 */
export function AppsPage() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery(trpc.apps.list.queryOptions())
  const { data: folders } = useFolders('app')
  const [panel, setPanel] = useState<'none' | 'app' | 'folder'>('none')
  const [query, setQuery] = useState('')
  const [sort, chooseSort] = useStoredChoice<SortKey>('ow.apps.sort', isSortKey, 'name')
  const sorted = useMemo(() => sortApps(data ?? [], sort), [data, sort])
  const searching = query.trim() !== ''
  const found = searching ? sorted.filter((a) => matchesSearch(a, query)) : []
  const hasFolders = !!folders?.folders.length
  const { id: openId, open } = useOpenFolder('app')
  // An app dropped on the tree.
  const move = useMutation(
    trpc.apps.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() }),
    }),
  )
  const dropApp = (appId: string, folderId: string | null) => {
    const app = data?.find((a) => a.id === appId)
    if (app && app.level === 'own' && app.folderId !== folderId) move.mutate({ id: appId, folderId })
  }

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
        <div className={cn(hasFolders && 'grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]')}>
          {hasFolders && (
            <Card className="p-2 lg:sticky lg:top-4">
              <FolderTree
                noun={['app', 'apps']}
                dragType={APP_DRAG_TYPE}
                folders={folders?.folders ?? []}
                items={data}
                openId={searching ? undefined : openId}
                canManage={!!folders?.canManage}
                onOpen={(id) => {
                  setQuery('')
                  open(id)
                }}
                onDropItem={dropApp}
              />
              <ErrorNote error={move.error} />
            </Card>
          )}
          <div className="min-w-0 space-y-4">
            <ListToolbar
              noun="apps"
              query={query}
              onQuery={setQuery}
              sort={sort}
              sorts={SORTS}
              onSort={chooseSort}
            />
            {searching ? (
              <section aria-label="Search results">
                <p className="mb-2 text-sm text-muted">
                  {found.length === 0
                    ? `No apps match “${query.trim()}”.`
                    : `${found.length} app${found.length === 1 ? '' : 's'} in every folder`}
                </p>
                {found.length > 0 && (
                  <Card className="divide-y divide-border">
                    {found.map((a) => (
                      <AppRow
                        key={a.id}
                        app={a}
                        hasFolders={hasFolders}
                        folder={
                          hasFolders
                            ? (folderPath(folders?.folders ?? [], a.folderId) ?? 'Not in a folder')
                            : null
                        }
                      />
                    ))}
                  </Card>
                )}
              </section>
            ) : (
              <FolderBrowser type="app" items={sorted} listKey={trpc.apps.list.queryKey()}>
                {(a) => <AppRow key={a.id} app={a} hasFolders={hasFolders} />}
              </FolderBrowser>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** The live release: its version and when it was published. */
function Published({ app }: { app: AppSummary }) {
  const live = app.liveRelease
  if (!live) return <span className="w-36 text-xs text-muted">Never published</span>
  return (
    <span
      className="w-36 truncate text-xs text-muted"
      title={`v${live.version}, published ${new Date(live.publishedAt).toLocaleString()}`}
      data-testid="app-published"
    >
      v{live.version} · {timeAgo(live.publishedAt)}
    </span>
  )
}

/** An app; owners move it between folders (that changes who can reach it): dragged onto the tree, or Move. */
function AppRow({
  app,
  hasFolders,
  folder = null,
}: {
  app: AppSummary
  hasFolders: boolean
  /** In search results: the folder it's in. */
  folder?: string | null
}) {
  const canEdit = app.level === 'edit' || app.level === 'own'
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const [moving, setMoving] = useState(false)
  const movable = hasFolders && app.level === 'own'
  const body = (
    <>
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <LayoutGrid className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{app.name}</div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="truncate font-mono">{app.slug}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0" title={new Date(app.updatedAt).toLocaleString()}>
            edited {timeAgo(app.updatedAt)}
            {app.updatedByName && ` by ${app.updatedByName}`}
          </span>
          {folder && (
            <>
              <span aria-hidden>·</span>
              <span className="flex min-w-0 items-center gap-1" data-testid="app-folder">
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{folder}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <Published app={app} />
    </>
  )
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging onto the tree is the mouse's shortcut; Move does it by keyboard
    <div
      className="group flex items-center gap-3 px-4 py-3 hover:bg-canvas"
      data-testid={`app-${app.slug}`}
      draggable={movable}
      onDragStart={
        movable
          ? (e) => {
              e.dataTransfer.setData(APP_DRAG_TYPE, app.id)
              e.dataTransfer.setData('text/plain', app.name)
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
    >
      {movable && (
        <GripVertical
          className="-mr-2 -ml-2 size-4 shrink-0 cursor-grab text-muted opacity-0 group-hover:opacity-100"
          aria-hidden
        />
      )}
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
      {movable && (
        <Button
          size="icon"
          variant="ghost"
          title={`Move ${app.name} to a folder`}
          data-testid={`move-${app.slug}`}
          onClick={() => setMoving(true)}
        >
          <FolderInput className="size-4" />
        </Button>
      )}
      {moving && <MoveDialog app={app} onClose={() => setMoving(false)} />}
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

/** Moves an app to another folder: what dragging it onto the folder tree does, without a mouse. */
function MoveDialog({ app, onClose }: { app: AppSummary; onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [folderId, setFolderId] = useState<string | null>(app.folderId)
  const move = useMutation(
    trpc.apps.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() })
        onClose()
      },
    }),
  )
  return (
    <Dialog
      title={`Move ${app.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={move.isPending}
            disabled={folderId === app.folderId}
            data-testid="move-confirm"
            onClick={() => move.mutate({ id: app.id, folderId })}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FolderSelect type="app" label={`Folder of ${app.name}`} value={folderId} onChange={setFolderId} />
        <p className="text-sm text-muted">
          Grants on a folder reach the apps in it, so moving changes who can open and edit it. You can also
          drag an app onto a folder in the tree.
        </p>
        <ErrorNote error={move.error} />
      </div>
    </Dialog>
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
