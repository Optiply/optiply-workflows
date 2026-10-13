import type { BlockType, Diagnostic } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { AlertCircle, ArrowLeft, CheckCircle2, History, LayoutGrid, Loader2, Play, Plus } from 'lucide-react'
import { useEffect } from 'react'
import { Badge, Button, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { Canvas } from './canvas'
import { ADDABLE, BLOCK_KINDS, newBlock, nextName } from './catalog'
import { Inspector } from './inspectors'
import { useLastRunSamples } from './last-run'
import { autoLayout, NODE_WIDTH, positionsFor } from './layout'
import { useRunEvents } from './live'
import { RunPanel } from './run-panel'
import { runWorkflow, useRun } from './run-state'
import { saveDraftNow } from './save'
import { type SaveStatus, useEditor } from './store'

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
    <EditorLayout
      name={workflow.data.name}
      slug={workflow.data.slug}
      canEdit={canEdit}
      onReload={() => workflow.refetch()}
    />
  )
}

function EditorLayout({
  name,
  slug,
  canEdit,
  onReload,
}: {
  name: string
  slug: string
  canEdit: boolean
  onReload: () => void
}) {
  const trpc = useTRPC()
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const { run: runFromUrl } = route.useSearch()
  const panelOpen = useRun((s) => s.panelOpen)

  useEffect(() => {
    const current = useRun.getState()
    // Keep the chosen environment while staying on the same workflow.
    current.init(slug, current.slug === slug ? current.environment : null)
    if (runFromUrl) useRun.getState().open(runFromUrl)
  }, [slug, runFromUrl])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `slug` re-picks the default after `init` cleared it
  useEffect(() => {
    const fallback = environments?.find((e) => e.isDefault) ?? environments?.[0]
    if (fallback && !useRun.getState().environment) useRun.getState().setEnvironment(fallback.slug)
  }, [environments, slug])
  useLastRunSamples(slug)
  useRunEvents()

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <Header name={name} slug={slug} canEdit={canEdit} environments={environments ?? []} />
        <ConflictBanner onReload={onReload} />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1" data-testid="canvas">
              <Canvas />
              {canEdit && <Toolbar />}
            </div>
            {panelOpen && <RunPanel />}
          </div>
          <SidePanel />
        </div>
      </div>
      {canEdit && <Autosave />}
    </ReactFlowProvider>
  )
}

function Header({
  name,
  slug,
  canEdit,
  environments,
}: {
  name: string
  slug: string
  canEdit: boolean
  environments: { slug: string; name: string }[]
}) {
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
      {!canEdit && <Badge>Read only</Badge>}
      <RunControls canEdit={canEdit} environments={environments} />
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
    <div className="absolute top-3 left-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface/95 p-1 shadow-sm">
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

/** Environment, Run (saves first, then runs with the test input) and the run panel toggle. */
function RunControls({
  canEdit,
  environments,
}: {
  canEdit: boolean
  environments: { slug: string; name: string }[]
}) {
  const environment = useRun((s) => s.environment)
  const starting = useRun((s) => s.starting)
  const startError = useRun((s) => s.startError)
  const panelOpen = useRun((s) => s.panelOpen)
  const errors = useEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)

  return (
    <div className="flex items-center gap-2">
      {startError && (
        <span className="max-w-72 truncate text-xs text-danger" title={startError} data-testid="run-error">
          {startError}
        </span>
      )}
      <Select
        aria-label="Environment"
        className="h-8"
        value={environment ?? ''}
        onChange={(e) => useRun.getState().setEnvironment(e.target.value)}
      >
        {environments.map((e) => (
          <option key={e.slug} value={e.slug}>
            {e.name}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        loading={starting}
        disabled={!canEdit || errors > 0}
        title={
          !canEdit
            ? 'You need edit access to run the draft'
            : errors
              ? 'Fix the problems first'
              : "Save and run with the start trigger's test input"
        }
        onClick={() => runWorkflow()}
      >
        {!starting && <Play className="size-3.5" />} Run
      </Button>
      <Button
        size="sm"
        variant={panelOpen ? 'secondary' : 'ghost'}
        title="Show runs"
        onClick={() => useRun.getState().togglePanel()}
      >
        <History className="size-4" /> Runs
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `definition` restarts the timer on every edit
  useEffect(() => {
    if (status !== 'dirty') return
    const timer = setTimeout(saveDraftNow, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [status, definition])

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
    // `nokey`: React Flow listens for Space (pan) and Backspace/Delete (delete the selection) on the whole document
    // and doesn't recognise Monaco's input element as a text field; it ignores keys from inside `.nokey`.
    <aside
      className="nokey flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface"
      data-testid="side-panel"
    >
      {block ? <Inspector key={block.name} name={block.name} /> : <Problems diagnostics={diagnostics} />}
    </aside>
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
