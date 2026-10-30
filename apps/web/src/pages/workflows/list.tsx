import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Copy, FolderPlus, GitBranch, Plus, Trash2, Workflow } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { FolderBrowser, FolderSelect, NewFolderForm, useFolders, useOpenFolder } from '@/components/folders'
import { ProtectDialog, ProtectedBadge, useGitInfo } from '@/components/git'
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
  const { data: folders } = useFolders('workflow')
  const [panel, setPanel] = useState<'none' | 'workflow' | 'folder'>('none')

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
        <FolderBrowser type="workflow" items={data} listKey={trpc.workflows.list.queryKey()}>
          {(w) => <WorkflowRow key={w.id} workflow={w} hasFolders={!!folders?.folders.length} />}
        </FolderBrowser>
      )}
    </>
  )
}

/** A workflow; owners can move it between folders here (that changes who can reach it). */
function WorkflowRow({ workflow, hasFolders }: { workflow: WorkflowSummary; hasFolders: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.workflows.list.queryKey() })
  const move = useMutation(trpc.workflows.update.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.workflows.delete.mutationOptions({ onSuccess: refresh }))
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
      data-testid={`workflow-${workflow.slug}`}
    >
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <span className="rounded-md bg-accent-soft p-1.5 text-accent">
          <Workflow className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{workflow.name}</div>
          <div className="truncate font-mono text-xs text-muted">{workflow.slug}</div>
        </div>
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
      {hasFolders && workflow.level === 'own' && (
        <FolderSelect
          type="workflow"
          label={`Folder of ${workflow.name}`}
          className="w-40"
          value={workflow.folderId}
          onChange={(folderId) => move.mutate({ id: workflow.id, folderId })}
        />
      )}
      <ErrorNote error={move.error ?? remove.error} />
    </div>
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
