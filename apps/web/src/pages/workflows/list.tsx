import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowUpDown,
  CalendarClock,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  GitBranch,
  GripVertical,
  Layers,
  Plus,
  Search,
  Trash2,
  Webhook,
  Workflow,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { FolderTree, WORKFLOW_DRAG_TYPE } from '@/components/folder-tree'
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
  Select,
  Spinner,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import {
  isSortKey,
  matchesSearch,
  SORTS,
  type SortKey,
  sortWorkflows,
  timeAgo,
  triggerLabel,
} from './list-model'

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
  const { data: folders } = useFolders('workflow')
  const [panel, setPanel] = useState<'none' | 'workflow' | 'folder'>('none')
  const [query, setQuery] = useState('')
  const [sort, chooseSort] = useStoredChoice<SortKey>('ow.workflows.sort', isSortKey, 'name')
  const sorted = useMemo(() => sortWorkflows(data ?? [], sort), [data, sort])
  const searching = query.trim() !== ''
  const found = searching ? sorted.filter((w) => matchesSearch(w, query)) : []
  const hasFolders = !!folders?.folders.length
  const { id: openId, open } = useOpenFolder('workflow')
  const queryClient = useQueryClient()
  // A workflow dropped on the tree.
  const move = useMutation(
    trpc.workflows.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() }),
    }),
  )
  const dropWorkflow = (workflowId: string, folderId: string | null) => {
    const workflow = data?.find((w) => w.id === workflowId)
    if (workflow && workflow.level === 'own' && workflow.folderId !== folderId)
      move.mutate({ id: workflowId, folderId })
  }

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Automated backend processes: blocks that query resources, run code and branch."
        actions={
          <>
            {folders?.canManage && (
              <Button onClick={() => setPanel(panel === 'folder' ? 'none' : 'folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
            )}
            <Button variant="primary" onClick={() => setPanel(panel === 'workflow' ? 'none' : 'workflow')}>
              <Plus className="size-4" /> New workflow
            </Button>
          </>
        }
      />
      {panel === 'workflow' && <NewWorkflowForm onCancel={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderForm type="workflow" onDone={() => setPanel('none')} />}
      {data.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<Workflow className="size-6" />} title="No workflows yet">
          Create one to start building. If you expected to see workflows here, ask an admin for access.
        </EmptyState>
      ) : (
        <div className={cn(hasFolders && 'grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]')}>
          {hasFolders && (
            <Card className="p-2 lg:sticky lg:top-4">
              <FolderTree
                noun={['workflow', 'workflows']}
                dragType={WORKFLOW_DRAG_TYPE}
                folders={folders?.folders ?? []}
                items={data}
                openId={searching ? undefined : openId}
                canManage={!!folders?.canManage}
                onOpen={(id) => {
                  setQuery('')
                  open(id)
                }}
                onDropItem={dropWorkflow}
              />
              <ErrorNote error={move.error} />
            </Card>
          )}
          <div className="min-w-0 space-y-4">
            <ListToolbar
              noun="workflows"
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
                    ? `No workflows match “${query.trim()}”.`
                    : `${found.length} workflow${found.length === 1 ? '' : 's'} in every folder`}
                </p>
                {found.length > 0 && (
                  <Card className="divide-y divide-border">
                    {found.map((w) => (
                      <WorkflowRow
                        key={w.id}
                        workflow={w}
                        hasFolders={hasFolders}
                        folder={
                          hasFolders
                            ? (folderPath(folders?.folders ?? [], w.folderId) ?? 'Not in a folder')
                            : null
                        }
                      />
                    ))}
                  </Card>
                )}
              </section>
            ) : (
              <FolderBrowser type="workflow" items={sorted} listKey={trpc.workflows.list.queryKey()}>
                {(w) => <WorkflowRow key={w.id} workflow={w} hasFolders={hasFolders} />}
              </FolderBrowser>
            )}
          </div>
        </div>
      )}
    </>
  )
}

const RUN_DOT: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-danger',
  errored: 'bg-danger',
  running: 'bg-accent animate-pulse',
  queued: 'bg-muted',
  waiting: 'bg-warning',
  cancelled: 'bg-muted',
  interrupted: 'bg-muted',
}

