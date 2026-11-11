import { usedLibraries, type WorkflowDefinition } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { AlertCircle, History, LayoutGrid, Play, Tag, Users, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { GitBar } from '@/components/git-bar'
import { PresenceAvatars } from '@/components/presence-avatars'
import { SaveStatusIndicator } from '@/components/save-status'
import { TopBarPortal } from '@/components/top-bar'
import { Badge, Button, Dialog, ErrorNote, Select, Spinner } from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import { useEditorKeys } from '@/lib/editor-keys'
import { useLibraryRefs } from '@/lib/library-refs'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AccessEditor } from '@/pages/resources/shared'
import { Canvas } from './canvas'
import { copyText, duplicateChosen, pasteText } from './clipboard'
import { closeSession, ensureSaved, openSession } from './collab'
import { FunctionBanner, FunctionSettings } from './functions'
import { Inspector } from './inspectors'
import { useLastRunSamples } from './last-run'
import { autoLayout } from './layout'
import { useRunEvents } from './live'
import { usePresence } from './presence'
import { Rail, RailPanelView } from './rail'
import { ReleaseControls } from './releases'
import { RunPanel } from './run-panel'
import { runWorkflow, useRun } from './run-state'
import { graphOf, updateGraph, useEditor } from './store'

const route = getRouteApi('/app/workflows/$workflowId')

