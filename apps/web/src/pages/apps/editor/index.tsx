import type { AppDefinition } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Eye, Pencil } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { GitBar } from '@/components/git-bar'
import { Badge, Button, ErrorNote, Select, Spinner, sectionLabelClass } from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import { useEditorKeys } from '@/lib/editor-keys'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AppCanvas } from '../canvas'
import { NeededConnections } from '../connections'
import { Notifications, useConfirmations, useNotifications } from '../notifications'
import { AppHostProvider, useAppHost, useAppHostState } from '../runtime/react'
import { AppStopped } from '../stopped'
import { ComponentTree, EditCanvas, Palette } from './canvas'
import { copyText, duplicateChosen, pasteText } from './clipboard'
import { CodePanel } from './code-panel'
import { ScopeSync } from './fields'
import { ComponentInspector } from './inspector'
import { useLibrarySync } from './library'
import { ModulePanel } from './module-panel'
import { useModuleSync } from './modules'
import { PagesPanel } from './pages'
import { type EditorApp, ReleaseControls } from './releases'
import { ensureSaved, saveDraftNow } from './save'
import { type SaveStatus, useAppEditor } from './store'

type BranchDraft = RouterOutputs['branchDrafts']['get']

const route = getRouteApi('/app/apps/$slug/edit')
const appRoute = getRouteApi('/app')

/** Autosave this long after the last edit. */
const SAVE_DELAY_MS = 800
/** The running draft follows edits this long after the last one. */
const UPDATE_DELAY_MS = 300

