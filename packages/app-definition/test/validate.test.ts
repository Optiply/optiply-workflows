import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type AppDiagnostic, browserExpressions, expressionSide, validateApp } from '../src'
import { app, comp, sqlQuery } from './helpers'

const codes = (input: unknown, options = {}) =>
  validateApp(input, options).diagnostics.map((d) => [d.code, d.path.join('.'), d.severity])

const only = (d: AppDiagnostic[]) => d.map((x) => x.code)

describe('validateApp', () => {
  it('accepts a CRUD app', () => {
    const def = app({
      components: [
        comp('table1', 'table', { data: '{{ customers.data }}', columns: [{ key: 'name', editable: true }] }),
        comp(
          'save',
          'button',
          { text: 'Save', disabled: '{{ table1.changesetArray.length === 0 }}' },
          {
            events: [
              {
                id: 'a',
                event: 'click',
                action: { type: 'controlQuery', query: 'saveRows', method: 'trigger' },
              },
            ],
          },
        ),
        comp(
          'form1',
          'form',
          { title: 'New customer' },
          {
            events: [
              {
                id: 'b',
                event: 'submit',
                action: { type: 'controlQuery', query: 'insert', method: 'trigger' },
              },
            ],
          },
        ),
        comp('nameInput', 'textInput', { label: 'Name', required: true }, { parent: 'form1' }),
      ],
      queries: [
        sqlQuery(
          'customers',
          'select * from customers where name ilike {{ "%" + (search.value ?? "") + "%" }}',
        ),
        sqlQuery('saveRows', 'select 1 where {{ table1.changesetArray }} is not null', 'manual', {
          events: [
            {
              id: 'c',
              event: 'success',
              action: { type: 'controlQuery', query: 'customers', method: 'trigger' },
            },
          ],
        }),
        sqlQuery('insert', 'insert into customers (name) values ({{ form1.data.nameInput }})', 'manual'),
      ],
      variables: [{ name: 'search', initialValue: '' }],
      layout: { table1: { x: 0, y: 0, w: 12, h: 20 } },
    })
    // `search` is a variable: `search.value` is fine.
    expect(validateApp(def).diagnostics).toEqual([])
    expect(validateApp(def).ok).toBe(true)
  })

  it('reports schema problems alone, naming the entity', () => {
    const result = validateApp({
      ...app({ components: [comp('t', 'text')] }),
      layout: { t: { x: 10, y: 0, w: 4, h: 1 } },
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([['schema', 'layout.t']])
    const bad = validateApp({
      schemaVersion: 1,
      components: [{ name: 'x', type: 'text', extra: 1 }],
      queries: [],
    })
    expect(bad.diagnostics[0]).toMatchObject({ code: 'schema', entity: 'x' })
    expect(validateApp(null).ok).toBe(false)
  })

  it('checks names across every kind of entity', () => {
    const def = app({
      components: [comp('utils', 'text'), comp('dup', 'text'), comp('class', 'text')],
      queries: [sqlQuery('dup', 'select 1')],
      transformers: [{ name: '_', code: 'return 1' }],
    })
    expect(codes(def)).toEqual([
      ['invalid_name', 'components.0.name', 'error'],
      ['invalid_name', 'components.2.name', 'error'],
      ['duplicate_name', 'queries.0.name', 'error'],
      ['invalid_name', 'transformers.0.name', 'error'],
    ])
  })

  it('checks component types and props', () => {
    const def = app({
      components: [
        comp('a', 'slider'),
        comp('b', 'text', { value: 'hi', colour: 'red', align: 'middle' }),
        comp('c', 'table', { data: 5, rowSelection: '{{ "x" }}' }),
        comp('d', 'numberInput', { defaultValue: 3, min: null, hidden: true }),
      ],
    })
    expect(codes(def)).toEqual([
      ['unknown_type', 'components.0.type', 'error'],
      ['unknown_prop', 'components.1.props.colour', 'error'],
      ['invalid_prop', 'components.1.props.align', 'error'],
      ['invalid_prop', 'components.2.props.data', 'error'],
    ])
  })

  it('checks parents', () => {
    const def = app({
      components: [
        comp('box', 'container'),
        comp('a', 'text', {}, { parent: 'nowhere' }),
        comp('b', 'text', {}, { parent: 'a' }),
        comp('m', 'modal', {}, { parent: 'box' }),
        comp('loop1', 'container', {}, { parent: 'loop2' }),
        comp('loop2', 'container', {}, { parent: 'loop1' }),
        comp('ok', 'text', {}, { parent: 'm' }),
      ],
    })
    expect(codes(def)).toEqual([
      ['unknown_parent', 'components.1.parent', 'error'],
      ['invalid_parent', 'components.2.parent', 'error'],
      ['invalid_parent', 'components.3.parent', 'error'],
      ['invalid_parent', 'components.4.parent', 'error'],
      ['invalid_parent', 'components.5.parent', 'error'],
    ])
  })

  it('warns about layout entries without a place on the grid', () => {
    const def = app({
      components: [comp('m', 'modal')],
      layout: { m: { x: 0, y: 0, w: 1, h: 1 }, gone: { x: 0, y: 0, w: 1, h: 1 } },
    })
    const result = validateApp(def)
    expect(result.ok).toBe(true)
    expect(codes(def)).toEqual([
      ['invalid_layout', 'layout.m', 'warning'],
      ['invalid_layout', 'layout.gone', 'warning'],
    ])
  })

  it('checks event handlers', () => {
    const handler = (id: string, event: string, action: object) => ({ id, event, action })
    const def = app({
      components: [
        comp(
          'btn',
          'button',
          {},
          {
            events: [
              handler('a', 'hover', { type: 'notify', message: 'hi' }),
              handler('b', 'click', { type: 'controlQuery', query: 'btn', method: 'trigger' }),
              handler('c', 'click', { type: 'controlComponent', component: 'q', method: 'open' }),
              handler('d', 'click', { type: 'controlComponent', component: 'm', method: 'shake' }),
              handler('e', 'click', {
                type: 'controlComponent',
                component: 'm',
                method: 'open',
                args: ['1'],
              }),
              handler('f', 'click', { type: 'setVariable', variable: 'q', value: '1' }),
              handler('g', 'click', {
                type: 'controlComponent',
                component: 'm',
                method: 'setHidden',
                args: ['{{ true }}'],
              }),
            ],
          },
        ),
        comp('t', 'text', {}, { events: [handler('h', 'click', { type: 'notify', message: 'x' })] }),
        comp('m', 'modal'),
      ],
      queries: [
        sqlQuery('q', 'select 1', 'manual', {
          events: [handler('i', 'done', { type: 'notify', message: 'x' })],
        }),
      ],
    })
    expect(codes(def)).toEqual([
      ['unknown_event', 'components.0.events.0.event', 'error'],
      ['unknown_query', 'components.0.events.1.action.query', 'error'],
      ['unknown_component', 'components.0.events.2.action.component', 'error'],
      ['unknown_method', 'components.0.events.3.action.method', 'error'],
      ['invalid_args', 'components.0.events.4.action.args', 'warning'],
      ['unknown_variable', 'components.0.events.5.action.variable', 'error'],
      ['unknown_event', 'components.1.events.0.event', 'error'],
      ['unknown_event', 'queries.0.events.0.event', 'error'],
    ])
  })

  it('checks names and properties in code, with offsets', () => {
    const def = app({
      components: [
        comp('t', 'text', {
          value: 'Hi {{ who.value }} {{ tabel1 }} {{ q.dta }} {{ q.data.length }} {{ q.toString() }}',
        }),
        comp('u', 'text', { value: '{{ q.trigger() }}' }),
      ],
      queries: [
        sqlQuery('q', 'select {{ current_user.email }}, {{ _.now() }}', 'manual', {
          transform: 'return data.map(r => r.id)',
          events: [
            {
              id: 'a',
              event: 'success',
              action: { type: 'runScript', code: 'await q.trigger(); t.setHidden(true)' },
            },
          ],
        }),
      ],
      variables: [{ name: 'who', initialValue: 'you' }],
    })
    const result = validateApp(def)
    const source = def.components[0]!.props!.value as string
    expect(result.diagnostics.map((d) => [d.code, d.path.join('.'), d.severity])).toEqual([
      ['unknown_identifier', 'components.0.props.value', 'error'],
      ['unknown_property', 'components.0.props.value', 'warning'],
      ['code_only', 'components.1.props.value', 'error'],
    ])
    const [unknown, property] = result.diagnostics
    expect(source.slice(unknown!.start, unknown!.end)).toBe('tabel1')
    expect(source.slice(property!.start, property!.end)).toBe('q')
  })

  it('reports syntax errors and transformer awaits', () => {
    const def = app({
      components: [comp('t', 'text', { value: '{{ 1 + }}' })],
      transformers: [{ name: 'tr', code: 'return await 1' }],
    })
    expect(only(validateApp(def).diagnostics)).toEqual(['syntax', 'syntax'])
  })

  it('reports circular dependencies once per loop', () => {
    const def = app({
      components: [
        comp('a', 'text', { value: '{{ b.value }}' }),
        comp('b', 'text', { value: '{{ a.value }}' }),
        comp('self', 'textInput', { label: '{{ self.label }}', placeholder: '{{ self.value }}' }),
        comp('f', 'form'),
        comp('i', 'textInput', { defaultValue: '{{ f.data.i }}' }, { parent: 'f' }),
      ],
    })
    const cycles = validateApp(def).diagnostics.filter((d) => d.code === 'cycle')
    expect(cycles.map((d) => d.message)).toEqual([
      'Circular dependency: a.value → b.value → a.value',
      'Circular dependency: self.label → self.label',
      expect.stringContaining('f.data'),
    ])
    // `self.placeholder` reading `self.value` is not a loop: the value only starts from `defaultValue`.
    expect(cycles.some((d) => d.message.includes('placeholder'))).toBe(false)
  })

  it('checks resource queries against their connector when resources are known', () => {
    const connector = {
      querySchema: z.strictObject({ sql: z.string().min(1, 'Write a query') }),
      validateQuery: (q: { sql: string }) =>
        q.sql.includes("'{{") ? [Object.assign(new Error('Quoted {{ }}'), { start: 1, end: 2 })] : [],
    }
    const def = app({
      queries: [
        sqlQuery('a', 'select 1'),
        { ...sqlQuery('b', ''), resource: 'nope' },
        sqlQuery('c', ''),
        sqlQuery('d', "select '{{ 1 }}'"),
      ],
    })
    const resolveResource = (slug: string) => (slug === 'warehouse' ? (connector as never) : undefined)
    expect(codes(def, { resolveResource })).toEqual([
      ['unknown_resource', 'queries.1.resource', 'error'],
      ['invalid_query', 'queries.2.query.sql', 'error'],
      ['invalid_query', 'queries.3.query', 'error'],
    ])
  })
})

describe('query values', () => {
  it('evaluates current_user on the server and refuses mixing it with app values', () => {
    const def = app({
      components: [comp('s', 'select')],
      queries: [
        sqlQuery(
          'q',
          'select * from t where owner = {{ current_user.email.toLowerCase() }} and s = {{ s.value }} and x = {{ current_user.id + s.value }}',
        ),
      ],
    })
    const diagnostics = validateApp(def).diagnostics
    expect(diagnostics.map((d) => d.code)).toEqual(['mixed_current_user'])
    const sql = (def.queries[0] as unknown as { query: { sql: string } }).query.sql
    expect(sql.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('{{ current_user.id + s.value }}')
  })

  it('lists the expressions the browser sends', () => {
    expect(
      browserExpressions({
        sql: 'select {{ a.value }}, {{ a.value }}, {{ current_user.email }}, {{ current_user.id + a.value }}',
        headers: [{ key: 'x', value: '{{ b.value }}' }],
        broken: '{{ (',
      }),
    ).toEqual([' b.value ', ' a.value '])
    expect(expressionSide(' _.upperFirst(current_user.name) ')).toBe('server')
    expect(expressionSide('Math.max(1, x)')).toBe('browser')
  })
})
