import { SharedDefinition, workflowSpec } from '@ow/collab'
import type { WorkflowDefinition } from '@ow/definition'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { updateBlock, updateGraph, useEditor } from './store'

const START: WorkflowDefinition = {
  schemaVersion: 1,
  blocks: [
    { name: 'startTrigger', type: 'startTrigger', config: {} },
    { name: 'code1', type: 'code', config: { code: 'return 1' } },
  ],
  edges: [{ from: 'startTrigger', port: 'out', to: 'code1' }],
  functions: [
    {
      name: 'helper',
      params: [],
      blocks: [{ name: 'result', type: 'code', config: { code: '' } }],
      edges: [],
    },
  ],
}

const editor = () => useEditor.getState()
/** Steps this editor can undo, and redo. */
const past = () => editor().history?.undoManager.undoStack.length ?? 0
const future = () => editor().history?.undoManager.redoStack.length ?? 0
const json = (def: WorkflowDefinition) => JSON.stringify(def)
const typeCode = (code: string) =>
  updateBlock<Extract<WorkflowDefinition['blocks'][number], { type: 'code' }>>('code1', (b) => ({
    ...b,
    config: { ...b.config, code },
  }))
const addBlock = (name: string) =>
  updateGraph((g) => ({ ...g, blocks: [...g.blocks, { name, type: 'code', config: { code: '' } }] }))

/** A shared document holding `def`, as one synced from the server. */
function synced(def: WorkflowDefinition): SharedDefinition<WorkflowDefinition> {
  const shared = new SharedDefinition<WorkflowDefinition>(new Y.Doc(), workflowSpec)
  shared.set(def)
  return shared
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  editor().load('w1', START, 3, 'hash')
  editor().attach(synced(START))
})

