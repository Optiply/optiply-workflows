import { describe, expect, it } from 'vitest'
import { buildAppGraph, formInputs } from '../src'
import { app, comp, sqlQuery } from './helpers'

describe('buildAppGraph', () => {
  it('depends on the property read, or the whole entity when none is', () => {
    const graph = buildAppGraph(
      app({
        components: [
          comp('t1', 'table', { data: '{{ q.data }}' }),
          comp('label', 'text', { value: '{{ t1.selectedRow?.name }} {{ JSON.stringify(t1) }}' }),
        ],
        queries: [sqlQuery('q', 'select 1')],
      }),
    )
    expect(graph.nodes.get('t1.data')!.deps).toEqual(['q.data'])
    const deps = graph.nodes.get('label.value')!.deps
    expect(deps).toContain('t1.selectedRow')
    expect(deps).toContain('t1.changesetArray')
    expect(deps).toContain('t1.hidden')
    // Internal nodes are never read by code.
    expect(graph.resolve({ name: 'q' })).not.toContain('q.$deps')
    expect(graph.resolve({ name: 'q', property: '$deps' })).toEqual([])
    expect(graph.resolve({ name: 'q', property: 'trigger' })).toEqual([])
    expect(graph.resolve({ name: 'nobody' })).toEqual([])
  })

  it('gives automatic resource queries a trigger node reading their inputs', () => {
    const graph = buildAppGraph(
      app({
        components: [comp('s', 'textInput')],
        queries: [
          sqlQuery('auto', 'select {{ s.value }}', 'auto', {
            disabled: '{{ !s.value }}',
            confirm: '{{ s.label }}',
          }),
          sqlQuery('manual', 'select {{ s.value }}', 'manual'),
        ],
      }),
    )
    expect(graph.nodes.get('auto.$deps')).toMatchObject({ kind: 'trigger', deps: ['s.value'] })
    expect(graph.nodes.has('manual.$deps')).toBe(false)
  })

  it("collects a form's inputs, through containers but not nested forms", () => {
    const def = app({
      components: [
        comp('f', 'form'),
        comp('a', 'textInput', {}, { parent: 'f' }),
        comp('box', 'container', {}, { parent: 'f' }),
        comp('b', 'checkbox', {}, { parent: 'box' }),
        comp('t', 'text', {}, { parent: 'box' }),
        comp('inner', 'form', {}, { parent: 'f' }),
        comp('c', 'numberInput', {}, { parent: 'inner' }),
      ],
    })
    expect(formInputs(def, 'f')).toEqual(['a', 'b'])
    const graph = buildAppGraph(def)
    expect(graph.nodes.get('f.data')!.deps).toEqual(['a.value', 'a.formDataKey', 'b.value', 'b.formDataKey'])
    expect(graph.nodes.get('a.value')).toMatchObject({ kind: 'state', deps: ['a.defaultValue'] })
  })

  it('orders nodes so every node comes after what it reads', () => {
    const graph = buildAppGraph(
      app({
        components: [
          comp('c', 'text', { value: '{{ b.value }}' }),
          comp('b', 'text', { value: '{{ tr.value }}' }),
        ],
        transformers: [{ name: 'tr', code: 'return v.value + 1' }],
        variables: [{ name: 'v', initialValue: '{{ 1 }}' }],
      }),
    )
    const at = (key: string) => graph.rank.get(key)!
    expect(at('v.$initial')).toBeLessThan(at('v.value'))
    expect(at('v.value')).toBeLessThan(at('tr.value'))
    expect(at('tr.value')).toBeLessThan(at('b.value'))
    expect(at('b.value')).toBeLessThan(at('c.value'))
    expect(graph.affected(['v.value'])).toEqual(['tr.value', 'b.value', 'c.value'])
  })

  it('finds loops, including long chains, without overflowing the stack', () => {
    const n = 5000
    const components = Array.from({ length: n }, (_, i) =>
      comp(`t${i}`, 'text', { value: `{{ t${(i + 1) % n}.value }}` }),
    )
    const graph = buildAppGraph(app({ components }))
    expect(graph.cycles).toHaveLength(1)
    expect(graph.cycles[0]).toHaveLength(n)
  })

  it('ignores the fields of a duplicate name', () => {
    const graph = buildAppGraph(
      app({
        components: [comp('x', 'text', { value: 'one' }), comp('x', 'text', { value: '{{ x.value }}' })],
      }),
    )
    expect(graph.nodes.get('x.value')!.deps).toEqual([])
    expect(graph.cycles).toEqual([])
  })
})
