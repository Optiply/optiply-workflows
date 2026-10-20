import {
  type AppComponent,
  type AppDefinition,
  addComponent,
  COMPONENTS,
  componentSpec,
  defaultSpecFor,
  entityPages,
  setPositions,
} from '@ow/app-definition'
import { GripVertical } from 'lucide-react'
import { useMemo } from 'react'
import ReactGridLayout, { type Layout, useContainerWidth } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { sectionLabelClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ComponentView, placedChildren, ROW_HEIGHT } from '../canvas'
import { ChildGridContext, EditingContext, ShownModalContext } from '../grid-context'
import { useAppEditor } from './store'

/** What the palette is dragging (DataTransfer can't be read until the drop). */
let dragging: string | null = null

/** The component types in the palette, in this order. */
const PALETTE = [
  'table',
  'form',
  'textInput',
  'numberInput',
  'dateInput',
  'select',
  'checkbox',
  'button',
  'text',
  'container',
  'modal',
  'chart',
  'navigation',
]

/** Which top-level grid: the page's, or the frame's (global components, in an app with pages). */
const gridId = (parent: string | undefined, page: string | null | undefined) =>
  parent ?? (page === null ? 'frame' : 'page')

/** A class per grid for its drag handles, so a container's handle never drags the grid outside it. */
const handleClass = (parent: string | undefined, page?: string | null) => `ow-drag-${gridId(parent, page)}`

/**
 * One parent's children on a draggable, resizable grid. A top-level grid also takes drops from the palette: in an
 * app with pages, the page being edited (`page`) or the global frame (`page` null) has one each.
 */
