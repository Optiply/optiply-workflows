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
  return children.map(({ component, position }) => {
    const keep = rows.get(component.name)
    const up = gaps.filter((g) => position.y >= g.below).reduce((sum, g) => sum + g.by, 0)
    const h = keep !== undefined && keep < position.h ? keep : position.h
    return { component, position: up || h !== position.h ? { ...position, y: position.y - up, h } : position }
  })
}
