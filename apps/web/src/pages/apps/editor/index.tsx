import type { AppDefinition } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Eye, Pencil } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { GitBar } from '@/components/git-bar'
import { PresenceAvatars } from '@/components/presence-avatars'
import { Badge, Button, ErrorNote, Select, Spinner } from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import { useEditorKeys } from '@/lib/editor-keys'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AppCanvas } from '../canvas'
import { NeededConnections } from '../connections'
import { AppChromeContext } from '../grid-context'
import { Notifications, useConfirmations, useNotifications } from '../notifications'
import { AppHostProvider, useAppHost, useAppHostState } from '../runtime/react'
import { AppStopped } from '../stopped'
import { EditCanvas } from './canvas'
import { useCanvasKeys } from './canvas-keys'
import { copyText, duplicateChosen, pasteText } from './clipboard'
import { closeSession, ensureSaved, openSession } from './collab'
import { useComponentLibrarySync } from './custom'
import { ScopeSync } from './fields'
import { ComponentInspector, SelectionInspector } from './inspector'
import { useLibrarySync } from './library'
import { useModuleSync } from './modules'
import { AppInspector } from './pages'
import { usePresence } from './presence'
import { type EditorApp, ReleaseControls } from './releases'
import { CodeDock, DebugDrawer, LeftPanelArea, Rail, StatusBar } from './shell'
import { type SaveStatus, useAppEditor } from './store'

type BranchDraft = RouterOutputs['branchDrafts']['get']

const route = getRouteApi('/app/apps/$slug/edit')
const appRoute = getRouteApi('/app')

/** The running draft follows edits this long after the last one. */
const UPDATE_DELAY_MS = 300