export function EditGrid({
  definition,
  parent,
  page,
}: {
  definition: AppDefinition
  parent?: string
  page?: string | null
}) {
  const { width, containerRef, mounted } = useContainerWidth()
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const selected = useAppEditor((s) => s.selected)
  const children = useMemo(() => placedChildren(definition, parent, page), [definition, parent, page])
  const layout = useMemo(
    () => children.map(({ component, position }) => ({ i: component.name, ...position })),
    [children],
  )
  const commit = (next: Layout) =>
    update((def) =>
      setPositions(
        def,
        Object.fromEntries(
          next
            .filter((l) => l.i !== '__dropping-elem__')
            .map((l) => [l.i, { x: l.x, y: l.y, w: l.w, h: l.h }]),
        ),
      ),
    )
  const handle = handleClass(parent, page)

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative',
        parent === undefined ? 'min-h-[70vh]' : 'min-h-16 rounded-md border border-dashed border-border/70',
      )}
      data-testid={`grid-${gridId(parent, page)}`}
    >
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: 12, rowHeight: ROW_HEIGHT, margin: [12, 0], containerPadding: [0, 0] }}
          dragConfig={{ handle: `.${handle}` }}
          resizeConfig={{ handles: ['se', 'e', 's'] }}
          dropConfig={
            parent === undefined ? { enabled: true, defaultItem: { w: 4, h: 4 } } : { enabled: false }
          }
          onDragStop={commit}
          onResizeStop={commit}
          onDropDragOver={() => {
            const spec = dragging ? componentSpec(dragging) : undefined
            if (!spec || spec.overlay) return false
            return { w: spec.defaultSize.w, h: spec.defaultSize.h }
          }}
          onDrop={(_layout, item) => {
            const type = dragging
            dragging = null
            if (!type || !item) return
            const added = addComponent(useAppEditor.getState().definition, type, {
              position: { x: item.x, y: item.y },
              ...(page !== undefined && { page }),
            })
            update(() => added.definition)
            select(added.name)
          }}
        >
          {children.map(({ component }) => (
            <div
              key={component.name}
              data-testid={`frame-${component.name}`}
              className={cn(
                'group rounded-md',
                selected === component.name
                  ? 'outline-2 outline-accent'
                  : 'hover:outline hover:outline-accent/40',
              )}
              onMouseDownCapture={() => select(component.name)}
            >
              <div
                className={cn(
                  handle,
                  'absolute -top-5 left-0 z-10 flex h-5 cursor-move items-center gap-1 rounded-t bg-accent px-1.5 font-mono text-[11px] text-on-accent',
                  selected === component.name ? 'flex' : 'hidden group-hover:flex',
                )}
                title="Drag to move"
              >
                <GripVertical className="size-3" />
                {component.name}
              </div>
              <ComponentView component={component} definition={definition} />
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  )
}

/**
 * The editor's canvas: the page grid with every component live, and the selected modal over it. In an app with
 * pages, the global components (on every page) have a grid of their own above the page's.
 */
export function EditCanvas() {
  const definition = useAppEditor((s) => s.definition)
  const page = useAppEditor((s) => s.url.page)
  const hasPages = !!definition.pages?.length
  const selected = useAppEditor((s) => s.selected)
  const select = useAppEditor((s) => s.select)
  // The modal holding the selection, if any: it opens over the canvas.
  const shownModal = useMemo(() => {
    const parents = new Map(definition.components.map((c) => [c.name, c]))
    for (
      let at = selected ? parents.get(selected) : undefined;
      at;
      at = at.parent ? parents.get(at.parent) : undefined
    ) {
      if (componentSpec(at.type)?.overlay) return at.name
    }
    return null
  }, [definition, selected])
  const modal = definition.components.find((c) => c.name === shownModal)

  return (
    <ChildGridContext.Provider value={EditGrid}>
      <EditingContext.Provider value={true}>
        <ShownModalContext.Provider value={{ name: shownModal, close: () => select(null) }}>
          {/* Clicking the empty canvas clears the selection. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer convenience; components are selected from the tree too */}
          <div
            className="pt-5"
            onMouseDown={(e) => {
              if (
                e.target === e.currentTarget ||
                (e.target as HTMLElement).classList.contains('react-grid-layout')
              )
                select(null)
            }}
          >
            {hasPages ? (
              <>
                <GridCaption>On every page</GridCaption>
                <EditGrid definition={definition} page={null} />
                <GridCaption className="mt-6">
                  Page {definition.pages!.find((p) => p.name === page)?.title || page}
                </GridCaption>
                <EditGrid definition={definition} page={page} />
              </>
            ) : (
              <EditGrid definition={definition} />
            )}
          </div>
          {modal && <ComponentView component={modal} definition={definition} />}
        </ShownModalContext.Provider>
      </EditingContext.Provider>
    </ChildGridContext.Provider>
  )
}

function GridCaption({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mb-6', sectionLabelClass, className)}>{children}</div>
}

/**
 * Where a component added from the palette goes: into the selected container, or at the bottom of the page being
 * edited (of the frame, with a global component selected).
 */
export function placement(): { parent: string } | { page: string | null } {
  const { definition, selected, url } = useAppEditor.getState()
  const target = definition.components.find((c) => c.name === selected)
  const parent = target && componentSpec(target.type)?.container ? target.name : target?.parent
  if (parent) return { parent }
  return {
    page: definition.pages?.length ? (target ? (target.page ?? null) : url.page) : null,
  }
}

/** Component types to drag onto the page, or click to add (see `placement`). */
export function Palette() {
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  // A module has no pages to link (M14).
  const isModule = useAppEditor((s) => s.kind === 'module')
  const types = isModule ? PALETTE.filter((type) => type !== 'navigation') : PALETTE
  const add = (type: string) => {
    const { definition } = useAppEditor.getState()
    const added = addComponent(definition, type, placement())
    update(() => added.definition)
    select(added.name)
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {types.map((type) => (
        <button
          key={type}
          type="button"
          draggable={!COMPONENTS[type]!.overlay}
          onDragStart={(e) => {
            dragging = type
            // Firefox only starts a drag that carries data.
            e.dataTransfer.setData('text/plain', type)
          }}
          onDragEnd={() => {
            dragging = null
          }}
          onClick={() => add(type)}
          title={`Add a ${COMPONENTS[type]!.label.toLowerCase()}`}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-left text-xs hover:border-accent hover:text-accent"
        >
          {COMPONENTS[type]!.label}
        </button>
      ))}
    </div>
  )
}

/** The components as a tree, by parent; modals at the end. In an app with pages: the global ones and the page's. */
export function ComponentTree() {
  const definition = useAppEditor((s) => s.definition)
  const page = useAppEditor((s) => s.url.page)
  const pages = useMemo(() => entityPages(definition), [definition])
  const hasPages = !!definition.pages?.length
  const shown = (name: string) => !hasPages || [null, page].includes(pages.get(name) ?? null)
  const selected = useAppEditor((s) => s.selected)
  const select = useAppEditor((s) => s.select)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  // Selected as-is and derived here: a selector building a new Set would re-render forever.
  const problems = useMemo(
    () => new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.entity)),
    [diagnostics],
  )
  const rows: { name: string; label: string; depth: number; everyPage: boolean }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const { component } of placedChildren(definition, parent)) {
      if (!shown(component.name)) continue
      const everyPage = hasPages && parent === undefined && component.page === undefined
      rows.push({ name: component.name, label: labelOf(component), depth, everyPage })
      if (componentSpec(component.type)?.container) walk(component.name, depth + 1)
    }
  }
  walk(undefined, 0)
  for (const m of definition.components.filter((c) => componentSpec(c.type)?.overlay && shown(c.name))) {
    rows.push({ name: m.name, label: labelOf(m), depth: 0, everyPage: hasPages && m.page === undefined })
    walk(m.name, 1)
  }
  if (!rows.length) return <p className="px-1 text-xs text-muted">No components yet.</p>
  return (
    <ul className="flex flex-col">
      {rows.map((r) => (
        <li key={r.name}>
          <button
            type="button"
            onClick={() => select(r.name)}
            style={{ paddingLeft: 8 + r.depth * 12 }}
            className={cn(
              'flex w-full items-center gap-2 rounded py-1 pr-2 text-left font-mono text-xs',
              selected === r.name ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-canvas hover:text-ink',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {r.everyPage && (
              <span className="text-[10px] text-muted" title="On every page">
                all
              </span>
            )}
            {problems.has(r.name) && <span className="size-1.5 rounded-full bg-danger" />}
            <span className="max-w-[45%] truncate text-[10px] text-muted" title={r.label}>
              {r.label}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A component's type as people read it; a module instance's module (M14). */
function labelOf(component: AppComponent): string {
  if (component.type === 'module' && typeof component.props?.module === 'string')
    return component.props.module
  return defaultSpecFor(component)?.label ?? component.type
}
