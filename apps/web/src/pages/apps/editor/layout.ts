import { type AppDefinition, setPositions, slotOf } from '@ow/app-definition'
import { type Layout, moveElement, verticalCompactor } from 'react-grid-layout'
import { placedChildren } from '../placed'

const COLS = 12

/**
 * `names` in `layout` moved by `dx` columns and `dy` rows, the way the canvas moves a dragged item (M24): each one
 * pushes what it lands on out of the way, then the grid is compacted upward as the canvas compacts it, so what's
 * saved is what the editor shows (and the app places).
 */
export function moveItems(layout: Layout, names: readonly string[], dx: number, dy: number): Layout {
  let next = layout.map((l) => ({ ...l }))
  // Those furthest along the move go first, so the others don't push into them.
  const moving = next
    .filter((l) => names.includes(l.i))
    .sort((a, b) => (dy || dx) * (dy ? b.y - a.y : b.x - a.x))
    .map((l) => l.i)
  for (const name of moving) {
    const item = next.find((l) => l.i === name)!
    const x = Math.max(0, Math.min(COLS - item.w, item.x + dx))
    const y = Math.max(0, item.y + dy)
    next = moveElement(next, item, x, y, true, false, 'vertical', COLS) as typeof next
  }
  return verticalCompactor.compact(next, COLS) as Layout
}

/** Every grid the named components sit on (their parent, slot and page): their children, as the canvas places them. */
function gridsOf(def: AppDefinition, names: readonly string[]) {
  const grids = new Map<string, { parent?: string; page?: string | null; slot?: string }>()
  for (const c of def.components) {
    if (!names.includes(c.name)) continue
    const page = c.parent === undefined && def.pages?.length ? (c.page ?? null) : undefined
    const grid = { parent: c.parent, page, slot: slotOf(def, c) }
    grids.set(JSON.stringify(grid), grid)
  }
  return [...grids.values()]
}

/** The named components moved together on their grids (the arrow keys), as `moveItems` moves them. */
export function nudgeOnCanvas(
  def: AppDefinition,
  names: readonly string[],
  dx: number,
  dy: number,
): AppDefinition {
  let next = def
  for (const grid of gridsOf(def, names)) {
    const layout = placedChildren(next, grid.parent, grid.page, grid.slot).map(({ component, position }) => ({
      i: component.name,
      ...position,
    }))
    const moved = moveItems(layout, names, dx, dy)
    next = setPositions(next, Object.fromEntries(moved.map((l) => [l.i, { x: l.x, y: l.y, w: l.w, h: l.h }])))
  }
  return next
}
