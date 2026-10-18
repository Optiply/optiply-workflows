import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, Outlet, useMatches, useNavigate } from '@tanstack/react-router'
import { LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Avatar, Menu, MenuGroup, MenuItem, MenuSeparator } from '@/components/ui'
import { Wordmark } from '@/components/wordmark'
import { setThemePreference, type ThemePreference, useTheme } from '@/lib/theme'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

const route = getRouteApi('/app')

const NAV: { to: string; label: string }[] = [
  { to: '/workflows', label: 'Workflows' },
  { to: '/apps', label: 'Apps' },
  { to: '/resources', label: 'Resources' },
  { to: '/database', label: 'Database' },
  { to: '/runs', label: 'Runs' },
]

const THEMES: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
]

/** Optiply's frame: a white bar on the blue-grey page, with the page (or a full-bleed editor) under it. */
export function AppShell() {
  const { me } = route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fullBleed = useMatches({ select: (matches) => matches.some((m) => m.staticData.fullBleed) })
  const trpc = useTRPC()
  const openTasks = useQuery({ ...trpc.tasks.openCount.queryOptions(), refetchInterval: 30_000 })
  const { preference } = useTheme()

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    queryClient.clear()
    await navigate({ to: '/login' })
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <nav aria-label="Main" className="flex h-14 shrink-0 items-center gap-4 rounded-lg bg-surface px-4">
        <Link
          to="/"
          aria-label="Home"
          className="mr-2 shrink-0 rounded-md outline-none focus-visible:shadow-focus"
        >
          <Wordmark />
        </Link>
        <div className="flex min-w-0 items-center overflow-x-auto">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} label={item.label} />
          ))}
          <NavLink to="/inbox" label="Inbox" count={openTasks.data} />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link
            to="/settings"
            aria-label="Settings"
            title="Settings"
            activeProps={{ className: navClass(true, 'size-8 justify-center px-0') }}
            inactiveProps={{ className: navClass(false, 'size-8 justify-center px-0') }}
          >
            <Settings className="size-5" />
          </Link>
          <span className="h-6 w-px bg-border" />
          <Menu
            label={`Account: ${me.name}, ${me.email}`}
            trigger={(props) => (
              <button
                type="button"
                aria-label="Account"
                title={me.email}
                className="flex cursor-pointer items-center rounded-full outline-none focus-visible:shadow-focus"
                {...props}
              >
                <Avatar name={me.name} src={me.avatarUrl} className="size-8" />
              </button>
            )}
          >
            <div aria-hidden="true" className="px-2 pt-1 pb-2">
              <div className="truncate text-sm font-semibold">{me.name}</div>
              <div className="truncate text-xs text-muted">{me.email}</div>
            </div>
            <MenuSeparator />
            <MenuGroup label="Theme">
              {THEMES.map((t) => (
                <MenuItem
                  key={t.value}
                  icon={t.icon}
                  checked={preference === t.value}
                  onClick={() => setThemePreference(t.value)}
                >
                  {t.label}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuItem icon={<LogOut />} onClick={logout}>
              Sign out
            </MenuItem>
          </Menu>
        </div>
      </nav>

      <main className={cn('min-h-0 flex-1', fullBleed ? 'overflow-hidden rounded-lg' : 'overflow-y-auto')}>
        {fullBleed ? (
          <Outlet />
        ) : (
          <div className="px-2 pb-2">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  )
}

function navClass(active: boolean, extra?: string) {
  return cn(
    'flex h-8 shrink-0 items-center gap-2 rounded-md px-4 text-sm font-medium text-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent focus-visible:shadow-focus',
    active && 'bg-accent-soft text-accent',
    extra,
  )
}

function NavLink({ to, label, count }: { to: string; label: string; count?: number }) {
  return (
    <Link to={to} activeProps={{ className: navClass(true) }} inactiveProps={{ className: navClass(false) }}>
      {label}
      {!!count && (
        <span
          className="flex h-4 min-w-4 items-center justify-center rounded bg-accent px-1 text-[10px] font-semibold text-on-accent"
          data-testid="inbox-count"
        >
          {count}
        </span>
      )}
    </Link>
  )
}
