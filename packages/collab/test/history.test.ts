import { type Block, type WorkflowDefinition, workflowDefinitionSchema } from '@ow/definition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { HISTORY_LIMIT, SharedDefinition, SharedHistory, workflowSpec } from '../src'

const code = (name: string, src: string): Block => ({ name, type: 'code', config: { code: src } })

const workflow = (...blocks: Block[]): WorkflowDefinition =>
  workflowDefinitionSchema.parse({
    schemaVersion: 1,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
    edges: [],
  })

/** Sets one block's code, keeping the rest. */
const withCode = (def: WorkflowDefinition, name: string, src: string): WorkflowDefinition => ({
  ...def,
  blocks: def.blocks.map((b) => (b.name === name ? code(name, src) : b)),
})

const codeOf = (def: WorkflowDefinition, name: string) =>
  (def.blocks.find((b) => b.name === name) as Extract<Block, { type: 'code' }> | undefined)?.config.code

interface View {
  selected: string
}

function editor(from?: SharedDefinition<WorkflowDefinition>) {
  const doc = new Y.Doc()
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc))
  const shared = new SharedDefinition<WorkflowDefinition>(doc, workflowSpec)
  const origin = Symbol('local')
  return { shared, history: new SharedHistory<WorkflowDefinition, View>(shared, origin) }
}

function sync(a: SharedDefinition<unknown>, b: SharedDefinition<unknown>) {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)))
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)))
}

describe('SharedHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  const start = workflow(code('a', 'return 1'), code('b', 'return 2'))
  const view = (selected: string): View => ({ selected })

  it("undoes one's own edit and keeps someone else's", () => {
    const me = editor()
    me.shared.set(start)
    const them = editor(me.shared)
    me.history.edit(withCode(me.shared.value, 'a', 'return 10'), view('a'), '.blocks.1.config.code')
    them.shared.set(withCode(them.shared.value, 'b', 'return 20'), 'them')
    // They also typed in the same field after me: undo puts back only my part.
    sync(me.shared, them.shared)
    them.shared.set(withCode(them.shared.value, 'a', 'return 10 + x'), 'them')
    sync(me.shared, them.shared)
    expect(me.history.undo()).toEqual({ view: view('a') })
    sync(me.shared, them.shared)
    expect(codeOf(me.shared.value, 'a')).toBe('return 1 + x')
    expect(codeOf(me.shared.value, 'b')).toBe('return 20')
    expect(them.shared.value).toEqual(me.shared.value)
    expect(me.history.canUndo).toBe(false)
  })

  it('makes edits of the same values a moment apart one step', () => {
    const me = editor()
    me.shared.set(start)
    const key = '.blocks.1.config.code'
    for (const src of ['return 1x', 'return 1xy', 'return 1xyz']) {
      me.history.edit(withCode(me.shared.value, 'a', src), view('a'), key)
      vi.advanceTimersByTime(300)
    }
    me.history.undo()
    expect(codeOf(me.shared.value, 'a')).toBe('return 1')
    expect(me.history.canUndo).toBe(false)
  })

  it('starts a new step on another key, a null key, a seal, or after a pause', () => {
    const me = editor()
    me.shared.set(start)
    const a = '.blocks.1.config.code'
    me.history.edit(withCode(me.shared.value, 'a', 'A1'), view('a'), a)
    me.history.edit(withCode(me.shared.value, 'b', 'B1'), view('b'), '.blocks.2.config.code')
    me.history.edit(withCode(me.shared.value, 'b', 'B2'), view('b'), null)
    me.history.edit(withCode(me.shared.value, 'b', 'B3'), view('b'), null)
    me.history.seal()
    me.history.edit(withCode(me.shared.value, 'a', 'A2'), view('a'), a)
    vi.advanceTimersByTime(1500)
    me.history.edit(withCode(me.shared.value, 'a', 'A3'), view('a'), a)
    const steps: (string | undefined)[][] = []
    while (me.history.undo()) steps.push([codeOf(me.shared.value, 'a'), codeOf(me.shared.value, 'b')])
    expect(steps).toEqual([
      ['A2', 'B3'],
      ['A1', 'B3'],
      ['A1', 'B2'],
      ['A1', 'B1'],
      ['A1', 'return 2'],
      ['return 1', 'return 2'],
    ])
  })

  it('shows the view a step was made in on undo, and the view it was undone from on redo', () => {
    const me = editor()
    me.shared.set(start)
    me.history.edit(withCode(me.shared.value, 'a', 'A1'), view('a'), null)
    me.history.edit(withCode(me.shared.value, 'b', 'B1'), view('b'), null)
    expect(me.history.undo(view('elsewhere'))).toEqual({ view: view('b') })
    expect(me.history.undo(view('b'))).toEqual({ view: view('a') })
    expect(me.history.redo()).toEqual({ view: view('b') })
    expect(codeOf(me.shared.value, 'a')).toBe('A1')
    expect(me.history.redo()).toEqual({ view: view('elsewhere') })
    expect(codeOf(me.shared.value, 'b')).toBe('B1')
    expect(me.history.redo()).toBeNull()
    // Views travel with a step through undo and redo again.
    expect(me.history.undo()).toEqual({ view: view('b') })
  })

  it('drops what could be redone on a new edit, and ignores edits from elsewhere', () => {
    const me = editor()
    me.shared.set(start)
    const them = editor(me.shared)
    me.history.edit(withCode(me.shared.value, 'a', 'A1'), view('a'), null)
    me.history.undo()
    expect(me.history.canRedo).toBe(true)
    me.history.edit(withCode(me.shared.value, 'b', 'B1'), view('b'), null)
    expect(me.history.canRedo).toBe(false)
    sync(me.shared, them.shared)
    them.shared.set(withCode(them.shared.value, 'a', 'theirs'), 'them')
    sync(me.shared, them.shared)
    me.history.undo()
    expect(me.history.canUndo).toBe(false)
    expect(codeOf(me.shared.value, 'a')).toBe('theirs')
    expect(codeOf(me.shared.value, 'b')).toBe('return 2')
  })

  it('groups a direct change to a text with edits of the same field', () => {
    const me = editor()
    me.shared.set(start)
    const key = '.blocks.1.config.code'
    me.history.edit(withCode(me.shared.value, 'a', 'return 1x'), view('a'), key)
    const text = me.shared.textAt(['blocks', 1, 'config', 'code'])!
    me.history.change(view('a'), key, Date.now(), () => text.insert(text.length, 'y'))
    expect(codeOf(me.shared.value, 'a')).toBe('return 1xy')
    me.history.undo()
    expect(codeOf(me.shared.value, 'a')).toBe('return 1')
    expect(me.history.canUndo).toBe(false)
  })

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    const me = editor()
    me.shared.set(start)
    for (let i = 0; i < HISTORY_LIMIT + 20; i++)
      me.history.edit(withCode(me.shared.value, 'a', `v${i}`), view('a'), null)
    let undone = 0
    while (me.history.undo()) undone++
    expect(undone).toBe(HISTORY_LIMIT)
    expect(codeOf(me.shared.value, 'a')).toBe('v19')
  })
})
