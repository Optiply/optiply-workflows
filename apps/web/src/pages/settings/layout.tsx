import { getRouteApi, Link, Outlet } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import { GitProblemsBadge } from '@/components/git-health'
import { EmptyState, PageHeader, tabClass } from '@/components/ui'

const appRoute = getRouteApi('/app')

export const SETTINGS_TABS = [
  { to: '/settings/users', label: 'Users', adminOnly: true },
  { to: '/settings/groups', label: 'Groups', adminOnly: true },
  { to: '/settings/environments', label: 'Environments', adminOnly: false },
  { to: '/settings/config-vars', label: 'Config vars', adminOnly: false },
  { to: '/settings/api-keys', label: 'API keys', adminOnly: true },
  { to: '/settings/access-tokens', label: 'Access tokens', adminOnly: false },
  { to: '/settings/git', label: 'Git', adminOnly: true },
  { to: '/settings/python', label: 'Python', adminOnly: true },
  { to: '/settings/components', label: 'Components', adminOnly: true },
  { to: '/settings/audit', label: 'Audit log', adminOnly: true },
] as const

export function SettingsLayout() {
  const { me } = appRoute.useRouteContext()
  return (
    <>
      <PageHeader title="Settings" description="Manage who has access and how the platform is configured." />
      <div className="mb-4 flex flex-wrap gap-2">
        {SETTINGS_TABS.filter((t) => me.isAdmin || !t.adminOnly).map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeProps={{ className: tabClass(true) }}
            inactiveProps={{ className: tabClass(false) }}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {tab.to === '/settings/git' && me.isAdmin && <GitProblemsBadge />}
            </span>
          </Link>
        ))}
      </div>
      <Outlet />
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
