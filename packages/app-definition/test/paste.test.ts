import { fieldRefs } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import {
  type AppComponent,
  type AppDefinition,
  appFields,
  codeClipSchema,
  componentClipSchema,
  copyCode,
  copyComponents,
  pasteCode,
  pasteComponents,
  validateApp,
} from '../src'
import { app, comp, sqlQuery } from './helpers'

const def = (x: object) => x as AppDefinition
const at = (x: number, y: number, w = 6, h = 2) => ({ x, y, w, h })
const propOf = (d: AppDefinition, name: string, prop: string) =>
  d.components.find((c) => c.name === name)?.props?.[prop]

const source = def(
  app({
    components: [
      comp('container1', 'container', {}, { page: 'home' }),
      comp('textInput1', 'textInput', {}, { parent: 'container1' }),
      comp('text1', 'text', { value: '{{ textInput1.value }} {{ orders.data }}' }, { parent: 'container1' }),
      comp('other', 'text', {}, { page: 'home' }),
    ],
    queries: [sqlQuery('orders', 'select 1')],
    layout: { container1: at(0, 4, 12, 6), textInput1: at(0, 0), text1: at(6, 1), other: at(0, 0) },
  }),
)

describe('copyComponents', () => {
  it('takes a component with everything inside it, and the positions', () => {
    const clip = copyComponents(source, ['container1'])!
    expect(clip.components.map((c) => c.name)).toEqual(['container1', 'textInput1', 'text1'])
    expect(Object.keys(clip.layout)).toEqual(['container1', 'textInput1', 'text1'])
    expect(componentClipSchema.safeParse(JSON.parse(JSON.stringify(clip))).success).toBe(true)
    expect(copyComponents(source, ['nothing'])).toBeNull()
  })
})

describe('pasteComponents', () => {
  it('gives taken names fresh ones; references, parents and positions follow; the rest is listed', () => {
    const target = def(
      app({
        components: [comp('container1', 'container'), comp('text1', 'text'), comp('textInput1', 'textInput')],
        layout: { container1: at(0, 0, 12, 3), text1: at(0, 3), textInput1: at(6, 3) },
      }),
    )
    const result = pasteComponents(target, copyComponents(source, ['container1'])!, { page: null })
    expect(result.added).toEqual(['container2', 'textInput2', 'text2'])
    const d = result.definition
    expect(d.components.slice(0, 3)).toEqual(target.components)
    expect(d.components.find((c) => c.name === 'textInput2')!.parent).toBe('container2')
    expect(propOf(d, 'text2', 'value')).toBe('{{ textInput2.value }} {{ orders.data }}')
    // The root at the bottom of the page's grid, its page dropped (no pages here); what's inside it where it was.
    expect(d.components.find((c) => c.name === 'container2')).toEqual({
      name: 'container2',
      type: 'container',
      props: {},
    })
    expect(d.layout).toMatchObject({ container2: at(0, 5, 12, 6), textInput2: at(0, 0), text2: at(6, 1) })
    expect(result.outside).toEqual([{ name: 'orders', inTarget: false }])
    expect(validateApp(d).diagnostics.filter((x) => x.code === 'duplicate_name')).toEqual([])
  })

  it('doesn’t list a table column’s row locals as names from outside (M24)', () => {
    const from = def(
      app({
        components: [
          comp('t', 'table', { columns: [{ key: 'x', value: '{{ currentRow.a + i + rate.value }}' }] }),
        ],
        layout: { t: at(0, 0) },
      }),
    )
    const result = pasteComponents(def(app({})), copyComponents(from, ['t'])!, { page: null })
    expect(result.outside).toEqual([{ name: 'rate', inTarget: false }])
  })

  it('pastes into a container, on a page, and keeps modals at the top without a position', () => {
    const target = def(
      app({
        pages: [{ name: 'home' }, { name: 'detail' }],
        components: [
          comp('box', 'container', {}, { page: 'detail' }),
          comp('inside', 'text', {}, { parent: 'box' }),
        ],
        layout: { box: at(0, 0, 12, 8), inside: at(0, 0, 6, 3) },
      }),
    )
    const clip = componentClipSchema.parse({
      ow: 'app-components',
      v: 1,
      components: [
        comp('label', 'text', {}, { page: 'home' }),
        comp('dialog', 'modal', {}, { page: 'home' }),
      ],
      layout: { label: at(2, 7) },
    })
    const into = pasteComponents(target, clip, { parent: 'box', page: 'detail' }).definition
    expect(into.components.find((c) => c.name === 'label')).toEqual({
      name: 'label',
      type: 'text',
      props: {},
      parent: 'box',
    })
    expect(into.layout!.label).toEqual(at(2, 3)) // below `inside`, in the box
    expect(into.components.find((c) => c.name === 'dialog')).toEqual({
      name: 'dialog',
      type: 'modal',
      props: {},
      page: 'detail',
    })
    expect(into.layout!.dialog).toBeUndefined()

    // Not a container: at the top of the page.
    const top = pasteComponents(target, clip, { parent: 'inside', page: 'detail' }).definition
    expect(top.components.find((c) => c.name === 'label')).toEqual({
      name: 'label',
      type: 'text',
      props: {},
      page: 'detail',
    })
  })

  it('pastes into a target container named like the pasted one', () => {
    const target = def(
      app({ components: [comp('container1', 'container')], layout: { container1: at(0, 0, 12, 6) } }),
    )
    const result = pasteComponents(target, copyComponents(source, ['container1'])!, {
      parent: 'container1',
      page: null,
    })
    const d = result.definition
    expect(d.components.find((c) => c.name === 'container2')!.parent).toBe('container1')
    expect(d.components.find((c) => c.name === 'textInput1')!.parent).toBe('container2')
    expect(validateApp(d).diagnostics.filter((x) => x.code === 'invalid_parent')).toEqual([])
  })

  it('follows event handlers between pasted components, and duplicates in place', () => {
    const withHandler = def(
      app({
        components: [
          comp('modal1', 'modal'),
          comp(
            'open',
            'button',
            {},
            {
              events: [
                {
                  id: 'h1',
                  event: 'click',
                  action: { type: 'controlComponent', component: 'modal1', method: 'open' },
                },
              ],
            },
          ),
        ],
        layout: { open: at(0, 0, 3, 1) },
      }),
    )
    const result = pasteComponents(withHandler, copyComponents(withHandler, ['modal1', 'open'])!, {
      page: null,
    })
    expect(result.added).toEqual(['modal2', 'open1'])
    const open1 = result.definition.components.find((c) => c.name === 'open1')!
    expect(open1.events![0]!.action).toEqual({
      type: 'controlComponent',
      component: 'modal2',
      method: 'open',
    })
    expect(result.definition.layout!.open1).toEqual(at(0, 1, 3, 1))
  })
})

