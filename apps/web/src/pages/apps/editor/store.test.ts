import { type AppDefinition, addComponent, setPositions } from '@ow/app-definition'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppEditor } from './store'

const START: AppDefinition = {
  schemaVersion: 1,
  pages: [
    { name: 'home', title: 'Home' },
    { name: 'detail', title: 'Detail' },
  ],
  components: [
    { name: 'title', type: 'text', page: 'home', props: { value: 'Hello' } },
    { name: 'body', type: 'text', page: 'detail', props: { value: 'Body' } },
  ],
  queries: [{ name: 'orders', kind: 'js', code: 'return 1' }],
  layout: { title: { x: 0, y: 0, w: 6, h: 2 }, body: { x: 0, y: 0, w: 6, h: 2 } },
}

const editor = () => useAppEditor.getState()
const json = (d: AppDefinition) => JSON.stringify(d)
const setText = (name: string, value: string) =>
  editor().update((d) => ({
    ...d,
    components: d.components.map((c) => (c.name === name ? { ...c, props: { ...c.props, value } } : c)),
  }))

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  editor().load('a1', START, 2, 'hash')
})

describe('undo and redo in the app editor', () => {
  it('goes back to the exact starting definition, layout included, and forward again', () => {
    editor().update((d) => addComponent(d, 'button', { page: 'home' }).definition)
    vi.advanceTimersByTime(2000)
    setText('title', 'Hello there')
    vi.advanceTimersByTime(2000)
    editor().update((d) => setPositions(d, { title: { x: 3, y: 1, w: 6, h: 2 } }))
    const end = editor().definition

    for (let i = 0; i < 3; i++) editor().undo()
    expect(json(editor().definition)).toBe(json(START))
    expect(editor().status).toBe('saved')
    for (let i = 0; i < 3; i++) editor().redo()
    expect(editor().definition).toBe(end)
  })

  it('merges typing in one prop, and keeps props and pages apart', () => {
    setText('title', 'H')
    vi.advanceTimersByTime(300)
    setText('title', 'Hi')
    setText('body', 'B') // another component's prop: its own step
    expect(editor().history.past).toHaveLength(2)
    editor().setUrl('detail')
    setText('body', 'Bo') // after a page change: its own step
    expect(editor().history.past).toHaveLength(3)
  })

  it('shows what was showing: the component, the code item and the page', () => {
    editor().select('body')
    editor().setUrl('detail')
    editor().openCodeItem('orders')
    setText('body', 'Changed')
    editor().select(null)
    editor().setUrl('home')
    editor().undo()
    expect(editor()).toMatchObject({ selected: 'body', openCode: 'orders', url: { page: 'detail' } })
  })

  it('drops what no longer exists: an undone component isn’t selected, an undone query isn’t open', () => {
    editor().update((d) => ({ ...d, queries: [...d.queries, { name: 'extra', kind: 'js', code: '' }] }))
    editor().openCodeItem('extra')
    editor().update((d) => addComponent(d, 'text', { page: 'home' }).definition)
    const added = editor().definition.components.at(-1)!.name
    editor().select(added)
    setText(added, 'x')
    editor().undo() // the text
    editor().undo() // the component
    expect(editor().selected).toBeNull()
    editor().undo() // the query
    expect(editor().openCode).toBe('orders')
  })

  it('ignores edits that change nothing, read-only drafts, and undo while in conflict', () => {
    editor().update((d) => ({ ...d }))
    expect(editor().history.past).toEqual([])
    setText('title', 'x')
    editor().conflict()
    editor().undo()
    expect(json(editor().definition)).toContain('"x"')
    editor().load('a1', START, 3, 'hash', { readOnly: true })
    setText('title', 'y')
    editor().undo()
    expect(editor().definition).toBe(START)
    expect(editor().epoch).toBeGreaterThanOrEqual(0)
  })
})
