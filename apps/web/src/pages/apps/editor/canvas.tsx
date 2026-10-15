import { type AppDefinition, addComponent, COMPONENTS, componentSpec, setPositions } from '@ow/app-definition'
import { GripVertical } from 'lucide-react'
import { useMemo } from 'react'
import ReactGridLayout, { type Layout, useContainerWidth } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
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
]

/** A class per grid for its drag handles, so a container's handle never drags the grid outside it. */
const handleClass = (parent: string | undefined) => `ow-drag-${parent ?? 'page'}`

/** One parent's children on a draggable, resizable grid. The page's grid also takes drops from the palette. */
export function EditGrid({ definition, parent }: { definition: AppDefinition; parent?: string }) {
  const { width, containerRef, mounted } = useContainerWidth()
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const selected = useAppEditor((s) => s.selected)
  const children = useMemo(() => placedChildren(definition, parent), [definition, parent])
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
  const handle = handleClass(parent)

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative',
        parent === undefined ? 'min-h-[70vh]' : 'min-h-16 rounded-md border border-dashed border-border/70',
      )}
      data-testid={`grid-${parent ?? 'page'}`}
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
                  'absolute -top-5 left-0 z-10 flex h-5 cursor-move items-center gap-1 rounded-t bg-accent px-1.5 font-mono text-[11px] text-white',
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

/** The editor's canvas: the page grid with every component live, and the selected modal over it. */
export function EditCanvas() {
  const definition = useAppEditor((s) => s.definition)
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
            <EditGrid definition={definition} />
          </div>
          {modal && <ComponentView component={modal} definition={definition} />}
        </ShownModalContext.Provider>
      </EditingContext.Provider>
    </ChildGridContext.Provider>
  )
}

/** Component types to drag onto the page, or click to add (into the selected container, or at the bottom). */
export function Palette() {
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const add = (type: string) => {
    const { definition, selected } = useAppEditor.getState()
    const target = definition.components.find((c) => c.name === selected)
    const parent = target && componentSpec(target.type)?.container ? target.name : target?.parent
    const added = addComponent(definition, type, parent ? { parent } : {})
    update(() => added.definition)
    select(added.name)
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {PALETTE.map((type) => (
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

/** The components as a tree, by parent; modals at the end. */
export function ComponentTree() {
  const definition = useAppEditor((s) => s.definition)
  const selected = useAppEditor((s) => s.selected)
  const select = useAppEditor((s) => s.select)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  // Selected as-is and derived here: a selector building a new Set would re-render forever.
  const problems = useMemo(
    () => new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.entity)),
    [diagnostics],
  )
  const rows: { name: string; type: string; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const { component } of placedChildren(definition, parent)) {
      rows.push({ name: component.name, type: component.type, depth })
      if (componentSpec(component.type)?.container) walk(component.name, depth + 1)
    }
  }
  walk(undefined, 0)
  for (const m of definition.components.filter((c) => componentSpec(c.type)?.overlay)) {
    rows.push({ name: m.name, type: m.type, depth: 0 })
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
            {problems.has(r.name) && <span className="size-1.5 rounded-full bg-danger" />}
            <span className="text-[10px] text-muted">{COMPONENTS[r.type]?.label ?? r.type}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
