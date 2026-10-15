import { describe, expect, it } from 'vitest'
import {
  addComponent,
  addQuery,
  addTransformer,
  addVariable,
  moveToParent,
  nextName,
  removeCode,
  removeComponent,
  setHandlers,
  setPositions,
  setProp,
  validateApp,
} from '../src'
import { app, comp } from './helpers'

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
