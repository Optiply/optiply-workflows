import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, Outlet, useLocation, useMatches, useNavigate } from '@tanstack/react-router'
import {
  ChevronsUpDown,
  Lock,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { type ComponentType, useCallback, useEffect, useState } from 'react'
import { Breadcrumbs } from '@/components/breadcrumbs'
import {
  GlobalPalette,
  SECTIONS,
  useGlobalPaletteShortcut,
  visibleSections,
} from '@/components/command-palette'
import { GitHealthBanner, GitProblemsBadge } from '@/components/git-health'
import { useStoredChoice } from '@/components/list-toolbar'
import { PendingUsersBadge } from '@/components/pending-badge'
import { TopBarSlot } from '@/components/top-bar'
import { Avatar, EmptyState, Menu, MenuGroup, MenuItem, MenuSeparator } from '@/components/ui'
import { Wordmark } from '@/components/wordmark'
import { IS_MAC } from '@/lib/shortcuts'
import { setThemePreference, type ThemePreference, useTheme } from '@/lib/theme'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

const route = getRouteApi('/app')

const THEMES: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
]

const GROUPS = ['Build', 'Data', 'Operate'] as const

const isSidebarState = (v: unknown): v is 'open' | 'collapsed' => v === 'open' || v === 'collapsed'

/** Narrow windows get the icon-only sidebar whatever was chosen. */
function useNarrow() {
  const query = '(max-width: 900px)'
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setNarrow(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return narrow
}

/** The frame: a sidebar with the sections, search (⌘K), Settings and the account; the page or an editor beside it. */
export function AppShell() {
  const { me } = route.useRouteContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fullBleed = useMatches({ select: (matches) => matches.some((m) => m.staticData.fullBleed) })
  const inEditor = useMatches({ select: (matches) => matches.some((m) => m.staticData.editor) })
  const trpc = useTRPC()
  const openTasks = useQuery({ ...trpc.tasks.openCount.queryOptions(), refetchInterval: 30_000 })
  const { preference } = useTheme()
  // Editors fold the sidebar to icons by default (the canvas wants the width); each choice is remembered apart.
  const [listState, setListState] = useStoredChoice('ow-sidebar', isSidebarState, 'open')
  const [editorState, setEditorState] = useStoredChoice('ow-sidebar-editor', isSidebarState, 'collapsed')
  const [state, setState] = inEditor ? [editorState, setEditorState] : [listState, setListState]
  const narrow = useNarrow()
  const collapsed = narrow || state === 'collapsed'
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // Only the sections they can reach; the URL of another shows that it isn't theirs.
  const sections = visibleSections(me)
  const pathname = useLocation({ select: (l) => l.pathname })
  const blocked = SECTIONS.find((s) => s.to === pathname && !me.sections[s.key])
  const [palette, setPalette] = useState(false)
  useGlobalPaletteShortcut(() => setPalette((p) => !p))

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    queryClient.clear()
    await navigate({ to: '/login' })
  }, [navigate, queryClient])

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border/70 bg-surface transition-[width] duration-200 ease-out',
          collapsed ? 'w-[60px]' : 'w-60',
        )}
      >
        <div className={cn('flex h-12 shrink-0 items-center', collapsed ? 'justify-center' : 'px-4')}>
          <Link
            to="/"
            aria-label="Home"
            className="shrink-0 rounded-md outline-none focus-visible:shadow-focus"
          >
            {collapsed ? (
              <span className="text-[24px] leading-none font-bold tracking-[-0.5px] text-logo">o.</span>
            ) : (
              <Wordmark />
            )}
          </Link>
        </div>

        <div className={cn('pb-2', collapsed ? 'px-2.5' : 'px-3')}>
          <button
            type="button"
            onClick={() => setPalette(true)}
            title={`Search (${IS_MAC ? '⌘' : 'Ctrl+'}K)`}
            aria-label="Search"
            className={cn(
              'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-canvas/60 text-sm text-faint outline-none transition-colors hover:border-divider hover:text-muted focus-visible:shadow-focus',
              collapsed ? 'justify-center' : 'px-2.5',
            )}
          >
            <Search className="size-4 shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Search…</span>
                <kbd className="rounded border border-border bg-surface px-1 font-sans text-[11px] text-muted">
                  {IS_MAC ? '⌘K' : 'Ctrl K'}
                </kbd>
              </>
            )}
          </button>
        </div>

        <nav
          aria-label="Main"
          className={cn('min-h-0 flex-1 overflow-y-auto', collapsed ? 'px-2.5' : 'px-3')}
        >
          {GROUPS.filter((group) => sections.some((s) => s.group === group)).map((group) => (
            <div key={group} className="pt-3">
              {collapsed ? (
                <div aria-hidden className="mx-2 mb-2 border-t border-border/70" />
              ) : (
                <div aria-hidden className="px-2 pb-1 text-[11px] font-medium text-faint">
                  {group}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {sections
                  .filter((s) => s.group === group)
                  .map((s) => (
                    <NavLink
                      key={s.to}
                      to={s.to}
                      label={s.label}
                      icon={s.icon}
                      collapsed={collapsed}
                      count={s.to === '/inbox' ? openTasks.data : undefined}
                    />
                  ))}
              </div>
            </div>
          ))}
        </nav>

        <div className={cn('flex shrink-0 flex-col gap-0.5 py-3', collapsed ? 'px-2.5' : 'px-3')}>
          <Link
            to="/settings"
            aria-label="Settings"
            title={collapsed ? 'Settings' : undefined}
            activeProps={{ className: navClass(true, collapsed) }}
            inactiveProps={{ className: navClass(false, collapsed) }}
          >
            <span className="relative">
              <Settings className="size-4" />
              {me.isAdmin && <GitProblemsBadge className="absolute -top-2 -right-2" />}
              {me.isAdmin && <PendingUsersBadge className="absolute -right-2 -bottom-2" />}
            </span>
            {!collapsed && <span>Settings</span>}
          </Link>
          {!narrow && (
            <button
              type="button"
              onClick={() => setState(collapsed ? 'open' : 'collapsed')}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={navClass(false, collapsed)}
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              {!collapsed && <span>Collapse</span>}
            </button>
          )}
          <div className="mt-2 border-t border-border/70 pt-3">
            <Menu
              label={`Account: ${me.name}, ${me.email}`}
              side="top"
              align="start"
              trigger={(props) => (
                <button
                  type="button"
                  aria-label="Account"
                  title={me.email}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2.5 rounded-md text-left outline-none transition-colors hover:bg-hover/60 focus-visible:shadow-focus',
                    collapsed ? 'justify-center p-1' : 'p-1.5',
                  )}
                  {...props}
                >
                  <Avatar name={me.name} src={me.avatarUrl} className="size-7 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{me.name}</span>
                        <span className="block truncate text-xs text-muted">{me.email}</span>
                      </span>
                      <ChevronsUpDown className="size-4 shrink-0 text-faint" />
                    </>
                  )}
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
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-surface px-4">
          <Breadcrumbs className={inEditor ? 'min-w-0 shrink' : 'flex-1'} />
          <div ref={setSlot} className="flex min-w-0 flex-1 items-center gap-2 empty:hidden" />
        </header>
        {me.isAdmin && (
          <div className="px-2 pt-2 empty:hidden">
            <GitHealthBanner />
          </div>
        )}
        {fullBleed ? (
          <main className="min-h-0 flex-1 p-2">
            <div className="h-full overflow-hidden rounded-lg">
              {blocked ? (
                <div className="h-full overflow-y-auto px-4 pt-4">
                  <NoAccess label={blocked.label} />
                </div>
              ) : (
                <TopBarSlot.Provider value={slot}>
                  <Outlet />
                </TopBarSlot.Provider>
              )}
            </div>
          </main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1600px] px-6 pt-4 pb-8">
              {blocked ? <NoAccess label={blocked.label} /> : <Outlet />}
            </div>
          </main>
        )}
      </div>

      {palette && <GlobalPalette onClose={() => setPalette(false)} onSignOut={logout} />}
    </div>
  )
}

