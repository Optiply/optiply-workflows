import { describe, expect, it } from 'vitest'
import {
  type AppDefinition,
  AppModel,
  addModuleInstance,
  addModuleItem,
  buildAppGraph,
  emptyModule,
  type ModuleInfo,
  removeModuleItem,
  renameAppEntity,
  updateModuleItem,
  validateApp,
} from '../src'
import { app, comp, sqlQuery } from './helpers'

/** A customer picker: a table of customers, the picked id as an output, `picked` fired on a button. */
const picker = (extra: Partial<AppDefinition> = {}): AppDefinition => ({
  ...app({
    components: [
      comp('table1', 'table', { data: '{{ customers.data }}' }),
      comp('heading', 'text', { value: '{{ inputs.label }}' }),
      comp(
        'pick',
        'button',
        { text: 'Pick' },
        {
          events: [{ id: 'a', event: 'click', action: { type: 'moduleEvent', event: 'picked' } }],
        },
      ),
    ],
    queries: [sqlQuery('customers', 'select * from customers where region = {{ inputs.region }}')],
  }),
  module: {
    inputs: [{ name: 'label', default: 'Customers' }, { name: 'region' }],
    outputs: [{ name: 'selectedId', value: '{{ table1.selectedRow?.id ?? null }}' }],
    events: [{ name: 'picked' }],
  },
  ...extra,
})

const codes = (def: unknown, options = {}) =>
  validateApp(def, options).diagnostics.map((d) => [d.code, d.path.join('.'), d.severity])

describe('module definitions', () => {
  it('accepts a module reading its inputs, with outputs and an event', () => {
    expect(codes(picker())).toEqual([])
    expect(validateApp(emptyModule()).ok).toBe(true)
  })

  it('applies the module rules', () => {
    const def = picker({ pages: [{ name: 'home' }] })
    def.components.push(comp('inputs', 'text'), comp('nested', 'module', { module: 'other' }))
    def.module!.inputs.push({ name: 'version' }, { name: 'selectedId' })
    def.module!.outputs.push({ name: 'hidden', value: '{{ true }}' })
    def.module!.events.push({ name: 'picked' })
    def.components[2]!.events!.push({
      id: 'b',
      event: 'click',
      action: { type: 'moduleEvent', event: 'nope' },
    })
    def.components[1]!.props!.value = '{{ inputs.nope }}'
    expect(codes(def)).toEqual([
      ['unknown_event', 'components.2.events.1.action.event', 'error'],
      ['nested_module', 'components.4.type', 'error'],
      ['module_pages', 'pages', 'error'],
      ['invalid_name', 'components.3.name', 'error'],
      ['invalid_name', 'module.inputs.2.name', 'error'],
      ['duplicate_name', 'module.outputs.0.name', 'error'],
      // An output can't take an instance prop's name either: it would replace the prop.
      ['invalid_name', 'module.outputs.1.name', 'error'],
      ['duplicate_name', 'module.events.1.name', 'error'],
      ['unknown_property', 'components.1.props.value', 'warning'],
      // The text component named `inputs` takes the name from the built-in.
      ['unknown_property', 'queries.0.query.sql', 'warning'],
    ])
  })

  it('refuses module events outside a module, and inputs in an app', () => {
    const def = app({
      components: [
        comp(
          'b',
          'button',
          { text: '{{ inputs.x }}' },
          {
            events: [{ id: 'a', event: 'click', action: { type: 'moduleEvent', event: 'picked' } }],
          },
        ),
      ],
    })
    expect(codes(def)).toEqual([
      ['not_in_module', 'components.0.events.0.action.event', 'error'],
      ['unknown_identifier', 'components.0.props.text', 'error'],
    ])
  })

  it('computes outputs from the module’s values, and inputs from what the app passes', () => {
    const def = picker()
    const graph = buildAppGraph(def)
    expect(graph.nodes.get('$outputs.selectedId')?.deps).toEqual(['table1.selectedRow'])
    expect([...graph.nodes.keys()].filter((k) => k.startsWith('inputs.'))).toEqual([
      'inputs.label',
      'inputs.region',
    ])
    const model = new AppModel(def, { inputs: { region: 'EU' } })
    model.init()
    expect(model.get('inputs.label')).toBe('Customers')
    expect(model.get('inputs.region')).toBe('EU')
    expect(model.get('heading.value')).toBe('Customers')
    expect(model.get('$outputs.selectedId')).toBeNull()
    model.set({ 'table1.selectedRow': { id: 7 } })
    expect(model.get('$outputs.selectedId')).toBe(7)
  })

  it('rewrites outputs on rename', () => {
    const renamed = renameAppEntity(picker(), 'table1', 'grid')
    expect(renamed.ok && renamed.definition.module?.outputs[0]?.value).toBe(
      '{{ grid.selectedRow?.id ?? null }}',
    )
  })
})

