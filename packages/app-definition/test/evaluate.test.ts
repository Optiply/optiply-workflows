import { describe, expect, it, vi } from 'vitest'
import { AppModel, sameValue } from '../src'
import { app, comp, sqlQuery } from './helpers'

const model = (def: Parameters<typeof app>[0], options = {}) => {
  const m = new AppModel(app(def), options)
  m.init()
  return m
}

describe('AppModel', () => {
  it('evaluates props: defaults, constants, templates and coercion', () => {
    const m = model({
      components: [
        comp('n', 'numberInput', {
          label: 'Qty {{ 1 + 1 }}',
          defaultValue: '{{ "5" }}',
          min: '3',
          hidden: 'false',
        }),
        comp('t', 'table', { data: [{ id: 1, name: '{{ n.label }}' }] }),
      ],
    })
    expect(m.get('n.label')).toBe('Qty 2')
    expect(m.get('n.defaultValue')).toBe(5)
    expect(m.get('n.min')).toBe(3)
    expect(m.get('n.hidden')).toBe(false)
    expect(m.get('n.step')).toBe(1)
    expect(m.get('n.placeholder')).toBe('')
    expect(m.get('n.value')).toBe(5)
    expect(m.get('t.data')).toEqual([{ id: 1, name: 'Qty 2' }])
    expect(m.get('t.rowSelection')).toBe('single')
    expect(m.view('n')).toMatchObject({ label: 'Qty 2', value: 5 })
  })

  it('keeps errors per node and falls back to the default', () => {
    const m = model({
      components: [
        comp('a', 'text', { value: '{{ missing.x }}', align: '{{ "middle" }}' }),
        comp('b', 'text', { value: '{{ a.value }}!' }),
        comp('c', 'table', { data: '{{ "nope" }}' }),
      ],
    })
    expect(m.get('a.value')).toBe('')
    expect(m.error('a.value')).toMatch(/missing is not defined/)
    expect(m.get('a.align')).toBe('left')
    expect(m.error('a.align')).toBe('Expected one of left, center, right')
    expect(m.get('b.value')).toBe('!')
    expect(m.error('c.data')).toBe('Expected an array')
    expect([...m.allErrors().keys()]).toEqual(['a.value', 'a.align', 'c.data'])
  })

  it('flows query results into tables, transformers and text, stopping where nothing changed', () => {
    const m = model({
      components: [
        comp('t', 'table', { data: '{{ rows.value }}' }),
        comp('count', 'text', { value: '{{ t.data.length }} rows' }),
      ],
      queries: [
        sqlQuery('q', 'select 1'),
        sqlQuery('details', 'select * from d where id = any({{ rows.value }})'),
      ],
      transformers: [{ name: 'rows', code: 'return (q.data ?? []).filter(r => r.active)' }],
    })
    expect(m.get('count.value')).toBe('0 rows')
    let changed = m.set({
      'q.data': [
        { id: 1, active: true },
        { id: 2, active: false },
      ],
    })
    expect(changed).toEqual(new Set(['q.data', 'rows.value', 'details.$deps', 't.data', 'count.value']))
    expect(m.get('count.value')).toBe('1 rows')
    // A new result filtering to the same rows stops at the transformer: `details` doesn't run again.
    changed = m.set({
      'q.data': [
        { id: 1, active: true },
        { id: 3, active: false },
      ],
    })
    expect([...changed]).toEqual(['q.data'])
    // Setting the same value changes nothing.
    expect([
      ...m.set({
        'q.data': [
          { id: 1, active: true },
          { id: 3, active: false },
        ],
      }),
    ]).toEqual([])
  })

  it('restarts input state from its default only when the default changes', () => {
    const m = model({
      components: [
        comp('pick', 'select', { options: [1, 2], defaultValue: '{{ t.selectedRow?.id ?? null }}' }),
        comp('t', 'table'),
        comp('name', 'textInput', { defaultValue: 'x' }),
      ],
    })
    expect(m.get('pick.value')).toBe(null)
    m.set({ 'pick.value': 2, 'name.value': 'typed' })
    expect(m.get('pick.value')).toBe(2)
    m.set({ 't.selectedRow': { id: 7 } })
    expect(m.get('pick.value')).toBe(7)
    m.set({ 't.selectedRow': { id: 7 } })
    expect(m.get('name.value')).toBe('typed')
  })

  it("derives a form's data from its inputs", () => {
    const m = model({
      components: [
        comp('f', 'form'),
        comp('first', 'textInput', { defaultValue: 'Ada', formDataKey: 'first_name' }, { parent: 'f' }),
        comp('agree', 'checkbox', {}, { parent: 'f' }),
      ],
    })
    expect(m.get('f.data')).toEqual({ first_name: 'Ada', agree: false })
    const changed = m.set({ 'agree.value': true })
    expect(changed.has('f.data')).toBe(true)
    expect(m.get('f.data')).toEqual({ first_name: 'Ada', agree: true })
  })

  it('evaluates variables once, then holds what is set', () => {
    const m = model({
      components: [comp('t', 'text', { value: 'start' }), comp('u', 'text', { value: '{{ v.value.n }}' })],
      variables: [{ name: 'v', initialValue: { n: '{{ t.value.length }}' } }, { name: 'empty' }],
    })
    expect(m.get('v.value')).toEqual({ n: 5 })
    expect(m.get('empty.value')).toBe(null)
    m.set({ 'v.value': { n: 9 } })
    expect(m.get('u.value')).toBe('9')
  })

  it('reports an automatic query when what it reads changes', () => {
    const m = model({
      components: [comp('search', 'textInput'), comp('other', 'textInput')],
      queries: [
        sqlQuery('auto', 'select {{ search.value }}'),
        sqlQuery('manual', 'select {{ search.value }}', 'manual'),
      ],
    })
    expect(m.get('auto.$deps')).toBe(0)
    expect(m.set({ 'search.value': 'a' }).has('auto.$deps')).toBe(true)
    expect(m.get('auto.$deps')).toBe(1)
    expect(m.set({ 'other.value': 'a' }).has('auto.$deps')).toBe(false)
  })

  it('marks nodes on a loop and keeps the rest working', () => {
    const m = model({
      components: [
        comp('a', 'text', { value: '{{ b.value }}' }),
        comp('b', 'text', { value: '{{ a.value }}' }),
        comp('c', 'text', { value: 'fine' }),
      ],
    })
    expect(m.error('a.value')).toBe('Circular dependency: a.value → b.value → a.value')
    expect(m.get('c.value')).toBe('fine')
  })

  it('overrides props set at run time, keeping them when their inputs change', () => {
    const m = model({
      components: [
        comp('a', 'text', { hidden: '{{ v.value }}' }),
        comp('b', 'text', { value: '{{ a.hidden }}' }),
      ],
      variables: [{ name: 'v', initialValue: '{{ false }}' }],
      transformers: [{ name: 't', code: 'return 1' }],
    })
    expect(m.set({ 'a.hidden': true })).toEqual(new Set(['a.hidden', 'b.value']))
    expect(m.get('b.value')).toBe('true')
    m.set({ 'v.value': false })
    expect(m.get('a.hidden')).toBe(true)
    expect(m.evaluateExpression('a.hidden && t.value')).toBe(1)
    expect(() => m.set({ 't.value': 2 })).toThrow("t.value can't be set")
  })

  it('refuses to set computed values', () => {
    const m = model({ components: [comp('a', 'text')], transformers: [{ name: 't', code: 'return 1' }] })
    expect(() => m.set({ 't.value': 'x' })).toThrow("t.value can't be set")
    expect(() => m.set({ 'a.nope': 'x' })).toThrow('No value named a.nope')
  })

  it('evaluates on demand with locals, globals and runtime methods', async () => {
    const trigger = vi.fn(async () => 'ran')
    const m = model(
      {
        components: [comp('name', 'textInput', { defaultValue: 'Ada' })],
        queries: [sqlQuery('q', 'select 1', 'manual')],
      },
      {
        globals: { current_user: { email: 'a@optiply.nl' } },
        methods: (e: { kind: string }) => (e.kind === 'query' ? { trigger } : undefined),
      },
    )
    expect(m.evaluateValue({ to: '{{ current_user.email }}', who: ['{{ name.value }}', 3] })).toEqual({
      to: 'a@optiply.nl',
      who: ['Ada', 3],
    })
    expect(m.evaluateTemplate('{{ row.id * 2 }}', { row: { id: 21 } })).toBe(42)
    expect(m.runFunctionBody('return data.length', { data: [1, 2] })).toBe(2)
    await expect(m.runScript('return await q.trigger()')).resolves.toBe('ran')
    expect(trigger).toHaveBeenCalledOnce()
    await expect(m.runScript('return (')).rejects.toThrow(/Syntax error/)
    expect(() => m.evaluateTemplate('{{ Promise.resolve(1) }}')).toThrow(/can’t await/)
    expect(() => m.evaluateTemplate('{{ 1 + }}')).toThrow(/Syntax error/)
  })

  it('compares plain data by value', () => {
    expect(sameValue({ a: [1] }, { a: [1] })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true)
    expect(sameValue(null, {})).toBe(false)
  })
})
