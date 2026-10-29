import {
  type AppComponent,
  type AppDefinition,
  componentSpec,
  defaultSpecFor,
  entityPages,
  GRID_COLUMNS,
  type Position,
  slotOf,
} from '@ow/app-definition'
import { Menu as MenuIcon } from 'lucide-react'
import { Fragment, type ReactNode, useContext, useMemo, useState } from 'react'
import { Avatar } from '@/components/ui'
import { cn } from '@/lib/utils'
import { RENDERERS } from './components'
import { foldedLayout } from './folded'
import { AppChromeContext, ChildGridContext, EditingContext } from './grid-context'
import type { RendererProps } from './renderer'
import { useAppHostState, useAppScope, useAppValue } from './runtime/react'

/**
 * Renders an app's components on its 12-column grid: each parent (the page, a container, a form, a modal) is a CSS
 * grid of fixed-height rows. Components without a position are stacked below the rest at their default size.
 * Modals render over the page while open. In an app with pages, the global components (the frame) come first, on
 * a grid of their own, then the page shown.
 */

/** Height of one grid row. */
export const ROW_HEIGHT = 16

/**
 * Each child of `parent` with its position, in reading order. At the top (no parent), `page` keeps those on that
 * page only (null: the global ones); every top-level component when it's left out.
 */
