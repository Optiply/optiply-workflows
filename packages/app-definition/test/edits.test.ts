import { describe, expect, it } from 'vitest'
import {
  addComponent,
  addPage,
  addQuery,
  addTransformer,
  addVariable,
  entityPages,
  movePage,
  moveToParent,
  nextName,
  onPage,
  pageNameReason,
  removeCode,
  removeComponent,
  removeComponents,
  removePage,
  renamePage,
  setEntityPage,
  setHandlers,
  setPageTitle,
  setPositions,
  setProp,
  validateApp,
} from '../src'
import { app, comp, sqlQuery } from './helpers'

describe('edits', () => {
  it('adds components with free names below what is there, modals without a position', () => {
    let def = app({ components: [comp('table1', 'table')], layout: { table1: { x: 0, y: 0, w: 12, h: 20 } } })
    const t = addComponent(def, 'table')
    expect(t.name).toBe('table2')
    expect(t.definition.layout!.table2).toEqual({ x: 0, y: 20, w: 12, h: 20 })
    def = t.definition
    const form = addComponent(def, 'form', { position: { x: 9, y: 3 } })
    // Six columns wide from x 9 would overflow: it moves left.
    expect(form.definition.layout![form.name]).toEqual({ x: 6, y: 3, w: 6, h: 16 })
    const input = addComponent(form.definition, 'textInput', { parent: form.name })
    expect(input.definition.layout![input.name]).toMatchObject({ y: 0 })
    const modal = addComponent(input.definition, 'modal', { parent: form.name })
    expect(modal.definition.components.at(-1)).toEqual({ name: 'modal1', type: 'modal' })
    expect(modal.definition.layout!.modal1).toBeUndefined()
    expect(validateApp(modal.definition).ok).toBe(true)
    expect(() => addComponent(def, 'slider')).toThrow('Unknown component type')
    // Names are shared with queries.
    expect(nextName(addQuery(def, 'js').definition, 'query')).toBe('query2')
  })

  it('removes a component with what is inside it', () => {
    let def = app()
    const box = addComponent(def, 'container')
    const inner = addComponent(box.definition, 'text', { parent: box.name })
    const other = addComponent(inner.definition, 'button')
    def = removeComponent(other.definition, box.name)
    expect(def.components.map((c) => c.name)).toEqual(['button1'])
    expect(Object.keys(def.layout!)).toEqual(['button1'])
  })

  it('sets props sparsely, handlers, and positions only when they moved', () => {
    let def = app({ components: [comp('t', 'text')], layout: { t: { x: 0, y: 0, w: 4, h: 2 } } })
    def = setProp(def, 't', 'value', 'Hi {{ 1 }}')
    expect(def.components[0]!.props).toEqual({ value: 'Hi {{ 1 }}' })
    def = setProp(def, 't', 'value', undefined)
    expect(def.components[0]!.props).toBeUndefined()
    const handler = { id: 'a', event: 'click', action: { type: 'notify' as const, message: 'x' } }
    expect(setHandlers(def, 't', [handler]).components[0]!.events).toEqual([handler])
    expect(setHandlers(setHandlers(def, 't', [handler]), 't', []).components[0]!.events).toBeUndefined()
    expect(setPositions(def, { t: { x: 0, y: 0, w: 4, h: 2 } })).toBe(def)
    expect(setPositions(def, { t: { x: 1, y: 0, w: 4, h: 2 } }).layout!.t).toEqual({ x: 1, y: 0, w: 4, h: 2 })
  })

  it('moves components between parents, refusing loops and non-containers', () => {
    let def = app()
    const a = addComponent(def, 'container')
    const b = addComponent(a.definition, 'container', { parent: a.name })
    const t = addComponent(b.definition, 'text')
    def = t.definition
    expect(moveToParent(def, a.name, b.name)).toBe(def)
    expect(moveToParent(def, t.name, 'nope')).toBe(def)
    const moved = moveToParent(def, t.name, b.name)
    expect(moved.components.find((c) => c.name === t.name)!.parent).toBe(b.name)
    expect(moved.layout![t.name]).toMatchObject({ x: 0, y: 0 })
    expect(
      moveToParent(moved, t.name, undefined).components.find((c) => c.name === t.name)!.parent,
    ).toBeUndefined()
  })

  it('adds and removes queries, transformers and variables', () => {
    let def = app()
    const q = addQuery(def, 'resource', { resource: 'warehouse' })
    expect(q.definition.queries[0]).toEqual({
      name: 'query1',
      kind: 'resource',
      resource: 'warehouse',
      query: { sql: 'select 1' },
      run: 'auto',
    })
    const t = addTransformer(q.definition)
    const v = addVariable(t.definition)
    def = v.definition
    expect([t.name, v.name]).toEqual(['transformer1', 'variable1'])
    def = removeCode(removeCode(removeCode(def, 'query1'), 'transformer1'), 'variable1')
    expect(def).toMatchObject({ queries: [], transformers: [], variables: [] })
  })
})

