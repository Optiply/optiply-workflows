import type { AppDefinition } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { Button, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AppCanvas } from './canvas'
import { Notifications, useConfirmations, useNotifications } from './notifications'
import { AppHostProvider, useAppHost, useAppHostState } from './runtime/react'

const route = getRouteApi('/app/apps/$slug')
const appRoute = getRouteApi('/app')

/** Someone using an app: its live release in the environment they pick (`?env=`, the default one otherwise). */
export function AppViewPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const trpc = useTRPC()
  // The live release is loaded once per visit: a publish or rollback meanwhile mustn't restart the app under
  // someone mid-task (and lose what they typed). The next query they run says a newer version is live (Reload).
  const app = useQuery({
    ...trpc.apps.open.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const environments = useQuery(trpc.environments.list.queryOptions())

  if (app.error)
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          <ErrorNote error={app.error} />
          {/* Not published yet: whoever can edit it gets there from here (the editor refuses everyone else). */}
          <Link to="/apps/$slug/edit" params={{ slug }} className="text-sm text-accent hover:underline">
            Open the editor
          </Link>
        </div>
      </Centered>
    )
  if (environments.error)
    return (
      <Centered>
        <ErrorNote error={environments.error} />
      </Centered>
    )
  if (!app.data || !environments.data)
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
    <RunningApp
      key={`${app.data.release.id}:${environment.id}`}
      app={{ id: app.data.id, slug: app.data.slug, name: app.data.name, canEdit: app.data.level !== 'use' }}
      release={{
        id: app.data.release.id,
        version: app.data.release.version,
        definition: app.data.release.definition,
      }}
      environment={environment}
      environments={environments.data}
    />
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8">{children}</div>
}

interface RunningAppProps {
  app: { id: string; slug: string; name: string; canEdit: boolean }
  release: { id: string; version: string; definition: AppDefinition }
  environment: { id: string; slug: string; name: string }
  environments: { id: string; slug: string; name: string }[]
}

function RunningApp({ app, release, environment, environments }: RunningAppProps) {
  const { me } = appRoute.useRouteContext()
  const navigate = useNavigate()
  const { notices, notify, dismiss } = useNotifications()
  const { confirm, dialog: confirmation } = useConfirmations()
  const { ref, host } = useAppHost(`${release.id}:${environment.id}`, {
    definition: release.definition,
    appId: app.id,
    releaseId: release.id,
    environmentId: environment.id,
    globals: {
      current_user: { id: me.id, email: me.email, name: me.name },
      appContext: { appSlug: app.slug, environment: environment.slug, version: release.version },
    },
    notify,
    confirm,
  })

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-6 py-2.5">
        <h1 className="font-semibold">{app.name}</h1>
        <span className="text-xs text-muted">v{release.version}</span>
        {app.canEdit && (
          <Link
            to="/apps/$slug/edit"
            params={{ slug: app.slug }}
            className="text-xs text-accent hover:underline"
          >
            Edit
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label htmlFor="app-env" className="text-muted">
            Environment
          </label>
          <Select
            id="app-env"
            value={environment.slug}
            onChange={(e) =>
              navigate({ to: '/apps/$slug', params: { slug: app.slug }, search: { env: e.target.value } })
            }
          >
            {environments.map((e) => (
              <option key={e.id} value={e.slug}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
      </header>
      <div ref={ref} className="hidden" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {host && (
          <AppHostProvider host={host}>
            <AppBody definition={release.definition} />
          </AppHostProvider>
        )}
      </div>
      <Notifications notices={notices} dismiss={dismiss} />
      {confirmation}
    </div>
  )
}

function AppBody({ definition }: { definition: AppDefinition }) {
  const status = useAppHostState((s) => s.status)
  const problem = useAppHostState((s) => s.problem)
  if (status === 'failed') return <ErrorNote error={new Error(problem ?? 'The app could not start')} />
  if (status === 'loading') return <Spinner />
  return (
    <>
      {problem && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-3 rounded-md border border-border bg-accent-soft px-3 py-2 text-sm"
        >
          {problem}
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
      <AppCanvas definition={definition} />
    </>
  )
}