describe('module instances in apps', () => {
  const modules: Record<string, ModuleInfo> = {
    customer_picker: {
      liveVersion: '1.1.0',
      versions: {
        '1.0.0': { inputs: ['label'], outputs: ['selectedId'], events: [] },
        '1.1.0': { inputs: ['label', 'region'], outputs: ['selectedId'], events: ['picked'] },
      },
    },
    draft_only: { liveVersion: null, versions: {} },
  }
  const resolveModule = (slug: string) => modules[slug]
  const instance = (props: Record<string, unknown>, extra: object = {}) =>
    comp('picker1', 'module', { module: 'customer_picker', ...props }, extra)
  const using = (...components: ReturnType<typeof comp>[]) =>
    app({ components: [...components, comp('t', 'text', { value: '{{ picker1.selectedId }}' })] })

  it('takes any props and events until the module is known', () => {
    const def = using(
      instance(
        { label: 'Pick one', whatever: 1 },
        { events: [{ id: 'a', event: 'anything', action: { type: 'notify', message: 'x' } }] },
      ),
    )
    expect(codes(def)).toEqual([])
  })

  it('checks props, outputs and events against the release', () => {
    const handler = (event: string) => ({ id: event, event, action: { type: 'notify', message: 'x' } })
    expect(
      codes(using(instance({ label: 'x', region: 'EU' }, { events: [handler('picked')] })), {
        resolveModule,
      }),
    ).toEqual([])
    expect(
      codes(using(instance({ version: '1.0.0', region: 'EU' }, { events: [handler('picked')] })), {
        resolveModule,
      }),
    ).toEqual([
      ['unknown_prop', 'components.0.props.region', 'error'],
      ['unknown_event', 'components.0.events.0.event', 'error'],
    ])
    const reads = app({ components: [instance({}), comp('t', 'text', { value: '{{ picker1.nope }}' })] })
    expect(codes(reads, { resolveModule })).toEqual([
      ['unknown_property', 'components.1.props.value', 'warning'],
    ])
  })

  it('names a module and release that exist, by slug', () => {
    const bad = app({
      components: [
        comp('a', 'module', { module: 'nope' }),
        comp('b', 'module', { module: 'draft_only' }),
        comp('c', 'module', { module: 'customer_picker', version: '9.9.9' }),
        comp('d', 'module', { module: '{{ x }}' }),
      ],
    })
    expect(codes(bad, { resolveModule })).toEqual([
      ['unknown_module', 'components.0.props.module', 'error'],
      ['unpublished_module', 'components.1.props.version', 'error'],
      ['unknown_version', 'components.2.props.version', 'error'],
      ['unknown_module', 'components.3.props.module', 'error'],
      ['unknown_identifier', 'components.3.props.module', 'error'],
    ])
  })
})

describe('editing a module’s interface', () => {
  it('adds items with free names, renames events with the actions firing them, removes items', () => {
    const added = addModuleItem(picker(), 'events')
    expect(added.name).toBe('event1')
    expect(addModuleItem(added.definition, 'events').name).toBe('event2')
    expect(addModuleItem(picker(), 'outputs').definition.module!.outputs[1]).toEqual({
      name: 'output1',
      value: '',
    })

    const renamed = updateModuleItem(picker(), 'events', 'picked', { name: 'chosen' })
    expect(renamed.module!.events).toEqual([{ name: 'chosen' }])
    expect(renamed.components[2]!.events![0]!.action).toEqual({ type: 'moduleEvent', event: 'chosen' })
    expect(codes(renamed)).toEqual([])

    // An input renamed: code still reading the old name is a problem to fix.
    const input = updateModuleItem(picker(), 'inputs', 'region', { name: 'area', testValue: 'EU' })
    expect(input.module!.inputs[1]).toEqual({ name: 'area', testValue: 'EU' })
    expect(codes(input).map(([code]) => code)).toContain('unknown_property')

    expect(removeModuleItem(picker(), 'outputs', 'selectedId').module!.outputs).toEqual([])
  })
})

describe('placing a module', () => {
  it('adds an instance named after the module, at the module size, following the latest release', () => {
    const placed = addModuleInstance(app({ components: [comp('title', 'text')] }), 'customer-picker')
    expect(placed.name).toBe('customer_picker1')
    expect(placed.definition.components[1]).toEqual({
      name: 'customer_picker1',
      type: 'module',
      props: { module: 'customer-picker' },
    })
    expect(placed.definition.layout?.customer_picker1).toMatchObject({ w: 6, h: 12 })
    expect(addModuleInstance(placed.definition, 'customer-picker').name).toBe('customer_picker2')
  })

  it('keeps instance names within 64 characters for a long slug', () => {
    const slug = 'a'.repeat(63)
    let def = app({ components: [] })
    const names: string[] = []
    for (let i = 0; i < 10; i++) {
      const placed = addModuleInstance(def, slug)
      def = placed.definition
      names.push(placed.name)
    }
    expect(names.every((n) => n.length <= 64)).toBe(true)
    expect(names[9]).toBe(`${'a'.repeat(62)}10`)
    expect(new Set(names).size).toBe(10)
  })
})