describe('undo and redo in the workflow editor', () => {
  it('goes back to the exact starting definition and forward again', () => {
    addBlock('code2')
    vi.advanceTimersByTime(2000)
    typeCode('return 2')
    vi.advanceTimersByTime(2000)
    updateGraph((g) => ({ ...g, edges: [...g.edges, { from: 'code1', port: 'out', to: 'code2' }] }))
    const end = editor().definition

    for (let i = 0; i < 3; i++) editor().undo()
    expect(json(editor().definition)).toBe(json(START))
    expect(editor().shared?.value).toEqual(START)
    editor().undo() // nothing left
    expect(json(editor().definition)).toBe(json(START))

    for (let i = 0; i < 3; i++) editor().redo()
    expect(editor().definition).toEqual(end)
  })

  it('undoes a burst of typing in one step, and a pause or a new selection starts another', () => {
    typeCode('return 1 +')
    vi.advanceTimersByTime(200)
    typeCode('return 1 + 2')
    vi.advanceTimersByTime(2000)
    typeCode('return 1 + 23')
    editor().select('code1')
    typeCode('return 1 + 234')
    expect(past()).toBe(3)
    editor().undo()
    editor().undo()
    expect(json(editor().definition)).toContain('"return 1 + 2"')
    editor().undo()
    expect(json(editor().definition)).toBe(json(START))
  })

  it('puts back what was selected, unless it no longer exists', () => {
    editor().openGraph('helper', 'result')
    updateGraph((g) => ({
      ...g,
      blocks: [...g.blocks, { name: 'extra', type: 'code', config: { code: '' } }],
    }))
    editor().openGraph(null, 'code1')
    editor().undo()
    expect(editor()).toMatchObject({ graph: 'helper', selected: 'result' })

    // An edit made while a function that doesn't exist was open (and a block that doesn't exist selected): undoing it
    // opens the workflow, with nothing selected.
    editor().openGraph('gone', 'nothing')
    editor().update((def) => ({ ...def, edges: [] }))
    editor().undo()
    expect(editor()).toMatchObject({ graph: null, selected: null })
  })

  it('redoes to what was showing after the edit: a renamed block stays selected', () => {
    editor().select('code1')
    editor().update((def) => ({
      ...def,
      blocks: def.blocks.map((b) => (b.name === 'code1' ? { ...b, name: 'fetch' } : b)),
      edges: def.edges.map((e) => (e.to === 'code1' ? { ...e, to: 'fetch' } : e)),
    }))
    editor().select('fetch')
    editor().undo()
    expect(editor().selected).toBe('code1')
    editor().redo()
    expect(editor()).toMatchObject({ selected: 'fetch', selection: ['fetch'] })
  })

  it('ignores an edit that rebuilds the definition without changing it', () => {
    typeCode('return 1')
    updateBlock('code1', (b) => ({ ...b }))
    expect(past()).toBe(0)
  })

  it('keeps the canvas selection: one block when selected in code, several from the canvas', () => {
    editor().select('code1')
    expect(editor().selection).toEqual(['code1'])
    const state = editor()
    editor().setSelection(['code1'])
    expect(editor()).toBe(state) // the same selection changes nothing (no one is notified)
    editor().setSelection(['startTrigger', 'code1'])
    editor().inspect('startTrigger')
    expect(editor()).toMatchObject({ selected: 'startTrigger', selection: ['startTrigger', 'code1'] })
    editor().select(null)
    expect(editor().selection).toEqual([])
  })

  it('raises the epoch on undo and redo, and starts a new history when a draft is loaded', () => {
    typeCode('x')
    const epoch = editor().epoch
    editor().undo()
    editor().redo()
    expect(editor().epoch).toBe(epoch + 2)
    editor().load('w1', START, 4, 'hash')
    expect(past()).toBe(0)
    expect(future()).toBe(0)
  })

  it('ignores edits until the shared document has synced, and on a read-only draft', () => {
    editor().load('w1', START, 4, 'hash')
    typeCode('x')
    editor().undo()
    expect(editor().definition).toBe(START)
    expect(past()).toBe(0)

    editor().load('w1', START, 4, 'hash', { readOnly: true })
    editor().attach(synced(START))
    typeCode('y')
    editor().undo()
    expect(json(editor().definition)).toBe(json(START))
    expect(past()).toBe(0)
  })

  it("writes edits into the shared document, and shows others' edits from it", () => {
    const shared = editor().shared!
    typeCode('return 2')
    expect(shared.value).toBe(editor().definition)
    editor().setSelection(['startTrigger', 'code1'])
    editor().inspect('code1')
    // Someone else adds a block and deletes the selected one.
    const theirs = new SharedDefinition<WorkflowDefinition>(new Y.Doc(), workflowSpec)
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(shared.doc))
    const v = theirs.value
    theirs.set({
      ...v,
      blocks: [
        ...v.blocks.filter((b) => b.name !== 'code1'),
        { name: 'other', type: 'code', config: { code: '' } },
      ],
      edges: [],
    })
    Y.applyUpdate(shared.doc, Y.encodeStateAsUpdate(theirs.doc))
    editor().remote()
    expect(editor().definition.blocks.map((b) => b.name)).toEqual(['startTrigger', 'other'])
    expect(editor()).toMatchObject({ selected: null, selection: ['startTrigger'] })
    expect(editor().diagnostics).toEqual(expect.any(Array))
  })

  it("undoes this editor's own edits only: someone else's stay", () => {
    const shared = editor().shared!
    typeCode('return "mine"')
    const theirs = new SharedDefinition<WorkflowDefinition>(new Y.Doc(), workflowSpec)
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(shared.doc))
    theirs.set({ ...theirs.value, edges: [] })
    Y.applyUpdate(shared.doc, Y.encodeStateAsUpdate(theirs.doc))
    editor().remote()
    expect(editor().definition.edges).toEqual([])
    editor().undo()
    expect(json(editor().definition)).toContain('"return 1"')
    expect(editor().definition.edges).toEqual([])
    expect(editor().canUndo).toBe(false)
    editor().redo()
    expect(json(editor().definition)).toContain('"return \\"mine\\""')
    expect(editor().definition.edges).toEqual([])
  })
})