/** The live release's enabled triggers, one icon per kind with its count. */
function Triggers({ triggers }: { triggers: WorkflowSummary['triggers'] }) {
  if (!triggers.length) return null
  return (
    <span className="flex items-center gap-2 text-xs text-muted" data-testid="workflow-triggers">
      {triggers.map((t) => {
        const Icon = t.kind === 'schedule' ? CalendarClock : t.kind === 'webhook' ? Webhook : Layers
        const label = triggerLabel(t.kind, t.count)
        return (
          <span
            key={t.kind}
            role="img"
            className="flex items-center gap-0.5"
            title={label}
            aria-label={label}
          >
            <Icon className="size-3.5" />
            {t.count > 1 && <span>{t.count}</span>}
          </span>
        )
      })}
    </span>
  )
}

/** The latest run: a status dot, how long ago and where; opens it in the editor. */
function LastRun({ workflow }: { workflow: WorkflowSummary }) {
  const run = workflow.lastRun
  if (!run) return <span className="w-36 text-xs text-muted">Never run</span>
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId: workflow.id }}
      search={{ run: run.id }}
      className="flex w-36 items-center gap-1.5 text-xs text-muted hover:text-ink"
      title={`Last run ${run.status}, ${new Date(run.createdAt).toLocaleString()}${run.environment ? ` in ${run.environment}` : ''} (${run.triggerType})`}
      data-testid="workflow-last-run"
    >
      <span className={cn('size-2 shrink-0 rounded-full', RUN_DOT[run.status] ?? 'bg-muted')} />
      <span className="truncate">
        {run.status} {timeAgo(run.createdAt)}
      </span>
    </Link>
  )
}

