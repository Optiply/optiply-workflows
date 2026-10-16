import type { AppDefinition } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Eye, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AppCanvas } from '../canvas'
import { NeededConnections } from '../connections'
import { Notifications, useConfirmations, useNotifications } from '../notifications'
import { AppHostProvider, useAppHost, useAppHostState, useAppValue } from '../runtime/react'
import { AppStopped } from '../stopped'
import { ComponentTree, EditCanvas, Palette } from './canvas'
import { CodePanel } from './code-panel'
import { ScopeSync } from './fields'
import { ComponentInspector } from './inspector'
import { type EditorApp, ReleaseControls } from './releases'
import { ensureSaved, saveDraftNow } from './save'
import { type SaveStatus, useAppEditor } from './store'

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
  const load = useAppEditor((s) => s.load)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  useEffect(() => {
    if (!app.data || loadedFor === app.data.id) return
    load(app.data.id, app.data.draftDefinition, app.data.draftRevision, app.data.draftHash)
    setLoadedFor(app.data.id)
  }, [app.data, load, loadedFor])

  if (app.error)
    return (
      <Centered>
        <ErrorNote error={app.error} />
      </Centered>
    )
  if (environments.error)
    return (
      <Centered>
        <ErrorNote error={environments.error} />
      </Centered>
    )
  // The store outlives the page: until this visit's draft is in it, it may hold the last one.
  if (!app.data || !environments.data || loadedFor !== app.data.id)
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
      key={`${app.data.id}:${environment.id}`}
      app={{
        id: app.data.id,
        slug: app.data.slug,
        name: app.data.name,
        description: app.data.description,
        level: app.data.level,
      }}
      environment={environment}
      environments={environments.data}
    />
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8">{children}</div>
}

interface EditorProps {
  app: EditorApp
  environment: { id: string; slug: string; name: string }
  environments: { id: string; slug: string; name: string }[]
}

function Editor({ app, environment, environments }: EditorProps) {
  const { me } = appRoute.useRouteContext()
  const navigate = useNavigate()
  const { notices, notify, dismiss } = useNotifications()
  const { confirm, dialog: confirmation } = useConfirmations()
  const [preview, setPreview] = useState(false)
  const status = useAppEditor((s) => s.status)
  const selected = useAppEditor((s) => s.selected)
  const definition = useAppEditor((s) => s.definition)

  const { ref, host } = useAppHost(`${app.id}:${environment.id}`, {
    definition: useAppEditor.getState().definition,
    appId: app.id,
    releaseId: null,
    environmentId: environment.id,
    globals: {
      current_user: { id: me.id, email: me.email, name: me.name },
      appContext: { appSlug: app.slug, environment: environment.slug, version: null },
    },
    notify,
    confirm,
    beforeQuery: ensureSaved,
  })

  // The running draft follows the edits.
  useEffect(() => {
    if (!host) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useAppEditor.subscribe((state, before) => {
      if (state.definition === before.definition) return
      clearTimeout(timer)
      timer = setTimeout(() => host.update(useAppEditor.getState().definition), UPDATE_DELAY_MS)
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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <h1 className="font-semibold">{app.name}</h1>
        <SaveBadge status={status} />
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label htmlFor="editor-env" className="text-muted">
            Environment
          </label>
          <Select
            id="editor-env"
            value={environment.slug}
            onChange={(e) =>
              navigate({
                to: '/apps/$slug/edit',
                params: { slug: app.slug },
                search: { env: e.target.value },
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
            title={preview ? 'Back to editing' : 'Use the app as people will'}
          >
            {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <ReleaseControls app={app} />
        </div>
      </header>
      {status === 'conflict' && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-border bg-accent-soft px-4 py-2 text-sm"
        >
          Someone else saved this app since you opened it. Your edits here can't be saved.
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
      <div ref={ref} className="hidden" />
      {host ? (
        <AppHostProvider host={host}>
          <ScopeSync />
          <div className="flex min-h-0 flex-1">
            {!preview && (
              <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface p-3">
                <section>
                  <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Add</h2>
                  <Palette />
                </section>
                <section>
                  <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                    Components
                  </h2>
                  <ComponentTree />
                </section>
              </aside>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-4">
                <Running>{preview ? <PreviewCanvas definition={definition} /> : <EditCanvas />}</Running>
              </div>
              {!preview && (
                <div className="h-[38%] min-h-48 shrink-0 border-t border-border">
                  <CodePanel />
                </div>
              )}
            </div>
            {!preview && selected && (
              <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface">
                <ComponentInspector name={selected} />
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

/** The app as people see it, on the page it's on (`utils.openPage` moves it in place). */
function PreviewCanvas({ definition }: { definition: AppDefinition }) {
  const page = useAppValue<string | null>('url.page') ?? null
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