/** Building an app: the draft runs live in the editor against the environment picked here. */
export function AppEditorPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const trpc = useTRPC()
  const navigate = useNavigate()
  // Fetched fresh each visit (gcTime 0: nothing cached from the last one) and loaded into the editor once: a later
  // refetch (after App settings) only updates the name and description, never the draft being edited.
  const app = useQuery({
    ...trpc.apps.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  useLibrarySync()
  useModuleSync()
  useComponentLibrarySync()
  return (
    <DraftLoader
      kind="app"
      object={app}
      search={search}
      go={(next) => navigate({ to: '/apps/$slug/edit', params: { slug }, search: next })}
    />
  )
}

/** What the editor loads of an app or module (`apps.get`, `modules.get`). */
interface EditedObject {
  id: string
  slug: string
  name: string
  description: string | null
  level: 'use' | 'edit' | 'own'
  gitProtected: boolean
  draftDefinition: AppDefinition
  draftRevision: number
  draftHash: string
}

/**
 * Loads an app's or module's draft into the editor: its main draft, or (protected, M11) its draft on the Git branch
 * in `search.branch`, opened or made as needed; then the editor with the environment in `search.env`.
 */
export function DraftLoader({
  kind,
  object,
  search,
  go,
}: {
  kind: 'app' | 'module'
  /** The object's query: its data once loaded. */
  object: { data?: EditedObject; error: unknown; refetch: () => Promise<unknown> }
  search: { env?: string; branch?: string }
  /** Moves to the same editor with other search params. */
  go: (search: { env?: string; branch?: string }) => Promise<void>
}) {
  const trpc = useTRPC()
  const environments = useQuery(trpc.environments.list.queryOptions())
  const load = useAppEditor((s) => s.load)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const data = object.data
  const gitProtected = data?.gitProtected ?? false
  const branch = gitProtected ? (search.branch ?? null) : null
  // A protected object is edited in a draft on a Git branch (M11); opening one makes it if needed.
  const opened = useQuery({
    queryKey: ['branchDraft', kind, data?.id, branch],
    queryFn: () => trpcClient.branchDrafts.open.mutate({ kind, id: data!.id, branch: branch!, create: true }),
    enabled: Boolean(data && branch),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  })
  const [draftInfo, setDraftInfo] = useState<BranchDraft | null>(null)
  const branchDraft = branch ? (draftInfo?.branch === branch ? draftInfo : opened.data) : null
  // What's loaded: the object, which draft (main, read-only when protected, or a branch's).
  const wanted = data
    ? `${data.id}:${branch ? (branchDraft?.id ?? 'opening') : `main:${gitProtected}`}`
    : null

  const loadDraft = useCallback(
    (id: string, draft: BranchDraft) => {
      load(id, draft.definition as AppDefinition, draft.revision, draft.draftHash, {
        branchDraftId: draft.id,
        kind,
        ...(data && { slug: data.slug }),
      })
      openSession(kind, id, draft.id)
    },
    [load, kind, data],
  )
  useEffect(() => {
    if (!data || !wanted || loadedFor === wanted || wanted.endsWith(':opening')) return
    if (branch && branchDraft) loadDraft(data.id, branchDraft)
    else {
      load(data.id, data.draftDefinition, data.draftRevision, data.draftHash, {
        readOnly: data.gitProtected,
        kind,
        slug: data.slug,
      })
      openSession(kind, data.id, null)
    }
    setLoadedFor(wanted)
  }, [data, wanted, loadedFor, branch, branchDraft, load, loadDraft, kind])
  // The draft's document closes with the editor. Mounted again with the draft still loaded (React's StrictMode does
  // it in development), it opens again.
  const mountedBefore = useRef(false)
  useEffect(() => {
    if (mountedBefore.current) {
      const { kind: loadedKind, appId, branchDraftId } = useAppEditor.getState()
      if (appId) openSession(loadedKind, appId, branchDraftId)
    }
    mountedBefore.current = true
    return closeSession
  }, [])

  const switchBranch = async (next: string | null) => {
    try {
      await ensureSaved()
    } catch (err) {
      if (!(await confirmDialog(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`))) return
    }
    setDraftInfo(null)
    // Main may have moved while on a branch (a merge deployed it): load what's there now.
    if (next === null) {
      await object.refetch()
      setLoadedFor(null)
    }
    await go({ ...search, branch: next ?? undefined })
  }

  const error = object.error ?? opened.error ?? environments.error
  if (error)
    return (
      <Centered>
        <ErrorNote error={error} />
      </Centered>
    )
  // The store outlives the page: until this visit's draft is in it, it may hold the last one.
  // The same object reloading (main turning read-only after Protect) keeps the editor and its dialogs on screen.
  const ready = data && wanted && !wanted.endsWith(':opening') && loadedFor?.split(':')[0] === data.id
  if (!data || !environments.data || !ready)
    return (
      <Centered>
        <Spinner />
      </Centered>
    )
  const environment =
    environments.data.find((e) => e.slug === search.env) ??
    environments.data.find((e) => e.isDefault) ??
    environments.data[0]!
  return (
    <Editor
      key={`${data.id}:${environment.id}:${branchDraft?.id ?? 'main'}`}
      app={{
        kind,
        id: data.id,
        slug: data.slug,
        name: data.name,
        description: data.description,
        level: data.level,
        gitProtected: data.gitProtected,
      }}
      environment={environment}
      environments={environments.data}
      branchDraftId={branchDraft?.id ?? null}
      branch={branch}
      git={
        gitProtected ? (
          <GitBar
            kind={kind}
            object={data}
            branch={branch}
            draft={branchDraft ?? null}
            onSwitch={switchBranch}
            ensureSaved={ensureSaved}
            revision={() => useAppEditor.getState().revision}
            onReplaced={(draft) => {
              setDraftInfo(draft)
              loadDraft(data.id, draft)
              // The running draft follows the replaced definition.
              setLoadedFor(`${data.id}:${draft.id}`)
            }}
            onUpdated={setDraftInfo}
          />
        ) : null
      }
    />
  )
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8">{children}</div>
}

interface EditorProps {
  /** The app, or the module (M14: the same editor, without pages, with its inputs, outputs and events). */
  app: EditorApp
  environment: { id: string; slug: string; name: string }
  environments: { id: string; slug: string; name: string }[]
  /** The Git branch draft being edited (M11), or null for the main draft. */
  branchDraftId: string | null
  /** That draft's branch. */
  branch?: string | null
  /** A protected app's Git bar. */
  git: React.ReactNode
}

export function Editor({ app, environment, environments, branchDraftId, branch = null, git }: EditorProps) {
  const { me } = appRoute.useRouteContext()
  const navigate = useNavigate()
  const { notices, notify, dismiss } = useNotifications()
  const { confirm, dialog: confirmation } = useConfirmations()
  const [preview, setPreview] = useState(false)
  const status = useAppEditor((s) => s.status)
  const peers = usePresence((s) => s.peers)
  const selected = useAppEditor((s) => s.selected)
  const selection = useAppEditor((s) => s.selection)
  const definition = useAppEditor((s) => s.definition)
  const inspectorOpen = useAppEditor((s) => s.inspectorOpen)

  const readOnly = useAppEditor((s) => s.readOnly)
  const epoch = useAppEditor((s) => s.epoch)
  const canUndo = useAppEditor((s) => s.canUndo)
  const canRedo = useAppEditor((s) => s.canRedo)
  // Undo and redo while editing (not in Preview, where the keys are the app's).
  useEditorKeys({
    editable: !readOnly && !preview,
    undo: () => useAppEditor.getState().undo(),
    redo: () => useAppEditor.getState().redo(),
    duplicate: () => duplicateChosen(notify),
    // Copying works on a read-only draft too; not in Preview, where the page is the app's.
    copy: () => (preview ? null : copyText()),
    paste: (text) => pasteText(text, notify),
  })
  // Escape, ⌘A, Delete and the arrow keys on the canvas's selection (M24); not in Preview.
  useCanvasKeys(!preview)
  const { ref, host } = useAppHost(`${app.id}:${environment.id}:${branchDraftId ?? 'main'}`, {
    definition: useAppEditor.getState().definition,
    modules: useAppEditor.getState().moduleReleases,
    libraries: useAppEditor.getState().libraryReleases,
    kind: app.kind,
    appId: app.id,
    releaseId: null,
    branchDraftId,
    environmentId: environment.id,
    globals: {
      current_user: { id: me.id, email: me.email, name: me.name },
      appContext: { appSlug: app.slug, environment: environment.slug, version: null },
    },
    notify,
    confirm,
    beforeQuery: ensureSaved,
    url: useAppEditor.getState().url,
    // `utils.openPage` and Navigation links move the editor to that page.
    openPage: (page, params) => useAppEditor.getState().setUrl(page, params),
  })

  // The running draft is on the page being edited.
  useEffect(() => {
    if (!host) return
    return useAppEditor.subscribe((state, before) => {
      if (state.url !== before.url) host.navigate(state.url)
    })
  }, [host])

  // The running draft follows the edits, and the module releases its instances run.
  useEffect(() => {
    if (!host) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useAppEditor.subscribe((state, before) => {
      if (
        state.definition === before.definition &&
        state.moduleReleases === before.moduleReleases &&
        state.libraryReleases === before.libraryReleases
      )
        return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { definition, moduleReleases, libraryReleases } = useAppEditor.getState()
        host.update(definition, moduleReleases, libraryReleases)
      }, UPDATE_DELAY_MS)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [host])

  // Leaving with edits the server hasn't saved asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useAppEditor.getState().status
      if (!useAppEditor.getState().readOnly && (s === 'saving' || s === 'offline' || s === 'error'))
        e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="flex h-full flex-col gap-2">
      <header className="flex h-14 shrink-0 items-center gap-3 rounded-lg bg-surface px-4">
        <h1 className="truncate text-lg leading-6 font-bold">{app.name}</h1>
        <SaveBadge status={status} />
        <PresenceAvatars peers={peers} me={me.id} />
        {!readOnly && !preview && (
          <div className="flex items-center">
            <UndoButtons
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={() => useAppEditor.getState().undo()}
              onRedo={() => useAppEditor.getState().redo()}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label htmlFor="editor-env" className="text-muted">
            Environment
          </label>
          <Select
            id="editor-env"
            value={environment.slug}
            onChange={(e) =>
              navigate({
                to: app.kind === 'module' ? '/modules/$slug' : '/apps/$slug/edit',
                params: { slug: app.slug },
                search: (prev) => ({ ...prev, env: e.target.value }),
              })
            }
          >
            {environments.map((e) => (
              <option key={e.id} value={e.slug}>
                {e.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            onClick={() => setPreview(!preview)}
            title={preview ? 'Back to editing' : `Use the ${app.kind} as people will`}
          >
            {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <ReleaseControls app={app} />
        </div>
      </header>
      {git}
      <div ref={ref} className="hidden" />
      {host ? (
        <AppHostProvider host={host}>
          <AppChromeContext.Provider
            value={{
              appName: app.name,
              user: { name: me.name, email: me.email },
              // Where the app is used: a link opened in a new tab goes there, not into the editor.
              pageHref: (page, params) => {
                const query = new URLSearchParams(params).toString()
                return `/apps/${encodeURIComponent(app.slug)}/${encodeURIComponent(page)}${query ? `?${query}` : ''}`
              },
            }}
          >
            <ScopeSync />
            <div className="flex min-h-0 flex-1 gap-2">
              {!preview && <Rail kind={app.kind} />}
              {!preview && <LeftPanelArea kind={app.kind} />}
              {!preview && <CodeDock />}
              {/* On the page background, as people see the app; never squeezed below a usable width by the panels. */}
              <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-divider px-6 py-4">
                <div className="min-w-[640px]">
                  <Running>{preview ? <PreviewCanvas definition={definition} /> : <EditCanvas />}</Running>
                </div>
              </div>
              {!preview && inspectorOpen && (
                <aside aria-label="Inspector" className="w-80 shrink-0 overflow-y-auto rounded-lg bg-surface">
                  {/* A protected app on main (M22): its inspector shows what's deployed, disabled. */}
                  <fieldset disabled={readOnly} className="contents" data-testid="inspector">
                    {selection.length > 1 ? (
                      <SelectionInspector names={selection} onDuplicate={() => duplicateChosen(notify)} />
                    ) : selected ? (
                      <ComponentInspector key={`${epoch}/${selected}`} name={selected} />
                    ) : (
                      <AppInspector key={epoch} kind={app.kind} />
                    )}
                  </fieldset>
                </aside>
              )}
            </div>
            {!preview && <DebugDrawer />}
            {!preview && <StatusBar environment={environment.name} branch={branch} />}
          </AppChromeContext.Provider>
        </AppHostProvider>
      ) : (
        <Centered>
          <Spinner />
        </Centered>
      )}
      <Notifications notices={notices} dismiss={dismiss} />
      {confirmation}
    </div>
  )
}

/** The app as people see it, on the page being edited (`utils.openPage` and Navigation move it in place). */
function PreviewCanvas({ definition }: { definition: AppDefinition }) {
  const page = useAppEditor((s) => s.url.page)
  return <AppCanvas definition={definition} page={page} />
}

/** The canvas once the sandbox runs; its problem if it can't. */
function Running({ children }: { children: React.ReactNode }) {
  const status = useAppHostState((s) => s.status)
  const problem = useAppHostState((s) => s.problem)
  if (status === 'failed') return <ErrorNote error={new Error(problem ?? 'The app could not start')} />
  if (status === 'loading') return <Spinner />
  return (
    <>
      <AppStopped editing />
      <NeededConnections />
      {children}
    </>
  )
}

const SAVE_LABELS: Record<SaveStatus, { text: string; className: string }> = {
  connecting: { text: 'Connecting…', className: 'text-muted' },
  saved: { text: 'Saved', className: 'text-muted' },
  saving: { text: 'Saving…', className: 'text-muted' },
  offline: { text: 'Offline: changes will sync', className: 'text-warning-strong' },
  error: { text: 'Not saved', className: 'text-danger' },
  closed: { text: 'Disconnected: reload', className: 'text-danger' },
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const saveError = useAppEditor((s) => s.saveError)
  const label = SAVE_LABELS[status]
  return (
    <Badge className={cn('font-normal', label.className)} title={saveError ?? undefined}>
      {label.text}
    </Badge>
  )
}
