import { describe, expect, it } from 'vitest'
import { foldedLayout } from './folded'

const placed = (name: string, x: number, y: number, w: number, h: number) => ({
  component: { name, type: name.startsWith('box') ? 'container' : 'text' },
  position: { x, y, w, h },
})

describe('foldedLayout (M24)', () => {
  const children = [
    placed('box1', 0, 0, 6, 20),
    placed('side', 6, 0, 6, 4),
    placed('below', 0, 20, 12, 2),
    placed('box2', 0, 22, 12, 10),
    placed('last', 0, 32, 4, 2),
  ]

  it('keeps everything where it is when nothing is folded', () => {
    expect(foldedLayout(children, '')).toBe(children)
  })

  it('folds containers to their header and moves what’s below each up', () => {
    const out = foldedLayout(children, 'box1:medium,box2:none')
    expect(out.map((c) => [c.component.name, c.position.y, c.position.h])).toEqual([
      ['box1', 0, 4],
      ['side', 0, 4],
      ['below', 4, 2],
      ['box2', 6, 2],
      ['last', 8, 2],
    ])
  })

  it('never moves a component up into one above it beside the folded container', () => {
    // A folds by 6; B beside it reaches row 10, so C under B stays; D under A moves up.
    const out = foldedLayout(
      [
        placed('boxA', 0, 0, 6, 10),
        placed('B', 6, 0, 6, 10),
        placed('C', 6, 10, 6, 2),
        placed('D', 0, 10, 6, 2),
      ],
      'boxA:medium',
    )
    expect(out.map((c) => [c.component.name, c.position.y])).toEqual([
      ['boxA', 0],
      ['B', 0],
      ['C', 10],
      ['D', 4],
    ])
  })

  it('leaves a container already shorter than its header alone', () => {
    const out = foldedLayout([placed('box1', 0, 0, 6, 3), placed('below', 0, 3, 6, 2)], 'box1:large')
    expect(out.map((c) => c.position.y)).toEqual([0, 3])
  })
})
