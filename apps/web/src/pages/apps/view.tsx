import type { AppDefinition } from '@ow/app-definition'
import type { AppUrl, ComponentLibraryReleases, ModuleReleases } from '@ow/app-runtime'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { LayoutGrid, Lock, Pencil } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Button, buttonVariants, EmptyState, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AccountButton } from '../app-shell'
import { AppCanvas } from './canvas'
import { NeededConnections } from './connections'
import { AppChromeContext } from './grid-context'
import { Notifications, useConfirmations, useNotifications } from './notifications'
import { AppHostProvider, useAppHost, useAppHostState, useAppValue } from './runtime/react'
import { AppStopped } from './stopped'
import { ThemedApp } from './themed'

const appRoute = getRouteApi('/app')

/** The query string an app reads as `url.params`: all of it but the platform's own (`env`). */
function appParams(search: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(search)) {
    if (key !== 'env' && value !== undefined && value !== null) params[key] = String(value)
  }
  return params
}

/**
 * Someone using an app: its live release in the environment they pick (`?env=`, the default one otherwise), on the
 * page in the URL (`/apps/<slug>/<page>`, the first page without one).
 */
export function AppViewPage() {
  const { slug } = useParams({ strict: false }) as { slug: string }
  const search = useSearch({ strict: false }) as { env?: string }
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

  if (app.error) return <CannotOpen slug={slug} />
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
      modules={app.data.modules}
      libraries={app.data.libraries}
      environment={environment}
      environments={environments.data}
    />
  )
}

/**
 * The app didn't open: what to do depends on who's asking. Editors get the editor (it isn't published yet); people
 * with Use are told it isn't published; anyone else that it isn't theirs (an app that doesn't exist reads the same).
 */
function CannotOpen({ slug }: { slug: string }) {
  const trpc = useTRPC()
  const access = useQuery(trpc.apps.access.queryOptions({ slug }))
  if (!access.data)
    return <Centered>{access.error ? <ErrorNote error={access.error} /> : <Spinner />}</Centered>
  const { level } = access.data
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-end border-b border-border/70 bg-surface px-4">
        <AccountButton />
      </header>
      <Centered>
        {level === 'edit' || level === 'own' ? (
          <EmptyState icon={<LayoutGrid className="size-6" />} title="Not published yet">
            People can use it once it's published.{' '}
            <Link to="/apps/$slug/edit" params={{ slug }} className="font-medium text-accent hover:underline">
              Open the editor
            </Link>
          </EmptyState>
        ) : level === 'use' ? (
          <EmptyState icon={<LayoutGrid className="size-6" />} title="Not published yet">
            You can use this app once its owner publishes it.
          </EmptyState>
        ) : (
          <EmptyState icon={<Lock className="size-6" />} title="You don't have access to this app">
            Ask an admin or the app's owner for access. (If the link is old, the app may also have been
            removed.)
          </EmptyState>
        )}
      </Centered>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-1 items-center justify-center p-8">{children}</div>
}

interface RunningAppProps {
  app: { id: string; slug: string; name: string; canEdit: boolean }
  release: { id: string; version: string; definition: AppDefinition }
  /** The module releases its instances run (M14). */
  modules: ModuleReleases
  /** The component library releases its custom components run (M25). */
  libraries: ComponentLibraryReleases
  environment: { id: string; slug: string; name: string }
  environments: { id: string; slug: string; name: string }[]
}

