import { describe, expect, it } from 'vitest'
import { moveItems } from './layout'

const item = (i: string, x: number, y: number, w = 3, h = 2) => ({ i, x, y, w, h })
const at = (layout: readonly { i: string; x: number; y: number }[]) =>
  Object.fromEntries(layout.map((l) => [l.i, [l.x, l.y]]))

describe('moveItems (M24)', () => {
  it('moves several by one offset, kept on the grid', () => {
    const layout = [item('a', 0, 0), item('b', 3, 0), item('c', 9, 0)]
    expect(at(moveItems(layout, ['a', 'b'], 2, 0))).toEqual({ a: [2, 0], b: [5, 0], c: [9, 0] })
    expect(at(moveItems(layout, ['b', 'c'], 5, 0))).toEqual({ a: [0, 0], b: [8, 0], c: [9, 2] })
  })

  it('pushes what they land on out of the way, and compacts upward as the canvas does', () => {
    const layout = [item('a', 0, 0), item('b', 0, 2), item('c', 4, 0)]
    // Down a row with nothing in the way: it settles back up.
    expect(at(moveItems(layout, ['c'], 0, 1))).toEqual({ a: [0, 0], b: [0, 2], c: [4, 0] })
    // Onto another: that one moves aside, nothing overlaps.
    const moved = moveItems(layout, ['c'], -4, 0)
    const cells = new Set<string>()
    for (const l of moved)
      for (let x = l.x; x < l.x + l.w; x++) for (let y = l.y; y < l.y + l.h; y++) cells.add(`${x},${y}`)
    expect(cells.size).toBe(moved.reduce((n, l) => n + l.w * l.h, 0))
    expect(moved.find((l) => l.i === 'c')!.x).toBe(0)
  })
})
