import { getRouteApi, Link, Outlet } from '@tanstack/react-router'
import {
  Boxes,
  Database,
  FileCode2,
  GitBranch,
  KeyRound,
  Layers,
  type LucideIcon,
  ScrollText,
  ShieldAlert,
  Ticket,
  Users,
  UsersRound,
  Variable,
} from 'lucide-react'
import { GitProblemsBadge } from '@/components/git-health'
import { PendingUsersBadge } from '@/components/pending-badge'
import { EmptyState, PageHeader, sectionLabelClass } from '@/components/ui'
import { cn } from '@/lib/utils'

const appRoute = getRouteApi('/app')

type SettingsGroup = 'Access' | 'Platform' | 'Monitoring'

export const SETTINGS_TABS: readonly {
  to: string
  label: string
  adminOnly: boolean
  group: SettingsGroup
  icon: LucideIcon
}[] = [
  { to: '/settings/users', label: 'Users', adminOnly: true, group: 'Access', icon: Users },
  { to: '/settings/groups', label: 'Groups', adminOnly: true, group: 'Access', icon: UsersRound },
  { to: '/settings/api-keys', label: 'API keys', adminOnly: true, group: 'Access', icon: KeyRound },
  { to: '/settings/access-tokens', label: 'Access tokens', adminOnly: false, group: 'Access', icon: Ticket },
  { to: '/settings/environments', label: 'Environments', adminOnly: false, group: 'Platform', icon: Layers },
  { to: '/settings/config-vars', label: 'Config vars', adminOnly: false, group: 'Platform', icon: Variable },
  { to: '/settings/git', label: 'Git', adminOnly: true, group: 'Platform', icon: GitBranch },
  { to: '/settings/python', label: 'Python', adminOnly: true, group: 'Platform', icon: FileCode2 },
  { to: '/settings/npm', label: 'npm registries', adminOnly: true, group: 'Platform', icon: Boxes },
  { to: '/settings/jdbc', label: 'JDBC drivers', adminOnly: true, group: 'Platform', icon: Database },
  { to: '/settings/audit', label: 'Audit log', adminOnly: true, group: 'Monitoring', icon: ScrollText },
]

const GROUPS: SettingsGroup[] = ['Access', 'Platform', 'Monitoring']

const itemClass =
  'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted outline-none transition-colors hover:bg-hover/60 hover:text-ink focus-visible:shadow-focus'
const activeItemClass =
  'bg-surface text-accent shadow-raised ring-1 ring-border/70 hover:bg-surface hover:text-accent'

/**
 * Settings: a sub-navigation beside the page (grouped: who has access, how the platform runs, what happened),
 * a scrolling row above it on narrow screens.
 */
export function SettingsLayout() {
  const { me } = appRoute.useRouteContext()
  const tabs = SETTINGS_TABS.filter((t) => me.isAdmin || !t.adminOnly)
  // Only Optiply's admins see Settings (no link in the sidebar or ⌘K); a typed or old link says so.
  if (!me.settings)
    return (
      <EmptyState icon={<ShieldAlert className="size-6" />} title="No access to Settings">
        Settings are for Optiply admins. Ask an admin if you need something changed here.
      </EmptyState>
    )
  return (
    <>
      <PageHeader title="Settings" description="Manage who has access and how the platform is configured." />
      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label="Settings"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-4 lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0"
        >
          {GROUPS.map((group) => {
            const items = tabs.filter((t) => t.group === group)
            if (!items.length) return null
            return (
              <div key={group} className="flex gap-1 lg:flex-col lg:gap-0.5">
                <div className={cn(sectionLabelClass, 'hidden px-2.5 pb-1 lg:block')}>{group}</div>
                {items.map((tab) => (
                  <Link
                    key={tab.to}
                    to={tab.to}
                    activeProps={{ className: cn(itemClass, activeItemClass) }}
                    inactiveProps={{ className: itemClass }}
                  >
                    <tab.icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1">{tab.label}</span>
                    {tab.to === '/settings/git' && me.isAdmin && <GitProblemsBadge />}
                    {tab.to === '/settings/users' && me.isAdmin && <PendingUsersBadge />}
                  </Link>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </>
  )
}

/** Wraps admin-only settings pages so non-admins get a clear message instead of a failed query. */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { me } = appRoute.useRouteContext()
  if (!me.isAdmin) {
    return (
      <EmptyState icon={<ShieldAlert className="size-6" />} title="Admins only">
        Ask an admin to add you to the Admins group if you need access.
      </EmptyState>
    )
  }
  return children
}
