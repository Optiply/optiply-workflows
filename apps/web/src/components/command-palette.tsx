import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Blocks,
  CornerDownLeft,
  Database,
  History,
  Inbox,
  LayoutGrid,
  Library,
  LogOut,
  Monitor,
  Moon,
  Plug,
  Puzzle,
  Search,
  Settings,
  Sun,
  Workflow,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { setThemePreference } from '@/lib/theme'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

/** The sections of the app, in the sidebar's order (the sidebar and the palette share them). */
export const SECTIONS = [
  { to: '/workflows', label: 'Workflows', icon: Workflow, group: 'Build' },
  { to: '/apps', label: 'Apps', icon: LayoutGrid, group: 'Build' },
  { to: '/library', label: 'Library', icon: Library, group: 'Build' },
  { to: '/modules', label: 'Modules', icon: Puzzle, group: 'Build' },
  { to: '/component-libraries', label: 'Components', icon: Blocks, group: 'Build' },
  { to: '/resources', label: 'Resources', icon: Plug, group: 'Data' },
  { to: '/database', label: 'Database', icon: Database, group: 'Data' },
  { to: '/runs', label: 'Runs', icon: History, group: 'Operate' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, group: 'Operate' },
] as const

type Group = 'Pages' | 'Workflows' | 'Apps' | 'Resources' | 'Library' | 'Modules' | 'Components' | 'Actions'
const GROUP_ORDER: Group[] = [
  'Pages',
  'Workflows',
  'Apps',
  'Resources',
  'Library',
  'Modules',
  'Components',
  'Actions',
]