export function placedChildren(
  definition: AppDefinition,
  parent: string | undefined,
  page?: string | null,
  slot?: string,
): { component: AppComponent; position: Position }[] {
  const children = definition.components.filter(
    (c) =>
      c.parent === parent &&
      !componentSpec(c.type)?.overlay &&
      (parent !== undefined || page === undefined || (c.page ?? null) === page) &&
      // Each slot is a grid of its own (M24): a container's views, header and footer; the frame's sidebar.
      slotOf(definition, c) === slot,
  )
  const layout = definition.layout ?? {}
  let bottom = 0
  for (const c of children) {
    const p = layout[c.name]
    if (p) bottom = Math.max(bottom, p.y + p.h)
  }
  const placed = children.map((component) => {
    let position = layout[component.name]
    if (!position) {
      const size = defaultSpecFor(component)?.defaultSize ?? { w: 4, h: 4 }
      position = { x: 0, y: bottom, w: Math.min(size.w, GRID_COLUMNS), h: size.h }
      bottom += size.h
    }
    return { component, position }
  })
  return placed.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

/** The grid of one parent's children (at the top, of one page's, or of the global ones with `page` null). */
export function AppGrid({
  definition,
  parent,
  page,
  slot,
}: {
  definition: AppDefinition
  parent?: string
  page?: string | null
  slot?: string
}) {
  const scope = useAppScope()
  // Folded containers (M24), by name: a string, so the grid re-renders only when one folds or unfolds.
  const foldedKey = useAppHostState((s) =>
    placedChildren(definition, parent, page, slot)
      .filter(
        ({ component: c }) =>
          c.type === 'container' &&
          s.values[`${scope}${c.name}.collapsible`] === true &&
          s.values[`${scope}${c.name}.expanded`] === false,
      )
      .map(({ component: c }) => `${c.name}:${String(s.values[`${scope}${c.name}.padding`] ?? 'medium')}`)
      .join(','),
  )
  const children = foldedLayout(placedChildren(definition, parent, page, slot), foldedKey)
  return (
    <div
      className="grid gap-x-3"
      style={{
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gridAutoRows: `${ROW_HEIGHT}px`,
      }}
    >
      {children.map(({ component, position }) => (
        <div
          key={component.name}
          className="min-w-0"
          style={{
            gridColumn: `${position.x + 1} / span ${position.w}`,
            gridRow: `${position.y + 1} / span ${position.h}`,
          }}
        >
          <ComponentView component={component} definition={definition} />
        </div>
      ))}
    </div>
  )
}

/** One component: its renderer, or nothing while it's hidden (faded in the editor). */
export function ComponentView({ component, definition }: RendererProps) {
  const hidden = useAppValue<boolean>(`${component.name}.hidden`)
  const editing = useContext(EditingContext)
  if (hidden && !editing) return null
  const Renderer = RENDERERS[component.type] ?? FallbackRenderer
  return (
    <div className={cn('h-full', hidden && 'opacity-40')} data-component={component.name}>
      <Renderer component={component} definition={definition} />
    </div>
  )
}

const SIDEBAR_WIDTHS = { narrow: 'w-48', medium: 'w-64', wide: 'w-80' } as const

/**
 * The page shown: the global components, then the page's, plus open modals of either. With a frame (M24), the global
 * components sit in a header bar fixed at the top (with the app's name and the signed-in person, when asked) and/or
 * a sidebar at the left (behind a Menu button on narrow screens); the page scrolls beneath and beside them.
 */
export function AppCanvas({ definition, page = null }: { definition: AppDefinition; page?: string | null }) {
  const pages = useMemo(() => entityPages(definition), [definition])
  const modals = definition.components.filter(
    (c) => componentSpec(c.type)?.overlay && [null, page].includes(pages.get(c.name) ?? null),
  )
  const hasPages = !!definition.pages?.length
  const pageGrid = hasPages && page !== null && (
    <div data-page={page} className="mt-3">
      <AppGrid definition={definition} page={page} />
    </div>
  )
  return (
    <ChildGridContext.Provider value={AppGrid}>
      {definition.frame ? (
        <AppFrame definition={definition}>{pageGrid}</AppFrame>
      ) : (
        <>
          <AppGrid definition={definition} page={null} />
          {pageGrid}
        </>
      )}
      {modals.map((m) => (
        <Fragment key={m.name}>
          <ComponentView component={m} definition={definition} />
        </Fragment>
      ))}
    </ChildGridContext.Provider>
  )
}

/** The frame around the page (M24): header bar, sidebar, or both. */
function AppFrame({ definition, children }: { definition: AppDefinition; children: ReactNode }) {
  const frame = definition.frame!
  const { appName, user } = useContext(AppChromeContext)
  const [menuOpen, setMenuOpen] = useState(false)
  const title = frame.showTitle && appName && <span className="truncate text-lg font-bold">{appName}</span>
  const sidebar = frame.sidebar && <AppGrid definition={definition} page={null} slot="sidebar" />
  const menu = frame.sidebar && (
    <button
      type="button"
      aria-label="Menu"
      aria-expanded={menuOpen}
      className="rounded p-1 text-muted hover:bg-canvas hover:text-ink md:hidden"
      onClick={() => setMenuOpen(!menuOpen)}
    >
      <MenuIcon className="size-5" />
    </button>
  )
  return (
    <div className="flex min-h-full gap-4">
      {frame.sidebar && (
        <aside
          aria-label="Sidebar"
          data-frame="sidebar"
          className={cn(
            'shrink-0 self-start border-border bg-surface',
            SIDEBAR_WIDTHS[frame.sidebar],
            // Narrow screens: behind the Menu button, over the page.
            menuOpen
              ? 'fixed inset-y-0 left-0 z-40 overflow-y-auto border-r p-3 shadow-menu'
              : 'sticky top-0 hidden max-h-screen overflow-y-auto rounded-lg border p-3 md:block',
          )}
        >
          {!frame.header && title && <div className="mb-3">{title}</div>}
          {sidebar}
        </aside>
      )}
      <div className="min-w-0 flex-1">
        {frame.header ? (
          <header
            data-frame="header"
            className="sticky top-0 z-20 mb-3 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
          >
            {menu}
            {title}
            <div className="min-w-0 flex-1">
              <AppGrid definition={definition} page={null} />
            </div>
            {frame.showUser && user && (
              <span className="flex shrink-0 items-center gap-2 text-sm" data-frame="user">
                <Avatar name={user.name || user.email} />
                <span className="hidden sm:inline">{user.name || user.email}</span>
              </span>
            )}
          </header>
        ) : (
          <>
            {menu}
            <AppGrid definition={definition} page={null} />
          </>
        )}
        {children}
      </div>
    </div>
  )
}

/** Shows a component's name, type and current values; used for types without a renderer yet. */
function FallbackRenderer({ component }: RendererProps) {
  const values = useAppHostState((s) => s.values)
  const prefix = `${useAppScope()}${component.name}.`
  const own = Object.fromEntries(
    Object.entries(values)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v]),
  )
  return (
    <div
      className={cn(
        'h-full overflow-auto rounded-md border border-dashed border-border bg-surface p-2 text-xs',
      )}
    >
      <div className="mb-1 font-medium">
        {component.name} <span className="text-muted">· {component.type}</span>
      </div>
      <pre className="font-mono whitespace-pre-wrap text-muted">{JSON.stringify(own, null, 2)}</pre>
    </div>
  )
}
