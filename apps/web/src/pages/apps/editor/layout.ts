import { type AppDefinition, setPositions, slotOf } from '@ow/app-definition'
import type { Layout } from 'react-grid-layout'
import { placedChildren } from '../placed'

const COLS = 12

/**
 * `names` in `layout` moved by `dx` columns and `dy` rows, the way the canvas moves a dragged item (M24): each one
 * pushes what it lands on out of the way (down). Nothing floats up afterwards (session 33): components stay where
 * they're put, gaps included, as the canvas keeps them and the app places them.
 */
export function moveItems(layout: Layout, names: readonly string[], dx: number, dy: number): Layout {
  const next = layout.map((l) => ({ ...l }))
  // Those furthest along the move go first, so the others don't push into them.
  const moving = next
    .filter((l) => names.includes(l.i))
    .sort((a, b) => (dy || dx) * (dy ? b.y - a.y : b.x - a.x))
    .map((l) => l.i)
  for (const name of moving) {
    const item = next.find((l) => l.i === name)!
    const x = Math.max(0, Math.min(COLS - item.w, item.x + dx))
    const y = Math.max(0, item.y + dy)
    item.x = x
    item.y = y
  }
  return makeRoom(next, moving)
}

/**
 * The named items kept where they are; every other one that now overlaps something is pushed down just below it,
 * top to bottom, so pushes carry on through what's underneath. Nothing moves up (session 33: components stay where
 * they're put), and the others keep their order.
 */
export function makeRoom(layout: Layout, names: readonly string[]): Layout {
  const items = layout.map((l) => ({ ...l }))
  const overlaps = (a: (typeof items)[number], b: (typeof items)[number]) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  // The named ones first, in the order given (a move's leading item keeps its place if the grid's edge squeezes them
  // together), then the rest from the top.
  const named = names.flatMap((n) => items.filter((l) => l.i === n))
  const rest = items.filter((l) => !names.includes(l.i)).sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: typeof items = []
  for (const item of [...named, ...rest]) {
    for (let hit = placed.find((p) => overlaps(p, item)); hit; hit = placed.find((p) => overlaps(p, item))) {
      item.y = hit.y + hit.h
    }
    placed.push(item)
  }
  return items as Layout
}

/** Every grid the named components sit on (their parent, slot and page): their children, as the canvas places them. */
type Grid = { parent?: string; page?: string | null; slot?: string }

function gridsOf(def: AppDefinition, names: readonly string[]): Grid[] {
  const grids = new Map<string, Grid>()
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

/**
 * After components moved to another grid (M24): where they landed on others, those are pushed down out of the way,
 * so no overlap is saved. Gaps stay (session 33: components stay where they're put).
 */
export function settleAfterMove(
  before: AppDefinition,
  after: AppDefinition,
  names: readonly string[],
): AppDefinition {
  const grids = new Map<string, Grid>()
  for (const g of [...gridsOf(before, names), ...gridsOf(after, names)]) grids.set(JSON.stringify(g), g)
  let next = after
  for (const grid of grids.values()) {
    const layout = placedChildren(next, grid.parent, grid.page, grid.slot).map(({ component, position }) => ({
      i: component.name,
      ...position,
    }))
    const settled = makeRoom(layout, names)
    next = setPositions(
      next,
      Object.fromEntries(settled.map((l) => [l.i, { x: l.x, y: l.y, w: l.w, h: l.h }])),
    )
  }
  return next
}