interface Item {
  id: string
  group: Group
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

const canEdit = (level: string | undefined) => level === 'edit' || level === 'own'

/**
 * ⌘K (Ctrl+K) anywhere but an editor with its own palette (the app editor's catches the keys first and stops
 * them) or a code field: toggles the palette.
 */
export function useGlobalPaletteShortcut(toggle: () => void) {
  const latest = useRef(toggle)
  latest.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'k') return
      if (e.target instanceof Element && e.target.closest('.monaco-editor')) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Jump to any page, workflow, app, resource, query, module or component library, or run an action. */
export function GlobalPalette({ onClose, onSignOut }: { onClose: () => void; onSignOut: () => void }) {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const workflows = useQuery(trpc.workflows.list.queryOptions())
  const apps = useQuery(trpc.apps.list.queryOptions())
  const resources = useQuery(trpc.resources.list.queryOptions())
  const library = useQuery(trpc.libraryQueries.list.queryOptions())
  const modules = useQuery(trpc.modules.list.queryOptions())
  const components = useQuery(trpc.componentLibraries.list.queryOptions())
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const icon = (Icon: typeof Workflow) => <Icon className="size-4" />
    const out: Item[] = SECTIONS.map((s) => ({
      id: `page:${s.to}`,
      group: 'Pages',
      label: s.label,
      icon: icon(s.icon),
      run: () => navigate({ to: s.to }),
    }))
    out.push({
      id: 'page:/settings',
      group: 'Pages',
      label: 'Settings',
      icon: icon(Settings),
      run: () => navigate({ to: '/settings' }),
    })
    for (const w of workflows.data ?? [])
      out.push({
        id: `wf:${w.id}`,
        group: 'Workflows',
        label: w.name,
        hint: w.slug,
        icon: icon(Workflow),
        run: () => navigate({ to: '/workflows/$workflowId', params: { workflowId: w.id } }),
      })
    for (const a of apps.data ?? []) {
      const edit = canEdit(a.level)
      if (!a.liveReleaseId && !edit) continue
      out.push({
        id: `app:${a.id}`,
        group: 'Apps',
        label: a.name,
        hint: a.slug,
        icon: icon(LayoutGrid),
        run: () =>
          edit
            ? navigate({ to: '/apps/$slug/edit', params: { slug: a.slug } })
            : navigate({ to: '/apps/$slug/{-$page}', params: { slug: a.slug } }),
      })
    }
    for (const r of resources.data?.resources ?? [])
      out.push({
        id: `res:${r.id}`,
        group: 'Resources',
        label: r.name,
        hint: r.slug,
        icon: icon(Plug),
        run: () => navigate({ to: '/resources/$resourceId', params: { resourceId: r.id } }),
      })
    for (const q of library.data ?? [])
      if (canEdit(q.level))
        out.push({
          id: `lib:${q.slug}`,
          group: 'Library',
          label: q.name,
          hint: q.slug,
          icon: icon(Library),
          run: () => navigate({ to: '/library/$slug', params: { slug: q.slug } }),
        })
    for (const m of modules.data ?? [])
      if (canEdit(m.level))
        out.push({
          id: `mod:${m.slug}`,
          group: 'Modules',
          label: m.name,
          hint: m.slug,
          icon: icon(Puzzle),
          run: () => navigate({ to: '/modules/$slug', params: { slug: m.slug } }),
        })
    for (const c of components.data ?? [])
      if (canEdit(c.level))
        out.push({
          id: `cmp:${c.slug}`,
          group: 'Components',
          label: c.name,
          hint: c.slug,
          icon: icon(Blocks),
          run: () => navigate({ to: '/component-libraries/$slug', params: { slug: c.slug } }),
        })
    out.push(
      {
        id: 'act:light',
        group: 'Actions',
        label: 'Light theme',
        icon: icon(Sun),
        run: () => setThemePreference('light'),
      },
      {
        id: 'act:dark',
        group: 'Actions',
        label: 'Dark theme',
        icon: icon(Moon),
        run: () => setThemePreference('dark'),
      },
      {
        id: 'act:system',
        group: 'Actions',
        label: 'System theme',
        icon: icon(Monitor),
        run: () => setThemePreference('system'),
      },
      { id: 'act:signout', group: 'Actions', label: 'Sign out', icon: icon(LogOut), run: onSignOut },
    )
    return out
  }, [
    navigate,
    onSignOut,
    workflows.data,
    apps.data,
    resources.data,
    library.data,
    modules.data,
    components.data,
  ])

  // Without a query: pages and actions only (the rest is a search away). With one: every match, best first.
  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return GROUP_ORDER.filter((g) => g === 'Pages' || g === 'Actions').map((title) => ({
        title,
        items: items.filter((i) => i.group === title),
      }))
    }
    const scored = items
      .map((item) => {
        const label = item.label.toLowerCase()
        const hint = item.hint?.toLowerCase() ?? ''
        const score = label.startsWith(q)
          ? 0
          : label.includes(q)
            ? 1
            : hint.startsWith(q)
              ? 2
              : hint.includes(q)
                ? 3
                : -1
        return { item, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.item)
    return GROUP_ORDER.map((title) => ({ title, items: scored.filter((i) => i.group === title) })).filter(
      (g) => g.items.length,
    )
  }, [items, query])
  const flat = ordered.flatMap((g) => g.items)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the option moved to with the keys scrolls into view
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[12vh] backdrop-blur-[2px] motion-safe:animate-fade-in">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes the palette; Escape too */}
      <div className="absolute inset-0" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        className="relative flex max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-2xl bg-surface shadow-menu motion-safe:animate-pop-in"
      >
        <div className="flex items-center gap-2.5 border-b border-border/70 px-4">
          <Search className="size-4 text-muted" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette opens to be typed in
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="global-palette-list"
            aria-activedescendant={flat[active] ? `go-${flat[active]!.id}` : undefined}
            aria-label="Search pages, workflows, apps, resources and actions"
            placeholder="Search workflows, apps, resources… or jump to a page"
            className="h-13 flex-1 bg-transparent text-[15px] outline-none"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(flat.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(flat[active])
              }
            }}
          />
          <kbd className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">
            esc
          </kbd>
        </div>
        <div
          ref={list}
          id="global-palette-list"
          role="listbox"
          aria-label="Results"
          className="overflow-y-auto p-2"
        >
          {!flat.length && (
            <p className="px-2 py-6 text-center text-sm text-muted">Nothing matches “{query}”.</p>
          )}
          {ordered.map((group) => (
            <div key={group.title} className="pb-1">
              <div aria-hidden className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted">
                {group.title}
              </div>
              {group.items.map((item) => {
                const index = flat.indexOf(item)
                const selected = index === active
                return (
                  <div
                    key={item.id}
                    id={selected ? `go-${item.id}` : undefined}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseMove={() => setActive(index)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(item)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') choose(item)
                    }}
                    className={cn(
                      'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm',
                      selected ? 'bg-accent-soft text-accent' : 'text-ink',
                    )}
                  >
                    <span className={cn('shrink-0', selected ? 'text-accent' : 'text-muted')}>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                    {item.hint && (
                      <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted">
                        {item.hint}
                      </span>
                    )}
                    {selected && <CornerDownLeft className="size-3.5 shrink-0" />}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