/** A workflow; owners can move it between folders here (that changes who can reach it). */
function WorkflowRow({
  workflow,
  hasFolders,
  folder = null,
}: {
  workflow: WorkflowSummary
  hasFolders: boolean
  /** In search results: the folder it's in. */
  folder?: string | null
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [moving, setMoving] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() })
  const remove = useMutation(trpc.workflows.delete.mutationOptions({ onSuccess: refresh }))
  // Owners move workflows between folders (that changes who can reach them): dragged onto the tree, or Move.
  const movable = hasFolders && workflow.level === 'own'
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging onto the tree is the mouse's shortcut; Move does it by keyboard
    <div
      className="group flex items-center gap-3 px-4 py-3 hover:bg-canvas"
      data-testid={`workflow-${workflow.slug}`}
      draggable={movable}
      onDragStart={
        movable
          ? (e) => {
              e.dataTransfer.setData(WORKFLOW_DRAG_TYPE, workflow.id)
              e.dataTransfer.setData('text/plain', workflow.name)
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
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <span className="rounded-md bg-accent-soft p-1.5 text-accent">
          <Workflow className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{workflow.name}</span>
            <Triggers triggers={workflow.triggers} />
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <span className="truncate font-mono">{workflow.slug}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0" title={new Date(workflow.updatedAt).toLocaleString()}>
              edited {timeAgo(workflow.updatedAt)}
              {workflow.updatedByName && ` by ${workflow.updatedByName}`}
            </span>
            {folder && (
              <>
                <span aria-hidden>·</span>
                <span className="flex min-w-0 items-center gap-1" data-testid="workflow-folder">
                  <Folder className="size-3 shrink-0" />
                  <span className="truncate">{folder}</span>
                </span>
              </>
            )}
          </div>
        </div>
        <LastRun workflow={workflow} />
        {workflow.gitProtected && <ProtectedBadge />}
        {workflow.liveReleaseId ? <Badge tone="success">Live</Badge> : <Badge>Draft only</Badge>}
        <Badge tone="accent">{LEVELS[workflow.level]}</Badge>
      </Link>
      {git?.configured && workflow.level === 'own' && !workflow.gitProtected && (
        <Button
          size="icon"
          variant="ghost"
          title={`Protect ${workflow.name} in Git`}
          onClick={() => setProtecting(true)}
        >
          <GitBranch className="size-4" />
        </Button>
      )}
      {protecting && <ProtectDialog kind="workflow" object={workflow} onClose={() => setProtecting(false)} />}
      <Button
        size="icon"
        variant="ghost"
        title={`Duplicate ${workflow.name}`}
        data-testid={`duplicate-${workflow.slug}`}
        onClick={() => setDuplicating(true)}
      >
        <Copy className="size-4" />
      </Button>
      {duplicating && <DuplicateDialog workflow={workflow} onClose={() => setDuplicating(false)} />}
      {workflow.level === 'own' && !workflow.gitProtected && (
        <Button
          size="icon"
          variant="ghost"
          title={`Delete ${workflow.name}`}
          data-testid={`delete-${workflow.slug}`}
          loading={remove.isPending}
          onClick={async () => {
            if (
              await confirmDialog(
                `Delete ${workflow.name} with its releases and runs? Its schedules, webhooks and queue triggers stop at once. This can't be undone.`,
                { danger: true, confirm: 'Delete' },
              )
            ) {
              remove.mutate({ id: workflow.id })
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
      {movable && (
        <Button
          size="icon"
          variant="ghost"
          title={`Move ${workflow.name} to a folder`}
          data-testid={`move-${workflow.slug}`}
          onClick={() => setMoving(true)}
        >
          <FolderInput className="size-4" />
        </Button>
      )}
      {moving && <MoveDialog workflow={workflow} onClose={() => setMoving(false)} />}
      <ErrorNote error={remove.error} />
    </div>
  )
}

/** Moves a workflow to another folder: what dragging it onto the folder tree does, without a mouse. */
function MoveDialog({ workflow, onClose }: { workflow: WorkflowSummary; onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [folderId, setFolderId] = useState<string | null>(workflow.folderId)
  const move = useMutation(
    trpc.workflows.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() })
        onClose()
      },
    }),
  )
  return (
    <Dialog
      title={`Move ${workflow.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={move.isPending}
            disabled={folderId === workflow.folderId}
            data-testid="move-confirm"
            onClick={() => move.mutate({ id: workflow.id, folderId })}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FolderSelect
          type="workflow"
          label={`Folder of ${workflow.name}`}
          value={folderId}
          onChange={setFolderId}
        />
        <p className="text-sm text-muted">
          Grants on a folder reach the workflows in it, so moving changes who can see and run it. You can also
          drag a workflow onto a folder in the tree.
        </p>
        <ErrorNote error={move.error} />
      </div>
    </Dialog>
  )
}

/**
 * A copy of the workflow's draft under a new name and slug, then opened. Its triggers come along turned off, so it
 * doesn't fire (or share a queue with the original) until they're turned on.
 */
function DuplicateDialog({ workflow, onClose }: { workflow: WorkflowSummary; onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(`${workflow.name} (copy)`)
  const [slug, setSlug] = useState(`${workflow.slug}-copy`)
  const duplicate = useMutation(
    trpc.workflows.duplicate.mutationOptions({
      onSuccess: async (copy) => {
        await queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() })
        onClose()
        await navigate({ to: '/workflows/$workflowId', params: { workflowId: copy.id } })
      },
    }),
  )
  return (
    <Dialog
      title={`Duplicate ${workflow.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={duplicate.isPending}
            disabled={!name || !slug}
            data-testid="duplicate-confirm"
            onClick={() => duplicate.mutate({ id: workflow.id, name, slug })}
          >
            Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The copy has the draft, with its triggers turned off: turn them on in the copy's start block when it
          should run on its own. Releases and run history stay with the original.
        </p>
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Slug" hint="Used in webhook URLs. It can't change later.">
          <Input value={slug} className="font-mono" onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <ErrorNote error={duplicate.error} />
      </div>
    </Dialog>
  )
}

function NewWorkflowForm({ onCancel }: { onCancel: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  // In the folder open in the list, to begin with.
  const [folderId, setFolderId] = useState<string | null>(useOpenFolder('workflow').id)
  const [inGit, setInGit] = useState(false)
  const { data: folders } = useFolders('workflow')
  const { data: git } = useGitInfo()
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
        {!!folders?.folders.length && (
          <Field label="Folder">
            <FolderSelect type="workflow" value={folderId} onChange={setFolderId} />
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
