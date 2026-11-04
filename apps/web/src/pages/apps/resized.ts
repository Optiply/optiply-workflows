import type { AppComponent } from '@ow/app-definition'

type Position = { x: number; y: number; w: number; h: number }

/**
 * The grid with some components at other heights (M33: custom components on Auto height, `rows` by name). What's
 * under one follows it: each component moves by as much as the nearest component above it in its columns grew or
 * shrank, and never into one above it. Components above, or beside in other columns, stay where they are.
 */
export function resizedLayout(
  children: { component: AppComponent; position: Position }[],
  rows: ReadonlyMap<string, number>,
): { component: AppComponent; position: Position }[] {
  if (!rows.size || !children.some(({ component }) => rows.has(component.name))) return children
  const overlaps = (a: Position, b: Position) => a.x < b.x + b.w && b.x < a.x + a.w
  const moved = new Map<string, Position>()
  const byRow = [...children].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  for (const { component, position } of byRow) {
    const h = rows.get(component.name) ?? position.h
    // The components above it in its columns, as they were and as they are now.
    const above = byRow.filter(
      (o) =>
        moved.has(o.component.name) &&
        o.position.y + o.position.h <= position.y &&
        overlaps(o.position, position),
    )
    let y = position.y
    if (above.length) {
      const nearest = Math.max(...above.map((o) => o.position.y + o.position.h))
      const shift = Math.max(
        ...above
          .filter((o) => o.position.y + o.position.h === nearest)
          .map((o) => {
            const now = moved.get(o.component.name)!
            return now.y + now.h - (o.position.y + o.position.h)
          }),
      )
      y = position.y + shift
      for (const o of above) {
        const now = moved.get(o.component.name)!
        y = Math.max(y, now.y + now.h)
      }
    }
    moved.set(component.name, y !== position.y || h !== position.h ? { ...position, y, h } : position)
  }
  return children.map(({ component }) => ({ component, position: moved.get(component.name)! }))
}
