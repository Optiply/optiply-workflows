import type { WorkflowDefinition } from '@ow/definition'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const json = (def: WorkflowDefinition) => JSON.stringify(def)
const typeCode = (code: string) =>
  updateBlock<Extract<WorkflowDefinition['blocks'][number], { type: 'code' }>>('code1', (b) => ({
    ...b,
    config: { ...b.config, code },
  }))
const addBlock = (name: string) =>
  updateGraph((g) => ({ ...g, blocks: [...g.blocks, { name, type: 'code', config: { code: '' } }] }))

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  editor().load('w1', START, 3, 'hash')
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
    expect(editor().status).toBe('saved') // what the server has: nothing to save
    editor().undo() // nothing left
    expect(json(editor().definition)).toBe(json(START))

    for (let i = 0; i < 3; i++) editor().redo()
    expect(editor().definition).toBe(end)
    expect(editor().status).toBe('dirty')
  })

  it('undoes a burst of typing in one step, and a pause or a new selection starts another', () => {
    typeCode('return 1 +')
    vi.advanceTimersByTime(200)
    typeCode('return 1 + 2')
    vi.advanceTimersByTime(2000)
    typeCode('return 1 + 23')
    editor().select('code1')
    typeCode('return 1 + 234')
    expect(editor().history.past).toHaveLength(3)
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

  it('ignores an edit that rebuilds the definition without changing it', () => {
    typeCode('return 1')
    updateBlock('code1', (b) => ({ ...b }))
    expect(editor().history.past).toEqual([])
    expect(editor().status).toBe('saved')
  })

  it('raises the epoch on undo and redo, and clears the history when a draft is loaded', () => {
    typeCode('x')
    const epoch = editor().epoch
    editor().undo()
    editor().redo()
    expect(editor().epoch).toBe(epoch + 2)
    editor().load('w1', START, 4, 'hash')
    expect(editor().history.past).toEqual([])
    expect(editor().history.future).toEqual([])
  })

  it('ignores edits and undo on a read-only draft, and undo while it conflicts', () => {
    typeCode('x')
    editor().conflict()
    editor().undo()
    expect(json(editor().definition)).toContain('"x"')

    editor().load('w1', START, 4, 'hash', { readOnly: true })
    typeCode('y')
    editor().undo()
    expect(editor().definition).toBe(START)
    expect(editor().history.past).toEqual([])
  })

  it('keeps a save in flight: `saved` decides whether the undone draft still needs saving', () => {
    typeCode('x')
    const sent = json(editor().definition)
    editor().saving()
    editor().undo()
    expect(editor().status).toBe('saving')
    editor().saved(4, sent, 'hash2')
    expect(editor().status).toBe('dirty') // the server now has "x"; the draft is back to the start
  })
})
