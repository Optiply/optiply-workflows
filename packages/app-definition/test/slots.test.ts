import { describe, expect, it } from 'vitest'
import {
  type AppDefinition,
  addComponent,
  addView,
  bottomOf,
  containerViews,
  copyComponents,
  moveIntoReason,
  moveToParent,
  pasteComponents,
  placeComponents,
  removeView,
  renameView,
  rewriteCallArgs,
  setFrame,
  slotOf,
  slotsOf,
  validateApp,
  viewNameReason,
} from '../src'
import { app, comp } from './helpers'

const views = [{ name: 'list', label: 'List' }, { name: 'details' }]
const at = (x: number, y: number, w = 4, h = 2) => ({ x, y, w, h })

/** A container with two views: a table in `list`, a text in `details`, a button in its footer, one without a slot. */
const tabs = (): AppDefinition =>
  app({
    components: [
      comp('box', 'container', { views, defaultView: 'details' }),
      comp('table1', 'table', {}, { parent: 'box', slot: 'list' }),
      comp('text1', 'text', { value: 'hi' }, { parent: 'box', slot: 'details' }),
      comp('save', 'button', {}, { parent: 'box', slot: 'footer' }),
      comp('loose', 'text', {}, { parent: 'box' }),
      comp('form1', 'form'),
      comp('in_form', 'textInput', {}, { parent: 'form1' }),
      comp('side', 'text', {}, { slot: 'sidebar' }),
      comp(
        'next',
        'button',
        {},
        {
          events: [
            {
              id: 'a',
              event: 'click',
              action: { type: 'controlComponent', component: 'box', method: 'setView', args: ['details'] },
            },
            {
              id: 'b',
              event: 'click',
              action: { type: 'runScript', code: "box.setView('details'); other.setView('details')" },
            },
          ],
        },
      ),
    ],
    queries: [{ name: 'go', kind: 'js', code: 'await box.setView("details")\nreturn 1' }],
    // Something else with a setView, whose calls a rename leaves alone.
    variables: [{ name: 'other' }],
    frame: { sidebar: 'narrow' },
    layout: {
      box: at(0, 0, 12, 10),
      table1: at(0, 0, 12, 6),
      text1: at(0, 0, 6, 3),
      save: at(0, 0, 2, 2),
      loose: at(0, 6),
      side: at(0, 0),
    },
  })

