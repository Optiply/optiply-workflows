import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { LayoutGrid, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Card, EmptyState, ErrorNote, Input, ListSkeleton } from '@/components/ui'
import { Wordmark } from '@/components/wordmark'
import { useTRPC } from '@/lib/trpc'
import { AccountButton } from './app-shell'

const appRoute = getRouteApi('/app')

/** A search box only once the list is long enough to need one. */
const SEARCH_FROM = 7

/**
 * Where someone whose access is apps only lands (and comes back to from any of their apps): the apps shared with
 * them, nothing of the platform around them. Admins and builders reach it too (their apps, the same way).
 */
export function MyAppsPage() {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const apps = useQuery(trpc.apps.list.queryOptions())
  const [search, setSearch] = useState('')
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const all = apps.data ?? []
    return q
      ? all.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q))
      : all
  }, [apps.data, search])

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-surface px-4 sm:px-6">
        <Wordmark />
        <div className="ml-auto">
          <AccountButton />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">Your apps</h1>
          <p className="mt-1 text-sm text-muted">
            Hi {me.name.split(' ')[0]}, these are the apps shared with you.
          </p>
          {apps.error ? (
            <div className="mt-6">
              <ErrorNote error={apps.error} />
            </div>
          ) : !apps.data ? (
            <div className="mt-6">
              <ListSkeleton rows={3} header={false} />
            </div>
          ) : apps.data.length === 0 ? (
            <div className="mt-10">
              <EmptyState icon={<LayoutGrid className="size-6" />} title="No apps shared with you yet">
                Ask an admin for access to the apps you need; they show up here once you have it.
              </EmptyState>
            </div>
          ) : (
            <>
              {apps.data.length >= SEARCH_FROM && (
                <div className="relative mt-6">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <Input
                    aria-label="Search your apps"
                    placeholder="Search your apps"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              )}
              <Card className="mt-6 divide-y divide-border" data-testid="my-apps">
                {shown.map((app) => {
                  const body = (
                    <>
                      <span className="rounded-md bg-accent-soft p-2 text-accent">
                        <LayoutGrid className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{app.name}</div>
                        {app.description && (
                          <div className="truncate text-sm text-muted">{app.description}</div>
                        )}
                      </div>
                    </>
                  )
                  return app.liveReleaseId ? (
                    <Link
                      key={app.id}
                      to="/apps/$slug/{-$page}"
                      params={{ slug: app.slug }}
                      className="flex items-center gap-3 px-4 py-3.5 outline-none transition-colors hover:bg-hover/60 focus-visible:bg-hover/60"
                      data-testid={`my-app-${app.slug}`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div
                      key={app.id}
                      className="flex items-center gap-3 px-4 py-3.5 opacity-70"
                      data-testid={`my-app-${app.slug}`}
                    >
                      {body}
                      <Badge>Not published yet</Badge>
                    </div>
                  )
                })}
                {shown.length === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-muted">No app matches “{search}”.</p>
                )}
              </Card>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
