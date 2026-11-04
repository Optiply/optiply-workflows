import {
  type AppComponent,
  type AppDefinition,
  componentSpec,
  defaultSpecFor,
  GRID_COLUMNS,
  type Position,
  slotOf,
} from '@ow/app-definition'

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
