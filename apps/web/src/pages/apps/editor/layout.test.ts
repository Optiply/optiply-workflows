import { describe, expect, it } from 'vitest'
import { moveItems } from './layout'

const item = (i: string, x: number, y: number, w = 3, h = 2) => ({ i, x, y, w, h })
const at = (layout: readonly { i: string; x: number; y: number }[]) =>
  Object.fromEntries(layout.map((l) => [l.i, [l.x, l.y]]))

describe('moveItems (M24)', () => {
  it('moves several by one offset, kept on the grid', () => {
    const layout = [item('a', 0, 0), item('b', 3, 0), item('c', 9, 0)]
    expect(at(moveItems(layout, ['a', 'b'], 2, 0))).toEqual({ a: [2, 0], b: [5, 0], c: [9, 0] })
    // Squeezed together at the grid's edge: the one leading the move keeps its place, the other goes below it.
    expect(at(moveItems(layout, ['b', 'c'], 5, 0))).toEqual({ a: [0, 0], b: [8, 2], c: [9, 0] })
  })

  it('pushes what they land on out of the way, and leaves components where they are put', () => {
    const layout = [item('a', 0, 0), item('b', 0, 2), item('c', 4, 0)]
    // Down rows with nothing in the way: it stays there (session 33: nothing floats up into a gap).
    expect(at(moveItems(layout, ['c'], 0, 5))).toEqual({ a: [0, 0], b: [0, 2], c: [4, 5] })
    // Onto another: that one moves aside, nothing overlaps.
    const moved = moveItems(layout, ['c'], -4, 0)
    const cells = new Set<string>()
    for (const l of moved)
      for (let x = l.x; x < l.x + l.w; x++) for (let y = l.y; y < l.y + l.h; y++) cells.add(`${x},${y}`)
    expect(cells.size).toBe(moved.reduce((n, l) => n + l.w * l.h, 0))
    expect(moved.find((l) => l.i === 'c')!.x).toBe(0)
    // And what was pushed pushes on: b, under a, goes down too, nothing floats up.
    expect(at(moved)).toEqual({ a: [0, 2], b: [0, 4], c: [0, 0] })
  })
})