describe('slots', () => {
  it('reads a container’s views as written, skipping what can’t be one', () => {
    expect(containerViews(tabs().components[0]!)).toEqual(views)
    const odd = comp('c', 'container', {
      views: [
        { name: 'a' },
        { name: 'a' },
        { name: 'header' },
        { name: '1x' },
        'b',
        { label: 'no name' },
        { name: 'b', label: 'B' },
      ],
    })
    expect(containerViews(odd as never)).toEqual([{ name: 'a' }, { name: 'b', label: 'B' }])
    expect(containerViews(comp('t', 'container', { views: '{{ list }}' }) as never)).toEqual([])
  })

  it('places each component in a slot: a view (the first when unnamed or gone), header, footer, the frame', () => {
    const def = tabs()
    const slot = (name: string) => slotOf(def, def.components.find((c) => c.name === name)!)
    expect(['table1', 'text1', 'save', 'loose', 'in_form', 'side', 'next'].map(slot)).toEqual([
      'list',
      'details',
      'footer',
      'list',
      undefined,
      'sidebar',
      undefined,
    ])
    expect(slotsOf(def, 'box')).toEqual(['header', 'footer', 'list', 'details'])
    expect(slotsOf(def, 'form1')).toEqual([undefined])
    expect(slotsOf(def, undefined)).toEqual([undefined, 'sidebar'])
    // Each slot is a grid of its own.
    expect([
      bottomOf(def, 'box', null, 'list'),
      bottomOf(def, 'box', null, 'details'),
      bottomOf(def, 'box', null, 'footer'),
    ]).toEqual([8, 3, 2])
  })

  it('reports slots a parent doesn’t have, and views written wrong', () => {
    const def = tabs()
    def.components.push(
      comp('bad1', 'text', {}, { parent: 'box', slot: 'nope' }),
      comp('bad2', 'text', {}, { parent: 'form1', slot: 'list' }),
      comp('bad3', 'text', {}, { slot: 'footer' }),
      comp('m', 'modal', {}, { slot: 'header' }),
      comp('box2', 'container', {
        views: [{ name: 'x' }, { name: 'x' }, { name: 'footer' }, { label: 'y' }],
      }),
      comp('box3', 'container', { views: '{{ [] }}' }),
    )
    const slots = validateApp(def)
      .diagnostics.filter((d) => d.code === 'invalid_slot')
      .map((d) => [d.path.join('.'), d.message])
    expect(slots).toEqual([
      ['components.9.slot', '"box" has no view or slot "nope": it has header, footer, list, details'],
      ['components.10.slot', '"form1" has no slots'],
      ['components.11.slot', 'At the top, a component is in the frame\'s header or sidebar, not "footer"'],
      ['components.12.slot', 'A modal opens over the page; it has no slot'],
      ['components.13.props.views.1', 'Two views are named "x"'],
      ['components.13.props.views.2', '"footer" is the container\'s footer, not a view'],
      ['components.13.props.views.3', 'A view needs a name: a letter, then letters, digits or _'],
      [
        'components.14.props.views',
        'Views are written as a list of { name, label }, not computed: components are placed in them by name',
      ],
    ])
    expect(validateApp(tabs()).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('adds, moves and pastes into a slot, below what that slot holds', () => {
    const added = addComponent(tabs(), 'text', { parent: 'box', slot: 'details' })
    expect(added.definition.components.at(-1)).toEqual({
      name: 'text2',
      type: 'text',
      parent: 'box',
      slot: 'details',
    })
    expect(added.definition.layout?.text2?.y).toBe(3)
    const moved = moveToParent(tabs(), 'side', 'box', { slot: 'footer' })
    expect(moved.components.find((c) => c.name === 'side')).toMatchObject({ parent: 'box', slot: 'footer' })
    expect(moved.layout?.side?.y).toBe(2)
    // Out to the page: the slot goes.
    expect(moveToParent(tabs(), 'save', undefined).components.find((c) => c.name === 'save')).toEqual(
      expect.not.objectContaining({ slot: expect.anything() }),
    )
    // Another view of the same container is a move too.
    expect(
      moveToParent(tabs(), 'text1', 'box', { slot: 'list' }).components.find((c) => c.name === 'text1')!.slot,
    ).toBe('list')
    const pasted = pasteComponents(tabs(), copyComponents(tabs(), ['save'])!, {
      parent: 'box',
      page: null,
      slot: 'details',
    })
    expect(pasted.definition.components.at(-1)).toMatchObject({
      name: 'save1',
      parent: 'box',
      slot: 'details',
    })
    const top = pasteComponents(tabs(), copyComponents(tabs(), ['save'])!, { page: null })
    expect(top.definition.components.at(-1)).toEqual(expect.not.objectContaining({ slot: expect.anything() }))
  })
})

describe('views', () => {
  it('adds a view with the first free name, and says why a name can’t be one', () => {
    const { definition, name } = addView(tabs(), 'box')
    expect(name).toBe('view3')
    expect(containerViews(definition.components[0]!).map((v) => v.name)).toEqual(['list', 'details', 'view3'])
    expect(viewNameReason(tabs(), 'box', 'details')).toMatch(/has a view "details" already/)
    expect(viewNameReason(tabs(), 'box', 'details', 'details')).toBeNull()
    expect(viewNameReason(tabs(), 'box', 'footer')).toMatch(/container's footer/)
    expect(viewNameReason(tabs(), 'box', '2x')).toMatch(/letter/)
  })

  it('renames a view: children, the default, handlers and setView in code follow; others don’t', () => {
    const def = renameView(tabs(), 'box', 'details', 'info')
    const find = (n: string) => def.components.find((c) => c.name === n)!
    expect(containerViews(find('box')).map((v) => v.name)).toEqual(['list', 'info'])
    expect(find('box').props?.defaultView).toBe('info')
    expect(find('text1').slot).toBe('info')
    expect(find('table1').slot).toBe('list')
    const [handler, script] = find('next').events!
    expect(handler!.action).toMatchObject({ args: ['info'] })
    expect(script!.action).toMatchObject({ code: "box.setView('info'); other.setView('details')" })
    expect(def.queries[0]).toMatchObject({ code: 'await box.setView("info")\nreturn 1' })
    expect(validateApp(def).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    // A taken or invalid name changes nothing.
    expect(renameView(tabs(), 'box', 'details', 'list')).toEqual(tabs())
    expect(renameView(tabs(), 'box', 'nope', 'x')).toEqual(tabs())
  })

  it('removes a view, moving what’s in it to another or removing it', () => {
    const moved = removeView(tabs(), 'box', 'details', 'list')
    expect(containerViews(moved.components[0]!).map((v) => v.name)).toEqual(['list'])
    expect(moved.components[0]!.props?.defaultView).toBeUndefined()
    expect(moved.components.find((c) => c.name === 'text1')).toMatchObject({ slot: 'list' })
    expect(moved.layout?.text1?.y).toBe(8)
    const gone = removeView(tabs(), 'box', 'list', null)
    expect(gone.components.map((c) => c.name)).not.toContain('table1')
    // `loose` had no slot, so it was in the first view: it goes too.
    expect(gone.components.map((c) => c.name)).not.toContain('loose')
    expect(gone.components.map((c) => c.name)).toContain('save')
  })

  it('rewrites a string argument in templates and code, keeping the quotes', () => {
    const def = app({
      components: [
        comp('t', 'text', { value: "{{ 'x' }} {{ utils.openPage('orders', { id: 1 }) }}" }),
        comp(
          'b',
          'button',
          {},
          {
            events: [
              { id: 'a', event: 'click', action: { type: 'runScript', code: 'utils.openPage(`orders`)' } },
            ],
          },
        ),
      ],
    })
    const { definition, changed } = rewriteCallArgs(def, 'utils', 'openPage', 'orders', 'sales')
    expect(changed).toEqual([
      ['components', 0, 'props', 'value'],
      ['components', 1, 'events', 0, 'action', 'code'],
    ])
    expect(definition.components[0]!.props!.value).toBe("{{ 'x' }} {{ utils.openPage('sales', { id: 1 }) }}")
    expect(definition.components[1]!.events![0]!.action).toMatchObject({ code: 'utils.openPage(`sales`)' })
    expect(rewriteCallArgs(def, 'utils', 'openPage', 'nope', 'x').definition).toBe(def)
  })
})

describe('the frame (M24)', () => {
  it('puts components on every page in the sidebar only when the app has one', () => {
    const def = tabs()
    const side = def.components.find((c) => c.name === 'side')!
    expect(slotOf(def, side)).toBe('sidebar')
    const without = setFrame(def, { sidebar: undefined })
    expect(without.frame).toBeUndefined()
    expect(slotOf(without, side)).toBeUndefined()
    expect(slotsOf(without, undefined)).toEqual([undefined])
    expect(validateApp(without).diagnostics.filter((d) => d.code === 'invalid_slot')).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/no sidebar/) }),
    ])
    // A component on one page never sits in the frame.
    const paged = {
      ...def,
      pages: [{ name: 'home' }],
      components: def.components.map((c) => (c.name === 'side' ? { ...c, page: 'home' } : c)),
    }
    expect(slotOf(paged as AppDefinition, paged.components.find((c) => c.name === 'side')!)).toBeUndefined()
    expect(
      validateApp(paged)
        .diagnostics.filter((d) => d.code === 'invalid_slot')
        .map((d) => d.message),
    ).toEqual(['Only components on every page sit in the sidebar'])
  })

  it('keeps only the parts that are on, and refuses a frame in a module', () => {
    expect(setFrame(app(), { header: true, showTitle: false, sidebar: 'wide' }).frame).toEqual({
      header: true,
      sidebar: 'wide',
    })
    expect(setFrame(app(), { header: false }).frame).toBeUndefined()
    const module = { ...app(), module: { inputs: [], outputs: [], events: [] }, frame: { header: true } }
    expect(validateApp(module).diagnostics.map((d) => d.message)).toContain(
      "A module has no frame; it sits inside the app's",
    )
  })
})

