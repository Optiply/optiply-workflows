import { describe, expect, it } from 'vitest'
import { changeKey } from './history'

type Def = { blocks: { name: string; code?: string; x?: number }[]; title?: string }

describe('changeKey', () => {
  it('names the values an edit replaced in place', () => {
    const a: Def = { blocks: [{ name: 'q', code: 'a' }, { name: 'r' }] }
    const b: Def = { ...a, blocks: [{ ...a.blocks[0]!, code: 'ab' }, a.blocks[1]!] }
    expect(changeKey(a, b)).toBe('.blocks.0.code')
  })

  it('counts setting or clearing a plain value as in place', () => {
    const a: Def = { blocks: [] }
    expect(changeKey(a, { ...a, title: 'x' })).toBe('.title')
    expect(changeKey({ ...a, title: 'x' }, a)).toBe('.title')
  })

  it('is null when the shape changes, or nothing did', () => {
    const a: Def = { blocks: [{ name: 'q' }] }
    expect(changeKey(a, { blocks: [...a.blocks, { name: 'r' }] })).toBeNull()
    expect(changeKey(a, { blocks: [] })).toBeNull()
    expect(changeKey({ blocks: [{ name: 'q' }] }, { blocks: [{ name: 'q', code: undefined }] })).toBeNull()
    expect(changeKey(a, a)).toBeNull()
  })

  it('is null when too much changed at once', () => {
    const many = (v: number): Def => ({
      blocks: Array.from({ length: 20 }, (_, i) => ({ name: `b${i}`, x: v })),
    })
    expect(changeKey(many(1), many(2))).toBeNull()
  })
})
