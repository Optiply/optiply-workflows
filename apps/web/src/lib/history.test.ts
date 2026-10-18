import { describe, expect, it } from 'vitest'
import {
  changeKey,
  emptyHistory,
  HISTORY_LIMIT,
  MERGE_MS,
  record,
  redo,
  sameValue,
  seal,
  undo,
} from './history'

type Def = { blocks: { name: string; code?: string; x?: number }[]; title?: string }

const view = 'v'
const step = (history: ReturnType<typeof emptyHistory<Def, string>>, before: Def, after: Def, at: number) =>
  record(history, { before, after, view, at })

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

describe('sameValue', () => {
  it('compares as JSON would, by reference first', () => {
    const shared = { name: 'q', code: 'x' }
    expect(sameValue({ blocks: [shared] }, { blocks: [{ ...shared }] })).toBe(true)
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameValue({ blocks: [shared] }, { blocks: [{ ...shared, code: 'y' }] })).toBe(false)
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false)
    expect(sameValue({ a: [] }, { a: {} })).toBe(false)
  })
})

describe('history', () => {
  const d0: Def = { blocks: [{ name: 'q', code: '' }] }
  const typed = (code: string): Def => ({ blocks: [{ name: 'q', code }] })

  it('undoes and redoes edits in order', () => {
    const d1: Def = { blocks: [...d0.blocks, { name: 'r' }] }
    const d2: Def = { blocks: [...d1.blocks, { name: 's' }] }
    let h = step(emptyHistory(), d0, d1, 0)
    h = step(h, d1, d2, 5000)
    const u1 = undo(h)!
    expect(u1.entry.before).toBe(d1)
    const u2 = undo(u1.history)!
    expect(u2.entry.before).toBe(d0)
    expect(undo(u2.history)).toBeNull()
    const r1 = redo(u2.history)!
    expect(r1.entry.after).toBe(d1)
    expect(redo(r1.history)!.entry.after).toBe(d2)
  })

  it('keeps what was showing when an entry was undone, for redoing it', () => {
    const d1: Def = { blocks: [...d0.blocks, { name: 'r' }] }
    const h = step(emptyHistory(), d0, d1, 0)
    expect(undo(h)!.history.future[0]!.redoView).toBeUndefined()
    const back = undo(h, 'after')!.history
    expect(redo(back)!.entry).toMatchObject({ after: d1, redoView: 'after' })
  })

  it('merges typing in one field into one step while the keys come quickly', () => {
    let h = step(emptyHistory(), d0, typed('a'), 0)
    h = step(h, typed('a'), typed('ab'), 300)
    h = step(h, typed('ab'), typed('abc'), 600)
    expect(h.past).toHaveLength(1)
    expect(h.past[0]).toMatchObject({ before: d0, after: typed('abc') })
    // A pause starts a new step.
    h = step(h, typed('abc'), typed('abcd'), 600 + MERGE_MS)
    expect(h.past).toHaveLength(2)
  })

  it("doesn't merge edits of other values, edits that change the shape, or after a seal or an undo", () => {
    const other: Def = { blocks: [{ name: 'q', code: 'a' }], title: 't' }
    let h = step(emptyHistory(), d0, typed('a'), 0)
    h = step(h, typed('a'), other, 100)
    expect(h.past).toHaveLength(2)

    const added: Def = { blocks: [...d0.blocks, { name: 'r' }] }
    const twice: Def = { blocks: [...added.blocks, { name: 's' }] }
    h = step(emptyHistory(), d0, added, 0)
    h = step(h, added, twice, 100)
    expect(h.past).toHaveLength(2)

    h = seal(step(emptyHistory(), d0, typed('a'), 0))
    h = step(h, typed('a'), typed('ab'), 100)
    expect(h.past).toHaveLength(2)

    h = step(step(emptyHistory(), d0, typed('a'), 0), typed('a'), typed('ab'), 100)
    const back = undo(h)!.history
    h = step(back, d0, typed('x'), 200)
    expect(h.past).toHaveLength(1)
  })

  it('drops what could be redone on a new edit', () => {
    const h = step(emptyHistory(), d0, typed('a'), 0)
    const back = undo(h)!.history
    expect(back.future).toHaveLength(1)
    expect(step(back, d0, typed('b'), 5000).future).toEqual([])
  })

  it(`keeps the last ${HISTORY_LIMIT} edits`, () => {
    let h = emptyHistory<Def, string>()
    let def = d0
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      const next: Def = { blocks: [...def.blocks, { name: `b${i}` }] }
      h = step(h, def, next, i * 10)
      def = next
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]!.before.blocks).toHaveLength(21)
  })
})
