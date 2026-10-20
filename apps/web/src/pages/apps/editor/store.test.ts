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

  it('redoes to what was showing after the edit: an added component is selected again', () => {
    editor().select('title')
    editor().update((d) => addComponent(d, 'text', { page: 'home' }).definition)
    const added = editor().definition.components.at(-1)!.name
    editor().select(added)
    editor().undo()
    expect(editor().selected).toBe('title')
    editor().redo()
    expect(editor().selected).toBe(added)
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

  it('copies what was chosen last: a component, or a code item', () => {
    expect(editor().focus).toBe('component')
    editor().openCodeItem('orders')
    expect(editor().focus).toBe('code')
    editor().select('title')
    expect(editor().focus).toBe('component')
    editor().select(null) // deselecting doesn't move it to the code
    expect(editor().focus).toBe('component')
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

describe('modules in the app editor (M14)', () => {
  const placing: AppDefinition = {
    schemaVersion: 1,
    components: [
      { name: 'picker1', type: 'module', props: { module: 'picker', plan: 'free' } },
      { name: 'other1', type: 'module', props: { module: 'gone', version: '1.0.0' } },
      { name: 'shown', type: 'text', props: { value: '{{ picker1.firstEmail }}' } },
    ],
    queries: [],
  }
  const picker = {
    id: 'm1',
    name: 'Picker',
    liveVersion: '1.0.0',
    versions: { '1.0.0': { inputs: ['plan'], outputs: ['firstEmail'], events: ['picked'] } },
  }
  const codes = () => editor().diagnostics.map((d) => `${d.code} ${d.path.join('.')}`)

  it('checks the instances once every module placed is known', () => {
    editor().load('a2', placing, 1, 'hash')
    expect(codes()).toEqual([])
    editor().setModules({ picker })
    // `gone` isn't known yet: nothing is checked against the modules.
    expect(codes()).toEqual([])
    editor().setModules({ gone: null })
    expect(codes()).toEqual(['unknown_module components.1.props.module'])
    editor().update((d) => ({
      ...d,
      components: d.components.map((c) =>
        c.name === 'shown' ? { ...c, props: { value: '{{ picker1.nope }}' } } : c,
      ),
    }))
    expect(codes()).toContain('unknown_property components.2.props.value')
  })

  it('keeps the module releases unless they change', () => {
    editor().setModuleReleases({})
    const before = editor().moduleReleases
    editor().setModuleReleases({})
    expect(editor().moduleReleases).toBe(before)
    const releases = { 'picker@latest': { releaseId: 'r1', definition: placing } }
    editor().setModuleReleases(releases)
    expect(editor().moduleReleases).toBe(releases)
  })
})
