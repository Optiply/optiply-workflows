import type { BlockType, Diagnostic, WorkflowDefinition } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { TRPCClientError } from '@trpc/client'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { AlertCircle, ArrowLeft, CheckCircle2, LayoutGrid, Loader2, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { Badge, Button, ErrorNote, Spinner } from '@/components/ui'
import { errorMessage, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { Canvas, removeFrom } from './canvas'
import { ADDABLE, BLOCK_KINDS, newBlock, nextName } from './catalog'
import { autoLayout, NODE_WIDTH, positionsFor } from './layout'
import { problemsOf, type SaveStatus, useEditor } from './store'

const route = getRouteApi('/app/workflows/$workflowId')

/** How long the draft must be idle before it's saved. */
const AUTOSAVE_MS = 800

export function WorkflowEditorPage() {
  const { workflowId } = route.useParams()
  const trpc = useTRPC()
  const workflow = useQuery({ ...trpc.workflows.get.queryOptions({ id: workflowId }), staleTime: 0 })
  const load = useEditor((s) => s.load)
  const loadedId = useEditor((s) => s.workflowId)

  useEffect(() => {
    if (workflow.data) load(workflow.data.id, workflow.data.draftDefinition, workflow.data.draftRevision)
  }, [workflow.data, load])

  if (workflow.error) {
    return (
      <div className="p-8">
        <ErrorNote error={workflow.error} />
      </div>
    )
  }
  if (!workflow.data || loadedId !== workflow.data.id) return <Spinner />

  const canEdit = workflow.data.level !== 'use'
  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <Header name={workflow.data.name} slug={workflow.data.slug} canEdit={canEdit} />
        <ConflictBanner onReload={() => workflow.refetch()} />
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1" data-testid="canvas">
            <Canvas />
          </div>
          <SidePanel />
        </div>
      </div>
      {canEdit && <Autosave />}
    </ReactFlowProvider>
  )
}

function Header({ name, slug, canEdit }: { name: string; slug: string; canEdit: boolean }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <Link
        to="/workflows"
        className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
        title="Back"
      >
        <ArrowLeft className="size-4" />
      </Link>
      <div className="min-w-0">
        <div className="truncate font-semibold">{name}</div>
        <div className="truncate font-mono text-xs text-muted">{slug}</div>
      </div>
      <SaveIndicator />
      <div className="flex-1" />
      {canEdit ? <Toolbar /> : <Badge>Read only</Badge>}
    </header>
  )
}

function Toolbar() {
  const trpc = useTRPC()
  const update = useEditor((s) => s.update)
  const select = useEditor((s) => s.select)
  const selected = useEditor((s) => s.selected)
  const { data: resources } = useQuery(trpc.resources.list.queryOptions())
  const queryable = resources?.resources ?? []
  const { fitView } = useReactFlow()

  const add = (type: Exclude<BlockType, 'startTrigger'>) => {
    let added = ''
    update((def) => {
      added = nextName(
        type,
        def.blocks.map((b) => b.name),
      )
      const block = newBlock(type, added, queryable[0])
      const positions = positionsFor(def)
      // To the right of the selected block, or after the rightmost one.
      const anchor = selected && positions[selected]
      const x = anchor
        ? anchor.x + NODE_WIDTH + 80
        : Math.max(0, ...Object.values(positions).map((p) => p.x)) + NODE_WIDTH + 80
      const y = anchor ? anchor.y : 0
      const edges =
        selected && def.blocks.some((b) => b.name === selected && b.type !== 'branch')
          ? [...def.edges, { from: selected, port: 'out', to: added }]
          : def.edges
      return {
        ...def,
        blocks: [...def.blocks, block],
        edges,
        layout: { ...def.layout, blocks: { ...positions, [added]: { x, y } } },
      }
    })
    select(added)
    // Keep the new block in view once React Flow has measured it.
    setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 50)
  }

  return (
    <div className="flex items-center gap-1.5">
      {ADDABLE.map((type) => {
        const kind = BLOCK_KINDS[type]
        const Icon = kind.icon
        const disabled = type === 'resourceQuery' && queryable.length === 0
        return (
          <Button
            key={type}
            size="sm"
            className="whitespace-nowrap"
            disabled={disabled}
            title={disabled ? 'Add a resource first' : `Add a ${kind.label.toLowerCase()} block`}
            onClick={() => add(type)}
          >
            <Plus className="size-3.5" />
            <Icon className="size-3.5" /> {kind.label}
          </Button>
        )
      })}
      <Button
        size="sm"
        variant="ghost"
        title="Arrange blocks automatically"
        onClick={() => update((def) => ({ ...def, layout: { ...def.layout, blocks: autoLayout(def) } }))}
      >
        <LayoutGrid className="size-4" /> Arrange
      </Button>
    </div>
  )
}

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Not saved',
  error: 'Not saved',
}

