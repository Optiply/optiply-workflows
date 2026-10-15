import {
  type AppComponent,
  type AppDefinition,
  componentSpec,
  GRID_COLUMNS,
  type Position,
} from '@ow/app-definition'
import { type ComponentType, Fragment } from 'react'
import { cn } from '@/lib/utils'
import { useAppHostState, useAppValue } from './runtime/react'

/**
 * Renders an app's components on its 12-column grid: each parent (the page, a container, a form, a modal) is a CSS
 * grid of fixed-height rows. Components without a position are stacked below the rest at their default size.
 * Modals render over the page while open.
 */

/** Height of one grid row. */
export const ROW_HEIGHT = 16

export interface RendererProps {
  component: AppComponent
  definition: AppDefinition
}

/** Renderers by component type; types without one show their state (step 5 fills this in). */
export const RENDERERS: Partial<Record<string, ComponentType<RendererProps>>> = {}

/** Each child of `parent` with its position, in reading order. */
export function placedChildren(
  definition: AppDefinition,
  parent: string | undefined,
): { component: AppComponent; position: Position }[] {
  const children = definition.components.filter((c) => c.parent === parent && !componentSpec(c.type)?.overlay)
  const layout = definition.layout ?? {}
  let bottom = 0
  for (const c of children) {
    const p = layout[c.name]
    if (p) bottom = Math.max(bottom, p.y + p.h)
  }
  const placed = children.map((component) => {
    let position = layout[component.name]
    if (!position) {
      const size = componentSpec(component.type)?.defaultSize ?? { w: 4, h: 4 }
      position = { x: 0, y: bottom, w: Math.min(size.w, GRID_COLUMNS), h: size.h }
      bottom += size.h
    }
    return { component, position }
  })
  return placed.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

/** The grid of one parent's children. */
export function AppGrid({ definition, parent }: { definition: AppDefinition; parent?: string }) {
  const children = placedChildren(definition, parent)
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

/** One component: its renderer, or nothing while it's hidden. */
export function ComponentView({ component, definition }: RendererProps) {
  const hidden = useAppValue<boolean>(`${component.name}.hidden`)
  if (hidden) return null
  const Renderer = RENDERERS[component.type] ?? FallbackRenderer
  return (
    <div className="h-full" data-component={component.name}>
      <Renderer component={component} definition={definition} />
    </div>
  )
}

/** The page: the root grid, plus open modals. */
export function AppCanvas({ definition }: { definition: AppDefinition }) {
  const modals = definition.components.filter((c) => componentSpec(c.type)?.overlay)
  return (
    <>
      <AppGrid definition={definition} />
      {modals.map((m) => (
        <Fragment key={m.name}>
          <ComponentView component={m} definition={definition} />
        </Fragment>
      ))}
    </>
  )
}

/** Shows a component's name, type and current values; used for types without a renderer yet. */
function FallbackRenderer({ component }: RendererProps) {
  const values = useAppHostState((s) => s.values)
  const prefix = `${component.name}.`
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