describe('copyCode and pasteCode', () => {
  const withCode = def(
    app({
      pages: [{ name: 'home' }, { name: 'detail' }],
      queries: [
        sqlQuery('orders', 'select 1', 'auto', { page: 'home' }),
        { name: 'save', kind: 'js', code: 'return orders.data', runOnLoad: false },
        sqlQuery('report', 'select 2', 'manual', { runOnLoad: true }),
      ],
      transformers: [{ name: 'total', code: 'return orders.data.length' }],
      variables: [{ name: 'count' }],
    }),
  )

  it('renames, moves page-scoped items to the page being edited, and says which queries run by themselves', () => {
    const clip = copyCode(withCode, ['orders', 'save', 'report', 'total', 'count'])!
    expect(codeClipSchema.safeParse(JSON.parse(JSON.stringify(clip))).success).toBe(true)
    const result = pasteCode(withCode, clip, 'detail')
    expect(result.added).toEqual(['orders1', 'save1', 'report1', 'total1', 'count1'])
    const q = result.definition.queries
    expect(q.find((x) => x.name === 'orders1')).toMatchObject({ page: 'detail' })
    expect(q.find((x) => x.name === 'save1')).toMatchObject({ code: 'return orders1.data' })
    expect(q.find((x) => x.name === 'save1')!.page).toBeUndefined()
    expect(result.definition.transformers!.at(-1)).toEqual({
      name: 'total1',
      code: 'return orders1.data.length',
    })
    expect(result.runsByItself).toEqual(['orders1', 'report1'])
    expect(result.outside).toEqual([])
  })

  it('cuts a long name short for its fresh one, and lists code that doesn’t parse', () => {
    const long = `a${'b'.repeat(63)}`
    const d = def(
      app({
        queries: [
          { name: long, kind: 'js', code: 'return 1' },
          { name: 'broken', kind: 'js', code: `return ${long}.data +` },
        ],
      }),
    )
    const result = pasteCode(d, copyCode(d, [long, 'broken'])!, null)
    expect(result.added).toEqual([`a${'b'.repeat(62)}1`, 'broken1'])
    expect(result.unparsed).toEqual(['broken1'])
    // Only the broken code (the original and its copy) is wrong: the fresh name is valid.
    const errors = validateApp(result.definition).diagnostics.filter((x) => x.severity === 'error')
    expect(errors.map((x) => [x.entity, x.code])).toEqual([
      ['broken', 'syntax'],
      ['broken1', 'syntax'],
    ])
  })

  it('rejects clipboard text that isn’t app content', () => {
    expect(
      codeClipSchema.safeParse({ ow: 'app-code', v: 1, queries: [], transformers: [], variables: [] })
        .success,
    ).toBe(false)
    expect(
      componentClipSchema.safeParse({ ow: 'app-components', v: 1, components: [], layout: {} }).success,
    ).toBe(false)
    expect(
      componentClipSchema.safeParse({
        ow: 'app-components',
        v: 1,
        components: [{ name: 'x', type: 'text', sneaky: true }],
        layout: {},
      }).success,
    ).toBe(false)
  })
})