function RunningApp({ app, release, modules, libraries, environment, environments }: RunningAppProps) {
  const { me } = appRoute.useRouteContext()
  const navigate = useNavigate()
  const router = useRouter()
  const { page } = useParams({ strict: false }) as { page?: string }
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const urlKey = JSON.stringify([page ?? null, appParams(search)])
  const url = useMemo<AppUrl>(() => {
    const [p, params] = JSON.parse(urlKey) as [string | null, Record<string, string>]
    return { page: p, params }
  }, [urlKey])
  const env = typeof search.env === 'string' ? search.env : undefined
  /**
   * Where `page` with `params` lives, in the environment shown. `env` is the platform's (`appParams` leaves it out
   * on the way in): an app's own `env` param can't switch the viewer's environment.
   */
  const pageLocation = (to: string, params: Record<string, string>) => {
    const { env: _theirs, ...own } = params
    return {
      to: '/apps/$slug/{-$page}' as const,
      params: { slug: app.slug, page: to || undefined },
      search: { ...own, ...(env && { env }) },
    }
  }
  const { notices, notify, dismiss } = useNotifications()
  const { confirm, dialog: confirmation } = useConfirmations()
  const { ref, host } = useAppHost(`${release.id}:${environment.id}`, {
    definition: release.definition,
    modules,
    libraries,
    appId: app.id,
    releaseId: release.id,
    environmentId: environment.id,
    globals: {
      current_user: { id: me.id, email: me.email, name: me.name },
      appContext: { appSlug: app.slug, environment: environment.slug, version: release.version },
    },
    notify,
    confirm,
    url,
    openPage: (to, params, newTab) => {
      const location = pageLocation(to, params)
      if (newTab) window.open(router.buildLocation(location).href, '_blank', 'noopener,noreferrer')
      else void navigate(location)
    },
  })

  // A link, Back or Forward changed the URL: the app moves along (it keeps running).
  useEffect(() => {
    host?.navigate(url)
  }, [host, url])

  return (
    <div className="flex h-full flex-col">
      {/* Just the app: its name, the environment, Edit for those who build it, the account. No platform around it. */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-surface px-4">
        <h1 className="truncate text-base font-semibold">{app.name}</h1>
        {app.canEdit && <span className="text-xs text-muted">v{release.version}</span>}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {environments.length > 1 && (
            <>
              <label htmlFor="app-env" className="text-muted">
                Environment
              </label>
              <Select
                id="app-env"
                value={environment.slug}
                onChange={(e) =>
                  navigate({
                    to: '/apps/$slug/{-$page}',
                    params: { slug: app.slug, page },
                    search: { ...url.params, env: e.target.value },
                  })
                }
              >
                {environments.map((e) => (
                  <option key={e.id} value={e.slug}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </>
          )}
          {app.canEdit && (
            <Link
              to="/apps/$slug/edit"
              params={{ slug: app.slug }}
              className={buttonVariants({ variant: 'tertiary', size: 'md' })}
            >
              <Pencil className="size-3.5" />
              Edit
            </Link>
          )}
          <AccountButton />
        </div>
      </header>
      <div ref={ref} className="hidden" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {host && (
          <AppHostProvider host={host}>
            <AppChromeContext.Provider
              value={{
                appName: app.name,
                user: { name: me.name, email: me.email },
                pageHref: (to, params) => router.buildLocation(pageLocation(to, params)).href,
              }}
            >
              <AppBody definition={release.definition} appName={app.name} />
            </AppChromeContext.Provider>
          </AppHostProvider>
        )}
      </div>
      <Notifications notices={notices} dismiss={dismiss} />
      {confirmation}
    </div>
  )
}

function AppBody({ definition, appName }: { definition: AppDefinition; appName: string }) {
  const status = useAppHostState((s) => s.status)
  const problem = useAppHostState((s) => s.problem)
  // The page the app shows (resolved by the app: an unknown page in the URL shows its first).
  const page = useAppValue<string | null>('url.page') ?? null
  const pageTitle = definition.pages?.find((p) => p.name === page)
  const title = pageTitle ? `${pageTitle.title || pageTitle.name} · ${appName}` : appName
  // The browser tab (and history) names the page.
  useEffect(() => {
    const before = document.title
    document.title = title
    return () => {
      document.title = before
    }
  }, [title])
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
      <AppStopped />
      <NeededConnections />
      <ThemedApp definition={definition}>
        <AppCanvas definition={definition} page={page} />
      </ThemedApp>
    </>
  )
}
