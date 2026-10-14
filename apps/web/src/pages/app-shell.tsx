import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, Outlet, useMatches, useNavigate } from '@tanstack/react-router'
import { Database, History, Inbox, LogOut, Plug, Settings, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'
import { Avatar } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

const route = getRouteApi('/app')

const NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/workflows', label: 'Workflows', icon: <Workflow className="size-4" /> },
  { to: '/resources', label: 'Resources', icon: <Plug className="size-4" /> },
  { to: '/runs', label: 'Runs', icon: <History className="size-4" /> },
]

export function AppShell() {
  const { me } = route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fullBleed = useMatches({ select: (matches) => matches.some((m) => m.staticData.fullBleed) })
  const trpc = useTRPC()
  const openTasks = useQuery({ ...trpc.tasks.openCount.queryOptions(), refetchInterval: 30_000 })

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    queryClient.clear()
    await navigate({ to: '/login' })
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <div className="rounded-lg bg-accent p-1.5 text-white">
            <Workflow className="size-4" />
          </div>
          <span className="font-semibold tracking-tight">Optiply Workflows</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} icon={item.icon} label={item.label} />
          ))}
          <NavLink to="/inbox" icon={<Inbox className="size-4" />} label="Inbox" count={openTasks.data} />
          <div className="px-2 pt-4 pb-1 text-xs font-medium text-muted">Coming later</div>
          <span className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted/60">
            <Database className="size-4" /> Database
          </span>
        </nav>

        <div className="border-t border-border p-2">
          <NavLink to="/settings" icon={<Settings className="size-4" />} label="Settings" />
          <div className="mt-2 flex items-center gap-2.5 rounded-md px-2 py-2">
            <Avatar name={me.name} src={me.avatarUrl} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{me.name}</div>
              <div className="truncate text-xs text-muted">{me.email}</div>
            </div>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className="rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className={fullBleed ? 'min-w-0 flex-1 overflow-hidden' : 'min-w-0 flex-1 overflow-y-auto'}>
        {fullBleed ? (
          <Outlet />
        ) : (
          <div className="mx-auto max-w-6xl px-8 py-8">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  )
}

function NavLink({ to, icon, label, count }: { to: string; icon: ReactNode; label: string; count?: number }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-black/5 hover:text-ink"
      activeProps={{ className: 'bg-accent-soft! text-accent! font-medium' }}
    >
      {icon}
      {label}
      {!!count && (
        <span
          className="ml-auto rounded-full bg-accent px-1.5 text-xs font-medium text-white"
          data-testid="inbox-count"
        >
          {count}
        </span>
      )}
    </Link>
  )
}