function SaveIndicator() {
  const status = useEditor((s) => s.status)
  const error = useEditor((s) => s.saveError)
  return (
    <span
      data-testid="save-status"
      title={error ?? undefined}
      className={cn(
        'ml-2 inline-flex items-center gap-1 whitespace-nowrap text-xs',
        status === 'conflict' || status === 'error' ? 'text-danger' : 'text-muted',
      )}
    >
      {status === 'saving' && <Loader2 className="size-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="size-3 text-success" />}
      {(status === 'conflict' || status === 'error') && <AlertCircle className="size-3" />}
      {STATUS_TEXT[status]}
    </span>
  )
}

function ConflictBanner({ onReload }: { onReload: () => void }) {
  const status = useEditor((s) => s.status)
  if (status !== 'conflict') return null
  return (
    <div className="flex items-center gap-3 border-b border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
      <AlertCircle className="size-4" />
      Someone else saved this workflow while you were editing. Reload to get their version; your unsaved
      changes will be lost.
      <Button size="sm" onClick={onReload}>
        Reload
      </Button>
    </div>
  )
}

/** Saves the draft once it has been idle for a moment, and warns before leaving with unsaved changes. */
function Autosave() {
  const status = useEditor((s) => s.status)
  const definition = useEditor((s) => s.definition)

  const save = useCallback(async () => {
    const state = useEditor.getState()
    if (state.status !== 'dirty' || !state.workflowId) return
    const snapshot: WorkflowDefinition = state.definition
    const json = JSON.stringify(snapshot)
    state.saving()
    try {
      const result = await trpcClient.workflows.saveDraft.mutate({
        id: state.workflowId,
        revision: state.revision,
        definition: snapshot,
      })
      useEditor.getState().saved(result.revision, json)
    } catch (err) {
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') useEditor.getState().conflict()
      else useEditor.getState().failed(errorMessage(err))
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `definition` restarts the timer on every edit
  useEffect(() => {
    if (status !== 'dirty') return
    const timer = setTimeout(save, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [status, definition, save])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().status !== 'saved') e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  return null
}

/** The selected block's details (full settings arrive with the inspectors), or the workflow's problems. */
function SidePanel() {
  const selected = useEditor((s) => s.selected)
  const definition = useEditor((s) => s.definition)
  const diagnostics = useEditor((s) => s.diagnostics)
  const block = definition.blocks.find((b) => b.name === selected)

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface" data-testid="side-panel">
      {block ? (
        <BlockDetails name={block.name} type={block.type} problems={problemsOf(diagnostics, block.name)} />
      ) : (
        <Problems diagnostics={diagnostics} />
      )}
    </aside>
  )
}

function BlockDetails({ name, type, problems }: { name: string; type: BlockType; problems: Diagnostic[] }) {
  const update = useEditor((s) => s.update)
  const select = useEditor((s) => s.select)
  const kind = BLOCK_KINDS[type]
  const Icon = kind.icon
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <span className={cn('rounded-md p-1.5', kind.tone)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono font-medium">{name}</div>
          <div className="text-xs text-muted">{kind.label}</div>
        </div>
        {type !== 'startTrigger' && (
          <Button
            size="icon"
            variant="ghost"
            title="Delete block"
            onClick={() => {
              update((def) => removeFrom(def, new Set([name])))
              select(null)
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <ProblemList diagnostics={problems} empty="No problems in this block." />
    </div>
  )
}

function Problems({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  return (
    <div className="flex min-h-0 flex-col p-4">
      <h2 className="mb-1 font-semibold">Problems</h2>
      <p className="mb-3 text-xs text-muted">
        {errors
          ? `${errors} error${errors === 1 ? '' : 's'} to fix before this workflow can run.`
          : 'Select a block to see its details.'}
      </p>
      <ProblemList diagnostics={diagnostics} empty="No problems found." />
    </div>
  )
}

function ProblemList({ diagnostics, empty }: { diagnostics: Diagnostic[]; empty: string }) {
  const select = useEditor((s) => s.select)
  if (!diagnostics.length) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted">
        <CheckCircle2 className="size-4 text-success" /> {empty}
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 overflow-y-auto" data-testid="problems">
      {diagnostics.map((d) => (
        <li key={`${d.code}:${d.path.join('.')}:${d.start ?? ''}`}>
          <button
            type="button"
            onClick={() => d.block && select(d.block)}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-canvas"
          >
            <AlertCircle
              className={cn(
                'mt-0.5 size-4 shrink-0',
                d.severity === 'error' ? 'text-danger' : 'text-amber-600',
              )}
            />
            <span className="min-w-0">
              {d.block && <span className="font-mono text-xs text-muted">{d.block} · </span>}
              {d.message}
              {d.hint && <span className="block text-xs text-muted">{d.hint}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