/** Building an app: the draft runs live in the editor against the environment picked here. */
export function AppEditorPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const trpc = useTRPC()
  // Fetched fresh each visit (gcTime 0: nothing cached from the last one) and loaded into the editor once: a later
  // refetch (after App settings) only updates the name and description, never the draft being edited.
  const app = useQuery({
    ...trpc.apps.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const environments = useQuery(trpc.environments.list.queryOptions())
  useLibrarySync()
  useModuleSync()
  const navigate = useNavigate()
  const load = useAppEditor((s) => s.load)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const gitProtected = app.data?.gitProtected ?? false
  const branch = gitProtected ? (search.branch ?? null) : null
  // A protected app is edited in a draft on a Git branch (M11); opening one makes it if needed.
  const opened = useQuery({
    queryKey: ['branchDraft', 'app', app.data?.id, branch],
    queryFn: () =>
      trpcClient.branchDrafts.open.mutate({ kind: 'app', id: app.data!.id, branch: branch!, create: true }),
    enabled: Boolean(app.data && branch),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  })
  const [draftInfo, setDraftInfo] = useState<BranchDraft | null>(null)
  const branchDraft = branch ? (draftInfo?.branch === branch ? draftInfo : opened.data) : null
  // What's loaded: the app, which draft (main, read-only when protected, or a branch's).
  const wanted = app.data
    ? `${app.data.id}:${branch ? (branchDraft?.id ?? 'opening') : `main:${gitProtected}`}`
    : null

  const loadDraft = useCallback(
    (appId: string, draft: BranchDraft) =>
      load(appId, draft.definition as AppDefinition, draft.revision, draft.draftHash, {
        branchDraftId: draft.id,
      }),
    [load],
  )
  useEffect(() => {
    if (!app.data || !wanted || loadedFor === wanted || wanted.endsWith(':opening')) return
    if (branch && branchDraft) loadDraft(app.data.id, branchDraft)
    else {
      load(app.data.id, app.data.draftDefinition, app.data.draftRevision, app.data.draftHash, {
        readOnly: app.data.gitProtected,
      })
    }
    setLoadedFor(wanted)
  }, [app.data, wanted, loadedFor, branch, branchDraft, load, loadDraft])

  const switchBranch = async (next: string | null) => {
    try {
      await ensureSaved()
    } catch (err) {
      if (!confirm(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`)) return
    }
    setDraftInfo(null)
    // Main may have moved while on a branch (a merge deployed it): load what's there now.
    if (next === null) {
      await app.refetch()
      setLoadedFor(null)
    }
    await navigate({
      to: '/apps/$slug/edit',
      params: { slug },
      search: { ...search, branch: next ?? undefined },
    })
  }

  const error = app.error ?? opened.error
  if (error)
    return (
      <Centered>
        <ErrorNote error={error} />
      </Centered>
    )
  if (environments.error)
    return (
      <Centered>
        <ErrorNote error={environments.error} />
      </Centered>
    )
  // The store outlives the page: until this visit's draft is in it, it may hold the last one.
  // The same app reloading (main turning read-only after Protect) keeps the editor and its dialogs on screen.
  const ready = app.data && wanted && !wanted.endsWith(':opening') && loadedFor?.split(':')[0] === app.data.id
  if (!app.data || !environments.data || !ready)
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
      key={`${app.data.id}:${environment.id}:${branchDraft?.id ?? 'main'}`}
      app={{
        kind: 'app',
        id: app.data.id,
        slug: app.data.slug,
        name: app.data.name,
        description: app.data.description,
        level: app.data.level,
        gitProtected: app.data.gitProtected,
      }}
      environment={environment}
      environments={environments.data}
      branchDraftId={branchDraft?.id ?? null}
      git={
        gitProtected ? (
          <GitBar
            kind="app"
            object={app.data}
            branch={branch}
            draft={branchDraft ?? null}
            onSwitch={switchBranch}
            ensureSaved={ensureSaved}
            revision={() => useAppEditor.getState().revision}
            onReplaced={(draft) => {
              setDraftInfo(draft)
              loadDraft(app.data!.id, draft)
              // The running draft follows the replaced definition.
              setLoadedFor(`${app.data!.id}:${draft.id}`)
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
  /** A protected app's Git bar. */
  git: React.ReactNode
}

export function Editor({ app, environment, environments, branchDraftId, git }: EditorProps) {
  const { me } = appRoute.useRouteContext()
  const navigate = useNavigate()
  const { notices, notify, dismiss } = useNotifications()
  const { confirm, dialog: confirmation } = useConfirmations()
  const [preview, setPreview] = useState(false)
  const status = useAppEditor((s) => s.status)
  const selected = useAppEditor((s) => s.selected)
  const definition = useAppEditor((s) => s.definition)

  const readOnly = useAppEditor((s) => s.readOnly)
  const epoch = useAppEditor((s) => s.epoch)
  const canUndo = useAppEditor((s) => s.history.past.length > 0 && s.status !== 'conflict')
  const canRedo = useAppEditor((s) => s.history.future.length > 0 && s.status !== 'conflict')
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
  const { ref, host } = useAppHost(`${app.id}:${environment.id}:${branchDraftId ?? 'main'}`, {
    definition: useAppEditor.getState().definition,
    modules: useAppEditor.getState().moduleReleases,
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
      if (state.definition === before.definition && state.moduleReleases === before.moduleReleases) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { definition, moduleReleases } = useAppEditor.getState()
        host.update(definition, moduleReleases)
      }, UPDATE_DELAY_MS)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [host])

  // Autosave.
  useEffect(() => {
    if (status !== 'dirty') return
    const timer = setTimeout(() => void saveDraftNow(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  })

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useAppEditor.getState().status
      if (s === 'dirty' || s === 'saving' || s === 'error') e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="flex h-full flex-col gap-2">
      <header className="flex h-14 shrink-0 items-center gap-3 rounded-lg bg-surface px-4">
        <h1 className="truncate text-lg leading-6 font-bold">{app.name}</h1>
        <SaveBadge status={status} />
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
      {status === 'conflict' && (
        <div role="alert" className="flex items-center gap-3 rounded-lg bg-accent-soft px-4 py-2 text-sm">
          Someone else saved this {app.kind} since you opened it. Your edits here can't be saved.
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
      <div ref={ref} className="hidden" />
      {host ? (
        <AppHostProvider host={host}>
          <ScopeSync />
          <div className="flex min-h-0 flex-1 gap-2">
            {!preview && (
              <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto rounded-lg bg-surface p-3">
                {/* `epoch`: after an undo or redo, panels start again from the definition (some read it once). */}
                {app.kind === 'app' ? <PagesPanel key={epoch} /> : <ModulePanel key={epoch} />}
                {!readOnly && (
                  <section>
                    <h2 className={cn('mb-2', sectionLabelClass)}>Add</h2>
                    <Palette />
                  </section>
                )}
                <section>
                  <h2 className={cn('mb-2', sectionLabelClass)}>Components</h2>
                  <ComponentTree />
                </section>
              </aside>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {/* On the page background, as people see the app. */}
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-divider px-6 py-4">
                <Running>{preview ? <PreviewCanvas definition={definition} /> : <EditCanvas />}</Running>
              </div>
              {!preview && (
                <div className="h-[38%] min-h-48 shrink-0 overflow-hidden rounded-lg bg-surface">
                  <CodePanel key={epoch} />
                </div>
              )}
            </div>
            {!preview && selected && (
              <aside className="w-80 shrink-0 overflow-y-auto rounded-lg bg-surface">
                <ComponentInspector key={`${epoch}/${selected}`} name={selected} />
              </aside>
            )}
          </div>
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
  saved: { text: 'Saved', className: 'text-muted' },
  dirty: { text: 'Unsaved changes', className: 'text-muted' },
  saving: { text: 'Saving…', className: 'text-muted' },
  conflict: { text: 'Not saved: conflict', className: 'text-danger' },
  error: { text: 'Not saved', className: 'text-danger' },
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