/** A section's page someone can't reach (typed or an old link): no list of nothing, but why. */
function NoAccess({ label }: { label: string }) {
  return (
    <EmptyState icon={<Lock className="size-6" />} title={`No access to ${label}`}>
      Nothing in {label} has been shared with you. Ask an admin if you need it; once they give you access it
      shows up here after a reload.
    </EmptyState>
  )
}

function navClass(active: boolean, collapsed: boolean) {
  return cn(
    'relative flex h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-md text-sm font-medium text-muted outline-none transition-colors hover:bg-hover/60 hover:text-ink focus-visible:shadow-focus',
    collapsed ? 'justify-center px-0' : 'px-2',
    active && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
  )
}

function NavLink({
  to,
  label,
  icon: Icon,
  collapsed,
  count,
}: {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  collapsed: boolean
  count?: number
}) {
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      activeProps={{ className: navClass(true, collapsed) }}
      inactiveProps={{ className: navClass(false, collapsed) }}
    >
      <Icon className="size-4 shrink-0" />
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{label}</span>
      {!!count && (
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-accent font-semibold text-on-accent',
            collapsed
              ? 'absolute top-0.5 right-1 h-3.5 min-w-3.5 px-0.5 text-[9px]'
              : 'h-[18px] min-w-[18px] px-1.5 text-[11px]',
          )}
          data-testid="inbox-count"
        >
          {count}
        </span>
      )}
    </Link>
  )
}
