import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { ChevronRight, Settings } from 'lucide-react'
import { Fragment } from 'react'
import { SECTIONS } from '@/components/command-palette'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { SETTINGS_TABS } from '@/pages/settings/layout'

interface Crumb {
  label: string
  to?: string
}

/** A record's display name from a `get` query's answer, whatever it wraps it in. */
function nameOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  for (const key of ['name', 'title']) if (typeof d[key] === 'string' && d[key]) return d[key] as string
  for (const key of ['workflow', 'app', 'resource', 'query', 'module', 'library', 'task', 'group']) {
    const inner = nameOf(d[key])
    if (inner) return inner
  }
  return undefined
}

/**
 * The record a detail page shows, read from the cache only: the page fetches it with the same query, so the crumb
 * costs no request and fills in when the page's answer arrives (until then, the slug or nothing).
 */
function useRecordName(path: string): string | undefined {
  const trpc = useTRPC()
  const [, section, a, b] = path.split('/')
  // Never fetched, and never kept: a query keeps the longest gcTime of those watching it, and editors drop theirs
  // at once (gcTime 0) so a slug reused by a new record loads afresh.
  const cacheOnly = { enabled: false, retry: false, gcTime: 0 } as const
  const id = a ?? ''
  const queries = {
    workflows: useQuery({ ...trpc.workflows.get.queryOptions({ id }), ...cacheOnly }),
    apps: useQuery({ ...trpc.apps.get.queryOptions({ slug: id }), ...cacheOnly }),
    // Someone using the app: its page loads the live release, not the draft.
    appView: useQuery({ ...trpc.apps.open.queryOptions({ slug: id }), ...cacheOnly }),
    // An app that didn't open: its page asks for the caller's access, which names it when it's theirs.
    appAccess: useQuery({ ...trpc.apps.access.queryOptions({ slug: id }), ...cacheOnly }),
    resources: useQuery({ ...trpc.resources.get.queryOptions({ id }), ...cacheOnly }),
    library: useQuery({ ...trpc.libraryQueries.get.queryOptions({ slug: id }), ...cacheOnly }),
    modules: useQuery({ ...trpc.modules.get.queryOptions({ slug: id }), ...cacheOnly }),
    'component-libraries': useQuery({
      ...trpc.componentLibraries.get.queryOptions({ slug: id }),
      ...cacheOnly,
    }),
    inbox: useQuery({ ...trpc.tasks.get.queryOptions({ id }), ...cacheOnly }),
    groups: useQuery({ ...trpc.groups.get.queryOptions({ id: b ?? '' }), ...cacheOnly }),
    // A person's page reads the users list (admins only), so their crumb does too.
    people: useQuery({ ...trpc.users.list.queryOptions(), ...cacheOnly }),
  }
  if (section === 'settings') {
    if (a === 'groups' && b) return nameOf(queries.groups.data)
    if (a === 'users' && b) return queries.people.data?.find((u) => u.id === b)?.name
    return undefined
  }
  if (!a || !section || !(section in queries)) return undefined
  const record = queries[section as keyof typeof queries]
  const named =
    nameOf(record.data) ??
    (section === 'apps'
      ? (nameOf(queries.appView.data) ?? queries.appAccess.data?.name ?? undefined)
      : undefined)
  // The page couldn't load it (gone, or no access): say so rather than "…" for ever.
  if (!named && (record.isError || (section === 'apps' && queries.appView.isError))) return 'Not available'
  // Slugs read well enough while the page loads; ids don't.
  return named ?? (['apps', 'library', 'modules', 'component-libraries'].includes(section) ? a : undefined)
}

function crumbsFor(path: string, recordName: string | undefined): Crumb[] {
  const [, section, a, b] = path.split('/')
  if (section === 'settings') {
    const crumbs: Crumb[] = [{ label: 'Settings', to: '/settings' }]
    const tab = SETTINGS_TABS.find((t) => t.to === `/settings/${a}`)
    if (tab) crumbs.push({ label: tab.label, to: tab.to })
    if (a === 'groups' && b) crumbs.push({ label: recordName ?? 'Group' })
    if (a === 'users' && b) crumbs.push({ label: recordName ?? 'Person' })
    return crumbs
  }
  const known = SECTIONS.find((s) => s.to === `/${section}`)
  if (!known) return []
  const crumbs: Crumb[] = [{ label: known.label, to: known.to }]
  if (a) crumbs.push({ label: recordName ?? '…' })
  if (section === 'apps' && a && b === 'edit') crumbs.push({ label: 'Editor' })
  return crumbs
}

/** The slim bar over every page: where you are, each step a link back up. */
export function Breadcrumbs({ className }: { className?: string }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const recordName = useRecordName(path)
  const crumbs = crumbsFor(path, recordName)
  const icon = SECTIONS.find((s) => path === s.to || path.startsWith(`${s.to}/`))?.icon
  const Icon = icon ?? (path.startsWith('/settings') ? Settings : undefined)
  return (
    <nav aria-label="Breadcrumbs" className={cn('flex min-w-0 items-center gap-1 text-sm', className)}>
      {Icon && <Icon className="mr-1 size-4 shrink-0 text-faint" />}
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1
        return (
          <Fragment key={crumb.to ?? `here:${crumb.label}`}>
            {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint" />}
            {crumb.to && !last ? (
              <Link
                to={crumb.to}
                activeOptions={{ exact: true }}
                className="truncate rounded px-1 text-muted outline-none transition-colors hover:text-ink focus-visible:shadow-focus"
              >
                {crumb.label}
              </Link>
            ) : (
              <span aria-current={last ? 'page' : undefined} className="truncate px-1 font-medium text-ink">
                {crumb.label}
              </span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
