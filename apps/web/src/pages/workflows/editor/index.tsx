import type { BlockType, Diagnostic, WorkflowDefinition } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { AlertCircle, ArrowLeft, CheckCircle2, History, LayoutGrid, Loader2, Play, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { GitBar } from '@/components/git-bar'
import { Badge, Button, ErrorNote, Select, Spinner, Tabs } from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import { useEditorKeys } from '@/lib/editor-keys'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { Canvas } from './canvas'
import { addableIn, BLOCK_KINDS, newBlock, nextName, PYTHON_KIND } from './catalog'
import { copyText, duplicateChosen, pasteText } from './clipboard'
import { FunctionBanner, FunctionSettings, FunctionsTab } from './functions'
import { Inspector } from './inspectors'
import { useLastRunSamples } from './last-run'
import { autoLayout, NODE_WIDTH, positionsFor } from './layout'
import { useRunEvents } from './live'
import { ReleaseControls, ReleasesTab } from './releases'
import { RunPanel } from './run-panel'
import { runWorkflow, useRun } from './run-state'
import { ensureSaved, saveDraftNow } from './save'
import { graphOf, type SaveStatus, type SideTab, updateGraph, useEditor } from './store'
import { WorkflowSettingsTab } from './workflow-settings'

const route = getRouteApi('/app/workflows/$workflowId')

type Workflow = RouterOutputs['workflows']['get']
type BranchDraft = RouterOutputs['branchDrafts']['get']

/** How long the draft must be idle before it's saved. */
const AUTOSAVE_MS = 800

export function WorkflowEditorPage() {
  const { workflowId } = route.useParams()
  const { branch } = route.useSearch()
  const navigate = route.useNavigate()
  const trpc = useTRPC()
  const workflow = useQuery({ ...trpc.workflows.get.queryOptions({ id: workflowId }), staleTime: 0 })
  const load = useEditor((s) => s.load)
  const loadedId = useEditor((s) => s.workflowId)
  const loadedDraft = useEditor((s) => s.branchDraftId)
  const gitProtected = workflow.data?.gitProtected ?? false
  // A protected workflow is edited in a draft on a Git branch (M11); opening one makes it if needed.
  const opened = useQuery({
    queryKey: ['branchDraft', 'workflow', workflowId, branch],
    queryFn: () =>
      trpcClient.branchDrafts.open.mutate({
        kind: 'workflow',
        id: workflowId,
        branch: branch!,
        create: true,
      }),
    enabled: Boolean(branch && gitProtected),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  })
  // The draft's Git details after a commit or an update (its base moves on).
  const [draftInfo, setDraftInfo] = useState<BranchDraft | null>(null)
  const branchDraft = branch && gitProtected ? (draftInfo?.branch === branch ? draftInfo : opened.data) : null
  const wantDraftId = branch && gitProtected ? (branchDraft?.id ?? undefined) : null

  const loadDraft = useCallback(
    (draft: BranchDraft) =>
      load(workflowId, draft.definition as WorkflowDefinition, draft.revision, draft.draftHash, {
        branchDraftId: draft.id,
      }),
    [load, workflowId],
  )

  // Load once per workflow and branch: later refetches (after publishing, on window focus) must not reset it.
  useEffect(() => {
    const data = workflow.data
    if (!data || wantDraftId === undefined) return
    const state = useEditor.getState()
    const stale =
      state.workflowId !== data.id ||
      state.branchDraftId !== wantDraftId ||
      (wantDraftId === null && state.readOnly !== mainReadOnly(data))
    if (!stale) return
    if (wantDraftId && branchDraft) loadDraft(branchDraft)
    else
      load(data.id, data.draftDefinition, data.draftRevision, data.draftHash, {
        readOnly: mainReadOnly(data),
      })
  }, [workflow.data, wantDraftId, branchDraft, load, loadDraft])
  // Coming back to the editor later loads the workflow afresh.
  useEffect(() => () => useEditor.setState({ workflowId: null, branchDraftId: null }), [])
  const reload = async () => {
    const draftId = useEditor.getState().branchDraftId
    if (draftId) return loadDraft(await trpcClient.branchDrafts.get.query({ id: draftId }))
    const { data } = await workflow.refetch()
    if (data)
      load(data.id, data.draftDefinition, data.draftRevision, data.draftHash, {
        readOnly: mainReadOnly(data),
      })
  }
  const switchBranch = async (next: string | null) => {
    try {
      await ensureSaved()
    } catch (err) {
      if (!confirm(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`)) return
    }
    setDraftInfo(null)
    // Main may have moved while on a branch (a merge deployed it): load what's there now.
    if (next === null) await workflow.refetch()
    await navigate({ search: (prev) => ({ ...prev, branch: next ?? undefined, run: undefined }) })
  }

  const error = workflow.error ?? opened.error
  if (error) {
    return (
      <div className="p-8">
        <ErrorNote error={error} />
      </div>
    )
  }
  if (
    !workflow.data ||
    loadedId !== workflow.data.id ||
    (wantDraftId ?? undefined) !== (loadedDraft ?? undefined)
  )
    return <Spinner />

  const canEdit = workflow.data.level !== 'use'
  return (
    <EditorLayout
      workflow={workflow.data}
      canEdit={canEdit}
      onReload={reload}
      git={
        gitProtected && canEdit ? (
          <GitBar
            kind="workflow"
            object={workflow.data}
            branch={branch ?? null}
            draft={branchDraft ?? null}
            onSwitch={switchBranch}
            ensureSaved={ensureSaved}
            revision={() => useEditor.getState().revision}
            onReplaced={(draft) => {
              setDraftInfo(draft)
              loadDraft(draft)
            }}
            onUpdated={setDraftInfo}
          />
        ) : null
      }
    />
  )
}

/**
 * The main draft can't be edited by people with Use (they see it, and its releases), nor on a protected workflow
 * (it changes on Git branches).
 */
function mainReadOnly(workflow: Workflow): boolean {
  return workflow.gitProtected || workflow.level === 'use'
}

function EditorLayout({
  workflow,
  canEdit,
  onReload,
  git,
}: {
  workflow: Workflow
  canEdit: boolean
  onReload: () => void
  /** A protected workflow's Git bar (M11). */
  git: React.ReactNode
}) {
  const { slug } = workflow
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
  // A protected workflow's main draft is read-only: it changes on branches. Running it still works.
  const readOnly = useEditor((s) => s.readOnly)
  const editable = canEdit && !readOnly

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col gap-2">
        <Header workflow={workflow} canEdit={canEdit} environments={environments ?? []} />
        {git}
        <ConflictBanner onReload={onReload} />
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-surface">
            <div className="relative min-h-0 flex-1" data-testid="canvas">
              <Canvas />
              {editable && <Toolbar />}
              <FunctionBanner />
              <PasteNotice />
            </div>
            {panelOpen && <RunPanel />}
          </div>
          <SidePanel workflow={workflow} canEdit={editable} hasEdit={canEdit} />
        </div>
      </div>
      {editable && <Autosave />}
      <EditorShortcuts editable={editable} />
    </ReactFlowProvider>
  )
}

function Header({
  workflow,
  canEdit,
  environments,
}: {
  workflow: Workflow
  canEdit: boolean
  environments: { slug: string; name: string }[]
}) {
  const { name, slug } = workflow
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 rounded-lg bg-surface px-4">
      <Link
        to="/workflows"
        className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-ink"
        title="Back"
      >
        <ArrowLeft className="size-4" />
      </Link>
      <div className="min-w-0">
        <div className="truncate text-lg leading-6 font-bold">{name}</div>
        <div className="truncate font-mono text-xs text-muted">{slug}</div>
      </div>
      <SaveIndicator />
      <div className="flex-1" />
      {!canEdit && <Badge>Read only</Badge>}
      {/* A protected workflow is published by merging on Git. */}
      <ReleaseControls workflow={workflow} canEdit={canEdit && !workflow.gitProtected} />
      <div className="h-6 w-px bg-border" />
      <RunControls canEdit={canEdit} environments={environments} />
    </header>
  )
}

type AddableType = Exclude<BlockType, 'startTrigger'>

function Toolbar() {
  const trpc = useTRPC()
  const select = useEditor((s) => s.select)
  const selected = useEditor((s) => s.selected)
  const fn = useEditor((s) => s.graph)
  const definition = useEditor((s) => s.definition)
  const { data: resources } = useQuery(trpc.resources.list.queryOptions())
  const queryable = resources?.resources ?? []
  const { fitView } = useReactFlow()
  const types = addableIn(fn !== null, graphOf(definition, fn).blocks)

  const add = (type: Exclude<BlockType, 'startTrigger'>, python = false) => {
    let added = ''
    const functions = (useEditor.getState().definition.functions ?? []).map((f) => f.name)
    updateGraph((def) => {
      // Block names can't be function names either (code calls functions by name).
      const taken = [...def.blocks.map((b) => b.name), ...functions]
      added = python ? nextName(type, taken, PYTHON_KIND) : nextName(type, taken)
      const block = newBlock(type, added, queryable[0], { functions, inFunction: fn !== null, python })
      const positions = positionsFor(def)
      // To the right of the selected block, or after the rightmost one.
      const anchor = selected && positions[selected]
      const x = anchor
        ? anchor.x + NODE_WIDTH + 80
        : Math.max(0, ...Object.values(positions).map((p) => p.x)) + NODE_WIDTH + 80
      const y = anchor ? anchor.y : 0
      const edges =
        type !== 'errorTrigger' &&
        selected &&
        def.blocks.some((b) => b.name === selected && b.type !== 'branch')
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
      <Plus className="mx-1 size-3.5 text-muted" />
      {types
        .flatMap((type): { type: AddableType; python?: boolean }[] =>
          type === 'code' ? [{ type }, { type, python: true }] : [{ type }],
        )
        .map(({ type, python }) => {
          const kind = python ? PYTHON_KIND : BLOCK_KINDS[type]
          const Icon = kind.icon
          const disabled = type === 'resourceQuery' && queryable.length === 0
          const label = python ? 'Add a Python code block' : `Add a ${kind.label.toLowerCase()} block`
          return (
            <Button
              key={python ? 'python' : type}
              size="icon"
              variant="ghost"
              disabled={disabled}
              title={disabled ? 'Add a resource first' : label}
              aria-label={label}
              onClick={() => add(type, python)}
            >
              <Icon className="size-4" />
            </Button>
          )
        })}
      <div className="mx-1 h-5 w-px bg-border" />
      <WorkflowUndoButtons />
      <div className="mx-1 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        title="Arrange blocks automatically"
        onClick={() => updateGraph((g) => ({ ...g, layout: { ...g.layout, blocks: autoLayout(g) } }))}
      >
        <LayoutGrid className="size-4" /> Arrange
      </Button>
    </div>
  )
}

/** Undo and Redo. Off while the draft conflicts (its edits can't be saved). */
function WorkflowUndoButtons() {
  const canUndo = useEditor((s) => s.history.past.length > 0 && s.status !== 'conflict')
  const canRedo = useEditor((s) => s.history.future.length > 0 && s.status !== 'conflict')
  return (
    <UndoButtons
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={() => useEditor.getState().undo()}
      onRedo={() => useEditor.getState().redo()}
    />
  )
}

/** The editor's keys: undo, redo, ⌘D, copy and paste (copy works on a read-only draft too). */
function EditorShortcuts({ editable }: { editable: boolean }) {
  useEditorKeys({
    editable,
    undo: () => useEditor.getState().undo(),
    redo: () => useEditor.getState().redo(),
    duplicate: duplicateChosen,
    copy: copyText,
    paste: pasteText,
  })
  return null
}

/** What the last paste renamed, skipped or brought along; it goes after a while, or when dismissed. */
function PasteNotice() {
  const notice = useEditor((s) => s.notice)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => useEditor.getState().notify(null), 15_000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div
      role="status"
      data-testid="paste-notice"
      className="absolute bottom-3 left-1/2 z-10 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-md"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning-strong" />
      <span className="min-w-0">{notice}</span>
      <Button size="sm" variant="ghost" onClick={() => useEditor.getState().notify(null)}>
        Dismiss
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
    <div className="flex items-center gap-3 rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger">
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

const SIDE_TABS: { value: SideTab; label: string }[] = [
  { value: 'problems', label: 'Problems' },
  { value: 'functions', label: 'Functions' },
  { value: 'releases', label: 'Releases' },
  { value: 'settings', label: 'Settings' },
]

/** The selected block's inspector or, with nothing selected, the workflow's problems, releases and settings. */
function SidePanel({
  workflow,
  canEdit,
  hasEdit,
}: {
  workflow: Workflow
  /** Whether the draft shown can be edited (not a protected workflow's main draft). */
  canEdit: boolean
  /** Whether the person has Edit on the workflow (releases and settings outside the draft). */
  hasEdit: boolean
}) {
  const selected = useEditor((s) => s.selected)
  const definition = useEditor((s) => s.definition)
  const diagnostics = useEditor((s) => s.diagnostics)
  const tab = useEditor((s) => s.sideTab)
  const fn = useEditor((s) => s.graph)
  const epoch = useEditor((s) => s.epoch)
  const block = graphOf(definition, fn).blocks.find((b) => b.name === selected)

  return (
    // `nokey`: React Flow listens for Space (pan) and Backspace/Delete (delete the selection) on the whole document
    // and doesn't recognise Monaco's input element as a text field; it ignores keys from inside `.nokey`.
    <aside
      className="nokey flex w-[26rem] shrink-0 flex-col overflow-y-auto rounded-lg bg-surface"
      data-testid="side-panel"
    >
      {block ? (
        // `epoch`: after an undo or redo, fields start again from the definition (some read it only when mounted).
        <Inspector key={`${epoch}/${fn ?? ''}/${block.name}`} name={block.name} />
      ) : fn !== null ? (
        <FunctionSettings key={`${epoch}/${fn}`} name={fn} canEdit={canEdit} />
      ) : (
        <div key={epoch} className="flex min-h-0 flex-col p-4">
          <Tabs value={tab} onChange={(t) => useEditor.getState().showTab(t)} tabs={SIDE_TABS} />
          {tab === 'problems' && <Problems diagnostics={diagnostics} />}
          {tab === 'functions' && <FunctionsTab canEdit={canEdit} />}
          {tab === 'releases' && <ReleasesTab workflow={workflow} canEdit={hasEdit} />}
          {tab === 'settings' && (
            <WorkflowSettingsTab workflow={workflow} canEdit={canEdit} hasEdit={hasEdit} />
          )}
        </div>
      )}
    </aside>
  )
}

function Problems({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  return (
    <div className="flex min-h-0 flex-col">
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
  const openGraph = useEditor((s) => s.openGraph)
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
            onClick={() =>
              d.block ? openGraph(d.function ?? null, d.block) : d.function && openGraph(d.function)
            }
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-canvas"
          >
            <AlertCircle
              className={cn(
                'mt-0.5 size-4 shrink-0',
                d.severity === 'error' ? 'text-danger' : 'text-warning-strong',
              )}
            />
            <span className="min-w-0">
              {(d.function || d.block) && (
                <span className="font-mono text-xs text-muted">
                  {[d.function, d.block].filter(Boolean).join('.')} ·{' '}
                </span>
              )}
              {d.message}
              {d.hint && <span className="block text-xs text-muted">{d.hint}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
