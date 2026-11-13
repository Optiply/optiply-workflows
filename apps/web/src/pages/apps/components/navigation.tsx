import { NAV_URL, type NavIcon } from '@ow/app-definition'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type MouseEvent, useContext, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { AppChromeContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { useAppHostContext, useAppValue } from '../runtime/react'
import { NAV_ICON_COMPONENTS } from './nav-icons'

type Link =
  | { kind: 'page'; key: string; label: string; icon?: NavIcon; page: string; params: Record<string, string> }
  | { kind: 'url'; key: string; label: string; icon?: NavIcon; url: string }
  /** An action (M36): sets the navigation's `clickedItem` to `item` and fires `click`. */
  | { kind: 'action'; key: string; label: string; icon?: NavIcon; item: string }
  | { kind: 'group'; key: string; label: string; icon?: NavIcon; links: Link[] }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The links to show, from the evaluated items (M24): pages that exist (with their URL params), web and mail links,
 * one level of groups; hidden ones (`hidden` truthy) and groups left empty are left out.
 */
function linksOf(items: unknown, title: (page: string) => string | undefined, depth = 0): Link[] {
  if (!Array.isArray(items)) return []
  return items.flatMap((item, n): Link[] => {
    if (
      !record(item) ||
      item.hidden === true ||
      (typeof item.hidden !== 'boolean' && item.hidden && item.hidden !== 'false')
    )
      return []
    const icon =
      typeof item.icon === 'string' && item.icon in NAV_ICON_COMPONENTS ? (item.icon as NavIcon) : undefined
    const given = typeof item.label === 'string' && item.label ? item.label : undefined
    const key = `${n}`
    if (Array.isArray(item.items)) {
      if (depth > 0) return []
      const links = linksOf(item.items, title, 1)
      return links.length
        ? [{ kind: 'group', key, label: given ?? 'Menu', ...(icon && { icon }), links }]
        : []
    }
    if (typeof item.url === 'string' && item.url) {
      const url = item.url.trim()
      return NAV_URL.test(url) ? [{ kind: 'url', key, label: given ?? url, ...(icon && { icon }), url }] : []
    }
    if (typeof item.page !== 'string') {
      return typeof item.key === 'string' && item.key
        ? [{ kind: 'action', key, label: given ?? item.key, ...(icon && { icon }), item: item.key }]
        : []
    }
    const pageTitle = title(item.page)
    if (pageTitle === undefined) return []
    const params = record(item.params)
      ? Object.fromEntries(
          Object.entries(item.params).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]),
        )
      : {}
    return [{ kind: 'page', key, label: given ?? pageTitle, ...(icon && { icon }), page: item.page, params }]
  })
}

/**
 * Links to the app's pages and beyond (M24): the `items` given, or every page by title. Links are real links (open
 * in a new tab, copy the address); a plain click on a page opens it in place, like `utils.openPage`. Groups are a
 * dropdown when horizontal and a foldable list when vertical, open while one of their pages is shown.
 */
export function NavigationRenderer({ component, definition }: RendererProps) {
  const name = component.name
  const items = useAppValue<unknown>(`${name}.items`)
  const orientation = useAppValue<'horizontal' | 'vertical'>(`${name}.orientation`)
  const current = useAppValue<string | null>('url.page')
  const pages = definition.pages ?? []
  const title = (page: string) => {
    const p = pages.find((x) => x.name === page)
    return p ? p.title || p.name : undefined
  }
  const links: Link[] =
    Array.isArray(items) && items.length
      ? linksOf(items, title)
      : pages.map((p) => ({ kind: 'page', key: p.name, label: p.title || p.name, page: p.name, params: {} }))
  const vertical = orientation === 'vertical'
  return (
    <nav aria-label={name} className="h-full">
      <ul className={cn('flex gap-1', vertical ? 'flex-col' : 'flex-wrap items-center')}>
        {links.map((link) => (
          <li key={link.key} className="relative">
            {link.kind === 'group' ? (
              <NavGroup owner={name} link={link} vertical={vertical} current={current} />
            ) : (
              <NavLink owner={name} link={link} vertical={vertical} current={current} />
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

const linkClass = (here: boolean, vertical: boolean) =>
  cn(
    'flex h-8 cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
    vertical && 'w-full',
    here ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-accent-soft hover:text-accent',
  )

function Icon({ icon }: { icon?: NavIcon }) {
  if (!icon) return null
  const Component = NAV_ICON_COMPONENTS[icon]
  return <Component className="size-4 shrink-0" aria-hidden />
}

function NavLink({
  owner,
  link,
  vertical,
  current,
  onOpen,
}: {
  owner: string
  link: Exclude<Link, { kind: 'group' }>
  vertical: boolean
  current: string | null
  onOpen?: () => void
}) {
  const host = useAppHostContext()
  const { pageHref } = useContext(AppChromeContext)
  const clicked = useAppValue<unknown>(`${owner}.clickedItem`)
  if (link.kind === 'action') {
    return (
      <button
        type="button"
        aria-current={clicked === link.item ? 'true' : undefined}
        className={linkClass(clicked === link.item, vertical)}
        onClick={() => {
          onOpen?.()
          host.set({ [`${owner}.clickedItem`]: link.item })
          host.fire(owner, 'click')
        }}
      >
        <Icon icon={link.icon} />
        <span className="truncate">{link.label}</span>
      </button>
    )
  }
  if (link.kind === 'url') {
    return (
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass(false, vertical)}
        onClick={onOpen}
      >
        <Icon icon={link.icon} />
        <span className="truncate">{link.label}</span>
      </a>
    )
  }
  const here = link.page === current
  const open = (e: MouseEvent) => {
    // A new tab, a new window, a download: the browser's, from the link's address.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onOpen?.()
    host.openPage(link.page, link.params)
  }
  return (
    <a
      href={pageHref?.(link.page, link.params) ?? '#'}
      aria-current={here ? 'page' : undefined}
      className={linkClass(here, vertical)}
      onClick={open}
    >
      <Icon icon={link.icon} />
      <span className="truncate">{link.label}</span>
    </a>
  )
}

function NavGroup({
  owner,
  link,
  vertical,
  current,
}: {
  owner: string
  link: Extract<Link, { kind: 'group' }>
  vertical: boolean
  current: string | null
}) {
  const here = link.links.some((l) => l.kind === 'page' && l.page === current)
  const [open, setOpen] = useState(vertical && here)
  const ref = useRef<HTMLDivElement>(null)
  // A dropdown closes on a click elsewhere or Escape.
  useEffect(() => {
    if (vertical || !open) return
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', away)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', away)
    }
  }, [open, vertical])
  return (
    <div ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup={vertical ? undefined : 'true'}
        className={linkClass(here && !open, vertical)}
        onClick={() => setOpen(!open)}
      >
        <Icon icon={link.icon} />
        <span className="truncate">{link.label}</span>
        {vertical ? (
          <ChevronRight className={cn('ml-auto size-3.5 transition-transform', open && 'rotate-90')} />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
      </button>
      {open && (
        <ul
          aria-label={link.label}
          className={cn(
            'flex flex-col gap-0.5',
            vertical
              ? 'mt-0.5 ml-4'
              : 'absolute left-0 z-30 mt-1 min-w-44 rounded-md border border-border bg-surface p-1 shadow-menu',
          )}
        >
          {link.links.map((sub) =>
            sub.kind === 'group' ? null : (
              <li key={sub.key}>
                <NavLink
                  owner={owner}
                  link={sub}
                  vertical
                  current={current}
                  onOpen={() => !vertical && setOpen(false)}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}
