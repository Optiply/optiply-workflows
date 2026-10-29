import type { AppComponent, Position } from '@ow/app-definition'

/** Rows a folded container keeps: its header, by its padding. */
const FOLDED_ROWS: Record<string, number> = { none: 2, small: 3, medium: 4, large: 5 }

/**
 * Positions with folded containers (`name:padding`, comma-separated) at their header's height, and what's below each
 * moved up by what it gave back, so nothing leaves a gap (M24).
 */
export function foldedLayout(
  children: { component: AppComponent; position: Position }[],
  folded: string,
): { component: AppComponent; position: Position }[] {
  if (!folded) return children
  const rows = new Map(
    folded.split(',').map((entry) => {
      const [name, padding] = entry.split(':')
      return [name!, FOLDED_ROWS[padding ?? 'medium'] ?? FOLDED_ROWS.medium!] as const
    }),
  )
  const gaps = children.flatMap(({ component, position }) => {
    const keep = rows.get(component.name)
    return keep === undefined || keep >= position.h
      ? []
      : [{ below: position.y + position.h, by: position.h - keep }]
  })
  // Top to bottom, so each one knows where what's above it ended up: nothing moves up into a component above it in
  // the same columns (one beside the folded container that reaches further down keeps what's under it in place).
  const moved = new Map<string, Position>()
  const byRow = [...children].sort((a, b) => a.position.y - b.position.y)
  for (const { component, position } of byRow) {
    const keep = rows.get(component.name)
    const up = gaps.filter((g) => position.y >= g.below).reduce((sum, g) => sum + g.by, 0)
    const h = keep !== undefined && keep < position.h ? keep : position.h
    let y = position.y - up
    for (const other of byRow) {
      const was = other.position
      const now = moved.get(other.component.name)
      if (!now || was.y + was.h > position.y) continue
      if (was.x < position.x + position.w && position.x < was.x + was.w) y = Math.max(y, now.y + now.h)
    }
    y = Math.min(y, position.y)
    moved.set(component.name, y !== position.y || h !== position.h ? { ...position, y, h } : position)
  }
  return children.map(({ component }) => ({ component, position: moved.get(component.name)! }))
}