describe('page edits', () => {
  const single = app({
    components: [
      comp('table1', 'table'),
      comp('box', 'container'),
      comp('inner', 'text', {}, { parent: 'box' }),
      comp('dialog', 'modal'),
    ],
    queries: [sqlQuery('q1', 'select 1')],
    transformers: [{ name: 't1', code: 'return 1' }],
    variables: [{ name: 'v1' }],
    layout: {
      table1: { x: 0, y: 0, w: 12, h: 20 },
      box: { x: 0, y: 20, w: 12, h: 8 },
      inner: { x: 0, y: 0, w: 4, h: 2 },
    },
  })

  it('the first page added moves everything onto page1; later ones are empty', () => {
    const { definition: two, name } = addPage(single)
    expect(name).toBe('page2')
    expect(two.pages).toEqual([{ name: 'page1' }, { name: 'page2' }])
    expect(Object.fromEntries(entityPages(two))).toEqual({
      table1: 'page1',
      box: 'page1',
      inner: 'page1',
      dialog: 'page1',
      q1: 'page1',
      t1: 'page1',
      v1: null,
    })
    // Only top-level components say so themselves.
    expect(two.components.find((c) => c.name === 'inner')!.page).toBeUndefined()
    expect(validateApp(two).diagnostics).toEqual([])
    const three = addPage(two)
    expect(three.name).toBe('page3')
    expect(three.definition.pages!.map((p) => p.name)).toEqual(['page1', 'page2', 'page3'])
  })

  it('renames a page and what is on it, and links to it', () => {
    const two = addPage(single).definition
    const nav = addComponent(two, 'navigation').definition
    const linked = setProp(nav, 'navigation1', 'items', [{ page: 'page1', label: 'Home' }, { page: 'page2' }])
    const renamed = renamePage(linked, 'page1', 'home')
    expect(renamed.pages![0]).toEqual({ name: 'home' })
    expect(entityPages(renamed).get('table1')).toBe('home')
    expect(entityPages(renamed).get('q1')).toBe('home')
    expect(renamed.components.find((c) => c.name === 'navigation1')!.props!.items).toEqual([
      { page: 'home', label: 'Home' },
      { page: 'page2' },
    ])
    for (const bad of ['page2', 'edit', '2nd', 'has space'])
      expect(renamePage(renamed, 'home', bad)).toBe(renamed)
    expect(pageNameReason(renamed, 'page2')).toBe('Another page is already named "page2"')
    expect(pageNameReason(renamed, 'home', 'home')).toBeNull()
    expect(pageNameReason(renamed, 'edit')).toMatch(/editor/)
  })

  it('titles and order', () => {
    const two = addPage(single).definition
    // As typed: the panel sets it on each keystroke, so a trailing space must survive until the next word.
    expect(setPageTitle(two, 'page1', 'Order ').pages![0]).toEqual({ name: 'page1', title: 'Order ' })
    expect(setPageTitle(two, 'page1', 'Order details').pages![0]).toEqual({
      name: 'page1',
      title: 'Order details',
    })
    expect(setPageTitle(two, 'page1', '   ').pages![0]).toEqual({ name: 'page1' })
    expect(setPageTitle(setPageTitle(two, 'page1', 'X'), 'page1', '').pages![0]).toEqual({ name: 'page1' })
    expect(movePage(two, 'page2', -1).pages!.map((p) => p.name)).toEqual(['page2', 'page1'])
    expect(movePage(two, 'page2', 1)).toBe(two)
  })

  it('deleting a page takes what is on it; the last page stays', () => {
    const two = addPage(single).definition
    expect([...onPage(two, 'page1')].sort()).toEqual(['box', 'dialog', 'inner', 'q1', 't1', 'table1'])
    const left = removePage(two, 'page1')
    expect(left.pages).toEqual([{ name: 'page2' }])
    expect(left.components).toEqual([])
    expect(left.queries).toEqual([])
    expect(left.transformers).toEqual([])
    expect(left.variables).toEqual([{ name: 'v1' }])
    expect(left.layout).toEqual({})
    expect(removePage(left, 'page2')).toBe(left)
    // Navigation links to a deleted page go with it (they'd block publishing).
    const nav = addComponent(addPage(two).definition, 'navigation').definition
    const linked = setProp(nav, 'navigation1', 'items', [{ page: 'page1' }, { page: 'page2', label: 'Two' }])
    const without = removePage(linked, 'page2')
    expect(without.components.find((c) => c.name === 'navigation1')!.props!.items).toEqual([
      { page: 'page1' },
    ])
    expect(validateApp(without).diagnostics.filter((d) => d.code === 'unknown_page')).toEqual([])
  })

  it('rewrites utils.openPage of a renamed page in templates and code, not computed names (M24)', () => {
    const two = addPage(single).definition
    const withCode = {
      ...two,
      components: [
        ...two.components,
        comp(
          'go',
          'button',
          { text: "{{ url.page === 'page2' ? 'Here' : 'Go' }}" },
          {
            events: [
              {
                id: 'a',
                event: 'click',
                action: {
                  type: 'runScript',
                  code: "utils.openPage('page2', { id: 1 }); utils.openPage(target)",
                },
              },
            ],
          },
        ),
      ],
      queries: [...two.queries, { name: 'nav', kind: 'js' as const, code: 'utils.openPage("page2")' }],
    }
    const renamed = renamePage(withCode, 'page2', 'orders')
    const go = renamed.components.find((c) => c.name === 'go')!
    expect(go.events![0]!.action).toMatchObject({
      code: "utils.openPage('orders', { id: 1 }); utils.openPage(target)",
    })
    expect(renamed.queries.find((q) => q.name === 'nav')).toMatchObject({ code: 'utils.openPage("orders")' })
    // A comparison with the name isn't a call: left as written.
    expect(go.props!.text).toBe("{{ url.page === 'page2' ? 'Here' : 'Go' }}")
  })

  it('follows page renames and removals into Navigation groups, and checks links (M24)', () => {
    const two = addPage(single).definition
    const nav = addComponent(two, 'navigation').definition
    const linked = setProp(nav, 'navigation1', 'items', [
      { label: 'Shop', icon: 'cart', items: [{ page: 'page1' }, { page: 'page2', label: 'Two' }] },
      { url: 'https://optiply.com', label: 'Site', icon: 'external' },
    ])
    const items = (d: typeof linked) => d.components.find((c) => c.name === 'navigation1')!.props!.items
    expect(items(renamePage(linked, 'page2', 'orders'))).toEqual([
      { label: 'Shop', icon: 'cart', items: [{ page: 'page1' }, { page: 'orders', label: 'Two' }] },
      { url: 'https://optiply.com', label: 'Site', icon: 'external' },
    ])
    expect(items(removePage(linked, 'page2'))).toEqual([
      { label: 'Shop', icon: 'cart', items: [{ page: 'page1' }] },
      { url: 'https://optiply.com', label: 'Site', icon: 'external' },
    ])
    expect(validateApp(linked).diagnostics).toEqual([])
    const bad = setProp(nav, 'navigation1', 'items', [
      { url: 'javascript:alert(1)' },
      { url: "{{ 'https://' + 'optiply.com' }}" },
      { page: 'page1', icon: 'unicorn' },
      { label: 'G', items: [{ page: 'nope' }, { label: 'deeper', items: [{ page: 'page1' }] }] },
    ])
    expect(
      validateApp(bad).diagnostics.map((d) => [d.severity, d.path.slice(4).join('.'), d.message]),
    ).toEqual([
      ['error', '0.url', 'A link opens a web page or an email: http://, https:// or mailto:'],
      ['warning', '2.icon', 'No icon is named "unicorn": it shows without one'],
      ['error', '3.items.0.page', 'No page is named "nope"'],
      ['warning', '3.items.1.items', 'A group holds links, not groups: these aren’t shown'],
    ])
  })

  it('removes several components with what is inside them (M24)', () => {
    const def = app({
      components: [
        comp('a', 'text'),
        comp('b', 'text'),
        comp('box', 'container'),
        comp('in', 'text', {}, { parent: 'box' }),
      ],
      layout: {
        a: { x: 0, y: 0, w: 4, h: 2 },
        b: { x: 4, y: 0, w: 2, h: 2 },
        box: { x: 0, y: 2, w: 6, h: 6 },
        in: { x: 0, y: 0, w: 6, h: 2 },
      },
    })
    const gone = removeComponents(def, ['box', 'a'])
    expect(gone.components.map((c) => c.name)).toEqual(['b'])
    expect(Object.keys(gone.layout ?? {})).toEqual(['b'])
  })

  it('new things go on the page given; moves follow the page', () => {
    const two = addPage(single).definition
    const added = addComponent(two, 'text', { page: 'page2' })
    expect(added.definition.components.at(-1)).toMatchObject({ name: 'text1', page: 'page2' })
    // Its own page's grid: at the top of the empty page, not below page1's table.
    expect(added.definition.layout!.text1!.y).toBe(0)
    expect(
      addComponent(two, 'text', { parent: 'box', page: 'page2' }).definition.components.at(-1)!.page,
    ).toBeUndefined()
    expect(addQuery(two, 'js', { page: 'page2' }).definition.queries.at(-1)!.page).toBe('page2')
    expect(addTransformer(two, { page: 'page2' }).definition.transformers!.at(-1)!.page).toBe('page2')
    // Out of its container onto a page; into one, the container's page.
    const out = moveToParent(two, 'inner', undefined, { page: 'page2' })
    expect(out.components.find((c) => c.name === 'inner')).toEqual({
      name: 'inner',
      type: 'text',
      props: {},
      page: 'page2',
    })
    const back = moveToParent(out, 'inner', 'box')
    expect(back.components.find((c) => c.name === 'inner')!.page).toBeUndefined()
    // Onto every page, and back.
    const global = setEntityPage(two, 'table1', null)
    expect(entityPages(global).get('table1')).toBeNull()
    expect(setEntityPage(global, 'table1', 'page2').components.find((c) => c.name === 'table1')!.page).toBe(
      'page2',
    )
    expect(setEntityPage(two, 'q1', null).queries[0]!.page).toBeUndefined()
    expect(setEntityPage(two, 'inner', 'page2')).toBe(two)
    // Out of the frame's sidebar onto a page: the sidebar holds components on every page only.
    const framed = { ...global, frame: { sidebar: 'medium' as const } }
    const inSidebar = moveToParent(framed, 'table1', undefined, { slot: 'sidebar', page: null })
    expect(inSidebar.components.find((c) => c.name === 'table1')!.slot).toBe('sidebar')
    const onPage = setEntityPage(inSidebar, 'table1', 'page2').components.find((c) => c.name === 'table1')!
    expect(onPage).toMatchObject({ page: 'page2' })
    expect(onPage.slot).toBeUndefined()
    const slots = (def: unknown) => validateApp(def).diagnostics.filter((d) => d.code === 'invalid_slot')
    expect(slots(setEntityPage(inSidebar, 'table1', 'page2'))).toEqual([])
    // As a sidebar slot left on a page component would be.
    expect(
      slots({
        ...inSidebar,
        components: inSidebar.components.map((c) => (c.name === 'table1' ? { ...c, page: 'page2' } : c)),
      }),
    ).not.toEqual([])
  })

  it('Navigation links must name pages', () => {
    const two = addPage(single).definition
    const nav = addComponent(two, 'navigation').definition
    const linked = setProp(nav, 'navigation1', 'items', [
      { page: 'page1' },
      { page: 'nowhere' },
      { page: '{{ x }}' },
    ])
    expect(validateApp(linked).diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['unknown_page', 'components.4.props.items.1.page'],
      ['unknown_identifier', 'components.4.props.items.2.page'],
    ])
  })
})
