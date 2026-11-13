import { describe, expect, it } from 'vitest'
import { resizedLayout } from './resized'

const placed = (name: string, x: number, y: number, w: number, h: number) => ({
  component: { name, type: name.startsWith('custom') ? 'custom' : 'text' },
  position: { x, y, w, h },
})
const layout = (out: ReturnType<typeof resizedLayout>) =>
  out.map((c) => [c.component.name, c.position.y, c.position.h])

describe('resizedLayout (M33)', () => {
  const children = [
    placed('title', 0, 0, 12, 2),
    placed('custom1', 0, 2, 8, 10),
    placed('side', 8, 2, 4, 20),
    placed('under', 0, 12, 8, 2),
    placed('last', 0, 22, 12, 2),
  ]

  it('keeps everything where it is with nothing resized', () => {
    expect(resizedLayout(children, new Map())).toBe(children)
    expect(resizedLayout(children, new Map([['other', 3]]))).toBe(children)
  })

  it("moves what's under a grown component down, and nothing beside or above it", () => {
    expect(layout(resizedLayout(children, new Map([['custom1', 25]])))).toEqual([
      ['title', 0, 2],
      ['custom1', 2, 25],
      ['side', 2, 20],
      ['under', 27, 2],
      // Under both: below the lower of them now.
      ['last', 29, 2],
    ])
  })

  it("moves what's under a shrunk component up, never into one above it", () => {
    expect(layout(resizedLayout(children, new Map([['custom1', 3]])))).toEqual([
      ['title', 0, 2],
      ['custom1', 2, 3],
      ['side', 2, 20],
      ['under', 5, 2],
      // `side` still reaches row 22.
      ['last', 22, 2],
    ])
  })

  it('stacks two resized components in the same columns', () => {
    const stacked = [placed('custom1', 0, 0, 6, 4), placed('custom2', 0, 4, 6, 4), placed('end', 0, 8, 6, 1)]
    expect(
      layout(
        resizedLayout(
          stacked,
          new Map([
            ['custom1', 10],
            ['custom2', 1],
          ]),
        ),
      ),
    ).toEqual([
      ['custom1', 0, 10],
      ['custom2', 10, 1],
      ['end', 11, 1],
    ])
  })
})