type Workflow = RouterOutputs['workflows']['get']
type BranchDraft = RouterOutputs['branchDrafts']['get']

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
    (draft: BranchDraft) => {
      load(workflowId, draft.definition as WorkflowDefinition, draft.revision, draft.draftHash, {
        branchDraftId: draft.id,
      })
      openSession(workflowId, draft.id)
    },
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
    else {
      load(data.id, data.draftDefinition, data.draftRevision, data.draftHash, {
        readOnly: mainReadOnly(data),
      })
      openSession(data.id, null)
    }
  }, [workflow.data, wantDraftId, branchDraft, load, loadDraft])
  // Coming back to the editor later loads the workflow afresh.
  useEffect(
    () => () => {
      closeSession()
      useEditor.setState({ workflowId: null, branchDraftId: null })
    },
    [],
  )
  const switchBranch = async (next: string | null) => {
    try {
      await ensureSaved()
    } catch (err) {
      if (!(await confirmDialog(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`))) return
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
  git,
}: {
  workflow: Workflow
  canEdit: boolean
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
  // The library queries Library query blocks use, for the validator and the inspector (M21).
  useLibraryRefs(
    useEditor((s) => usedLibraries(s.definition).join(',')),
    useEditor((s) => s.setLibraries),
  )
  useRunEvents()
  // A protected workflow's main draft is read-only: it changes on branches. Running it still works.
  const readOnly = useEditor((s) => s.readOnly)
  const editable = canEdit && !readOnly

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col gap-2">
        <Header workflow={workflow} canEdit={canEdit} environments={environments ?? []} />
        {git}
        <div className="flex min-h-0 flex-1 gap-2">
          <Rail />
          <RailPanelView workflow={workflow} canEdit={editable} hasEdit={canEdit} />
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface shadow-card">
            <div className="relative min-h-0 flex-1" data-testid="canvas">
              <Canvas />
              {editable && <Toolbar />}
              <FunctionBanner />
              <PasteNotice />
            </div>
            {panelOpen && <RunPanel />}
          </div>
          <SidePanel canEdit={editable} />
        </div>
        <StatusBar workflow={workflow} environments={environments ?? []} />
      </div>
      {editable && <LeaveWarning />}
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
  const { me } = route.useRouteContext()
  const peers = usePresence((s) => s.peers)
  // In the shell's top bar, beside the breadcrumb that names the workflow.
  return (
    <TopBarPortal>
      <span className="hidden truncate font-mono text-xs text-muted xl:block" title={`${name}: ${slug}`}>
        {slug}
      </span>
      <SaveIndicator />
      <div className="flex-1" />
      <PresenceAvatars peers={peers} me={me.id} />
      {!canEdit && <Badge>Read only</Badge>}
      {/* A protected workflow is published by merging on Git. */}
      <ReleaseControls workflow={workflow} canEdit={canEdit && !workflow.gitProtected} />
      {workflow.level === 'own' && <AccessButton workflow={workflow} />}
      <div className="h-6 w-px bg-border" />
      <RunControls canEdit={canEdit} environments={environments} />
    </TopBarPortal>
  )
}

/** Owners share the workflow: who can run it (Use), change it (Edit) or own it, as groups or single people. */
function AccessButton({ workflow }: { workflow: Workflow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="icon" variant="ghost" title="Access" onClick={() => setOpen(true)}>
        <Users className="size-4" />
      </Button>
      {open && (
        <Dialog title={`Who can use ${workflow.name}`} onClose={() => setOpen(false)} className="max-w-2xl">
          <AccessEditor
            target={{ objectType: 'workflow', objectId: workflow.id }}
            help="Use runs it (live) and sees its runs · Edit also changes and runs the draft · Own also deletes it and manages access. The highest grant wins."
          />
        </Dialog>
      )}
    </>
  )
}

/** Undo, redo and Arrange, over the canvas; blocks are added from the rail's Blocks panel (M28). */
function Toolbar() {
  const { getNodes } = useReactFlow()
  return (
    <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border/70 bg-surface/90 p-1 shadow-raised backdrop-blur-sm">
      <WorkflowUndoButtons />
      <div className="mx-1 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        title="Arrange blocks automatically"
        onClick={() => {
          // The blocks' measured sizes, so tall forms don't overlap.
          const sizes = Object.fromEntries(
            getNodes().flatMap((n) =>
              n.measured?.width && n.measured.height
                ? [[n.id, { width: n.measured.width, height: n.measured.height }]]
                : [],
            ),
          )
          updateGraph((g) => ({ ...g, layout: { ...g.layout, blocks: autoLayout(g, sizes) } }))
        }}
      >
        <LayoutGrid className="size-4" /> Arrange
      </Button>
    </div>
  )
}

/** Undo and Redo. Off until the shared document has synced. */
function WorkflowUndoButtons() {
  const canUndo = useEditor((s) => s.canUndo)
  const canRedo = useEditor((s) => s.canRedo)
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

function SaveIndicator() {
  const status = useEditor((s) => s.status)
  const error = useEditor((s) => s.saveError)
  return <SaveStatusIndicator status={status} error={error} className="ml-2" />
}

/** Under the editor, as Retool's: the run environment, the live version, and the run history panel's toggle. */
function StatusBar({
  workflow,
  environments,
}: {
  workflow: Workflow
  environments: { slug: string; name: string }[]
}) {
  const environment = useRun((s) => s.environment)
  const panelOpen = useRun((s) => s.panelOpen)
  const name = environments.find((e) => e.slug === environment)?.name ?? environment
  return (
    <footer
      className="flex h-8 shrink-0 items-center gap-4 rounded-xl border border-border/70 bg-surface px-3 text-xs text-muted shadow-card"
      data-testid="status-bar"
    >
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-accent" />
        {name}
      </span>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 hover:text-ink"
        title="Releases"
        onClick={() => useEditor.getState().showTab('releases')}
      >
        <Tag className="size-3" />
        {workflow.liveRelease ? `v${workflow.liveRelease.version}` : 'Not published'}
      </button>
      <button
        type="button"
        aria-pressed={panelOpen}
        className={cn('flex cursor-pointer items-center gap-1 hover:text-ink', panelOpen && 'text-accent')}
        onClick={() => useRun.getState().togglePanel()}
      >
        <History className="size-3" /> Run history
      </button>
    </footer>
  )
}

/** Warns before leaving while edits made here aren't saved yet. */
function LeaveWarning() {
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      const { status } = useEditor.getState()
      if (status === 'saving' || status === 'offline' || status === 'error') e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  return null
}

/**
 * The side editor panel (M28): the block opened in it (its node's "Open in the side panel"), or the open function's
 * settings. Hidden otherwise; × closes it.
 */
function SidePanel({ canEdit }: { canEdit: boolean }) {
  const opened = useEditor((s) => s.panelBlock)
  const definition = useEditor((s) => s.definition)
  const fn = useEditor((s) => s.graph)
  const epoch = useEditor((s) => s.epoch)
  const block = graphOf(definition, fn).blocks.find((b) => b.name === opened)
  if (!block && fn === null) return null

  return (
    // `nokey`: React Flow listens for Space (pan) and Backspace/Delete (delete the selection) on the whole document
    // and doesn't recognise Monaco's input element as a text field; it ignores keys from inside `.nokey`.
    <aside
      className="nokey flex w-[30rem] shrink-0 flex-col overflow-y-auto rounded-xl border border-border/70 bg-surface shadow-card"
      data-testid="side-panel"
    >
      {block ? (
        <div className="flex min-h-0 flex-col">
          <div className="flex justify-end px-2 pt-2">
            <Button
              size="icon"
              variant="ghost"
              title="Close the side panel"
              aria-label="Close the side panel"
              onClick={() => useEditor.getState().openInPanel(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
          {/* `epoch`: after an undo or redo, fields start again from the definition (some read it only when mounted). */}
          <Inspector key={`${epoch}/${fn ?? ''}/${block.name}`} name={block.name} />
        </div>
      ) : (
        <FunctionSettings key={`${epoch}/${fn}`} name={fn!} canEdit={canEdit} />
      )}
    </aside>
  )
}