/** A seeded random generator (mulberry32), so failures repeat. */
function random(seed: number) {
  let a = seed
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { int: (n: number) => Math.floor(next() * n) }
}

/** Containers holding texts and inputs that read each other, named so pasting into a copy collides. */
function randomApp(r: ReturnType<typeof random>): AppDefinition {
  const components: AppComponent[] = []
  const layout: Record<string, ReturnType<typeof at>> = {}
  const count = 2 + r.int(8)
  for (let i = 0; i < count; i++) {
    const type = ['container', 'text', 'textInput'][r.int(3)]!
    const name = `${type}${r.int(3) + 1}${i ? `_${i}` : ''}`
    const containers = components.filter((c) => c.type === 'container').map((c) => c.name)
    const parent = containers.length && r.int(2) ? containers[r.int(containers.length)] : undefined
    const readable = components.filter((c) => c.type !== 'container').map((c) => c.name)
    const props =
      type === 'text' && readable.length && r.int(2)
        ? { value: `{{ ${readable[r.int(readable.length)]}.value }}` }
        : {}
    components.push(comp(name, type, props, parent ? { parent } : {}) as AppComponent)
    layout[name] = at(r.int(6), r.int(10))
  }
  return def(app({ components, layout }))
}

describe('pasteComponents, on random apps', () => {
  it('keeps the app as it was, and the pasted components nested and wired as they were copied', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      const source = randomApp(r)
      const target = r.int(2) ? source : randomApp(r)
      const picked = source.components.filter(() => r.int(3) === 0).map((c) => c.name)
      const clip = copyComponents(source, picked)
      if (!clip) continue
      const result = pasteComponents(target, clip, { page: null })
      const mapped = (n: string) => result.renamed[n] ?? n
      const d = result.definition

      expect(d.components.slice(0, target.components.length)).toEqual(target.components)
      const there = new Set(target.components.map((c) => c.name))
      expect(result.added.every((n) => !there.has(n))).toBe(true)
      expect(new Set(result.added).size).toBe(result.added.length)
      const copied = new Set(clip.components.map((c) => c.name))
      for (const original of clip.components) {
        const pasted = d.components.find((c) => c.name === mapped(original.name))!
        // Nesting among the pasted is kept; roots land at the top.
        expect(pasted.parent).toBe(
          original.parent && copied.has(original.parent) ? mapped(original.parent) : undefined,
        )
        const value = original.props?.value
        if (typeof value === 'string') {
          const refs = (src: string) => fieldRefs({ kind: 'template', source: src }).refs.map((x) => x.name)
          expect(refs(pasted.props!.value as string)).toEqual(
            refs(value).map((n) => (copied.has(n) ? mapped(n) : n)),
          )
        }
      }
      expect(
        validateApp(d).diagnostics.filter((x) => x.code === 'duplicate_name'),
        `seed ${seed}`,
      ).toEqual([])
      expect(appFields(d).length).toBeGreaterThanOrEqual(appFields(target).length)
    }
  })
})