describe('dragging onto another grid (M24)', () => {
  it('says why components can’t go somewhere', () => {
    const def = tabs()
    def.components.push(comp('m', 'modal'), comp('f2', 'form', {}, { parent: 'form1' }))
    expect(moveIntoReason(def, ['table1'], 'form1')).toBeNull()
    expect(moveIntoReason(def, ['table1'], undefined)).toBeNull()
    expect(moveIntoReason(def, ['m'], 'box')).toMatch(/modal/)
    expect(moveIntoReason(def, ['box'], 'box')).toMatch(/inside itself/)
    expect(moveIntoReason(def, ['form1'], 'box')).toBeNull()
    expect(moveIntoReason(def, ['form1'], 'f2')).toMatch(/inside itself/)
    expect(moveIntoReason(tabs(), ['save'], 'next')).toMatch(/can't hold/)
    const forms = app({
      components: [
        comp('outer', 'form'),
        comp('inner', 'form'),
        comp('c', 'container', {}, { parent: 'outer' }),
      ],
    })
    expect(moveIntoReason(forms, ['inner'], 'c')).toMatch(/inside another form/)
  })

  it('places them at the drop, keeping their offsets, into the target’s slot and page', () => {
    const def = tabs()
    // From the page into the container's footer, and out again into the frame's sidebar.
    const into = placeComponents(def, ['next'], { parent: 'box', slot: 'footer' }, { x: 3, y: 1 })
    expect(into.components.find((c) => c.name === 'next')).toMatchObject({ parent: 'box', slot: 'footer' })
    expect(into.layout?.next).toBeUndefined()
    const withPosition = { ...def, layout: { ...def.layout, next: at(0, 20) } }
    const moved = placeComponents(withPosition, ['next'], { parent: 'box', slot: 'footer' }, { x: 3, y: 1 })
    expect(moved.layout?.next).toEqual({ x: 3, y: 1, w: 4, h: 2 })
    // Two together: their offsets kept; something inside a dropped one comes along, not placed itself.
    const two = placeComponents(def, ['table1', 'text1', 'save'], { parent: 'form1' }, { x: 2, y: 0 })
    expect(two.components.filter((c) => c.parent === 'form1').map((c) => c.name)).toEqual([
      'table1',
      'text1',
      'save',
      'in_form',
    ])
    expect([two.layout?.table1, two.layout?.text1]).toEqual([
      { x: 0, y: 0, w: 12, h: 6 },
      { x: 2, y: 0, w: 6, h: 3 },
    ])
    expect(placeComponents(def, ['box'], { parent: 'box' }, { x: 0, y: 0 })).toBe(def)
    // Within the top: to the sidebar.
    const side = placeComponents(withPosition, ['next'], { slot: 'sidebar' }, { x: 0, y: 4 })
    expect(slotOf(side, side.components.find((c) => c.name === 'next')!)).toBe('sidebar')
  })
})
