import { describe, expect, it } from 'vitest'
import {
  type AppDefinition,
  AppModel,
  addModuleInstance,
  addModuleItem,
  buildAppGraph,
  emptyModule,
  MAX_MODULE_DEPTH,
  type ModuleInfo,
  moduleNesting,
  removeModuleItem,
  renameAppEntity,
  renameModuleInputReads,
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

/** A resource query's SQL, by its index. */
const sqlOf = (def: AppDefinition, i: number) => (def.queries[i] as { query?: { sql?: unknown } }).query?.sql

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
    locked: { liveVersion: null, versions: {}, noUse: true },
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
        comp('e', 'module', { module: 'locked' }),
      ],
    })
    expect(codes(bad, { resolveModule })).toEqual([
      ['unknown_module', 'components.0.props.module', 'error'],
      ['unpublished_module', 'components.1.props.version', 'error'],
      ['unknown_version', 'components.2.props.version', 'error'],
      ['unknown_module', 'components.3.props.module', 'error'],
      ['no_use_access', 'components.4.props.module', 'error'],
      ['unknown_identifier', 'components.3.props.module', 'error'],
    ])
  })
})

describe('modules inside modules (M21)', () => {
  const iface = { inputs: [], outputs: [], events: [] }
  const nested = (depth: number, reaches: string[]) => ({ depth, reaches })
  const modules: Record<string, ModuleInfo> = {
    leaf: { liveVersion: '1.0.0', versions: { '1.0.0': iface }, nesting: { '1.0.0': nested(1, []) } },
    middle: {
      liveVersion: '2.0.0',
      versions: { '1.0.0': iface, '2.0.0': iface },
      nesting: { '1.0.0': nested(1, []), '2.0.0': nested(2, ['leaf']) },
    },
    top: {
      liveVersion: '1.0.0',
      versions: { '1.0.0': iface },
      nesting: { '1.0.0': nested(3, ['leaf', 'middle']) },
    },
    // Holds `outer`, the module checked below, through `middle`-like nesting.
    loop: { liveVersion: '1.0.0', versions: { '1.0.0': iface }, nesting: { '1.0.0': nested(2, ['outer']) } },
  }
  const resolveModule = (slug: string) => modules[slug]
  const holding = (...instances: [string, string?][]) =>
    app({
      components: instances.map(([module, version], i) =>
        comp(`m${i}`, 'module', { module, ...(version && { version }) }),
      ),
    })
  const inModule = (def: AppDefinition): AppDefinition => ({
    ...def,
    module: { inputs: [], outputs: [], events: [] },
  })

  it('lets an app hold modules three deep, and a module one less', () => {
    expect(MAX_MODULE_DEPTH).toBe(3)
    expect(codes(holding(['top'], ['middle']), { resolveModule })).toEqual([])
    expect(codes(inModule(holding(['middle'], ['leaf'])), { resolveModule, self: 'outer' })).toEqual([])
    expect(codes(inModule(holding(['top'])), { resolveModule, self: 'outer' })).toEqual([
      ['module_depth', 'components.0.props.module', 'error'],
    ])
    // A pinned release nests as that release does.
    expect(codes(inModule(holding(['middle', '1.0.0'])), { resolveModule, self: 'outer' })).toEqual([])
  })

  it('refuses a module holding itself, directly or through others', () => {
    expect(codes(inModule(holding(['outer'])), { self: 'outer' })).toEqual([
      ['module_cycle', 'components.0.props.module', 'error'],
    ])
    const loop = validateApp(inModule(holding(['loop'])), { resolveModule, self: 'outer' }).diagnostics
    expect(loop.map((d) => d.code)).toEqual(['module_cycle'])
    expect(loop[0]!.message).toBe(
      'Module "loop" holds this module (directly or through others): a module can’t hold itself',
    )
  })

  it('computes how a definition nests from what its instances run', () => {
    const lookup = (slug: string, version: string) => {
      const info = modules[slug]
      const at = version === 'latest' ? info?.liveVersion : version
      return at ? info?.nesting?.[at] : undefined
    }
    expect(moduleNesting(holding(), lookup)).toEqual({ depth: 1, reaches: [] })
    expect(moduleNesting(holding(['middle'], ['leaf']), lookup)).toEqual({
      depth: 3,
      reaches: ['leaf', 'middle'],
    })
    expect(moduleNesting(holding(['middle', '1.0.0']), lookup)).toEqual({ depth: 2, reaches: ['middle'] })
    expect(moduleNesting(holding(['unknown']), lookup)).toEqual({ depth: 2, reaches: ['unknown'] })
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

    // An input renamed (M21): the module's reads of it follow.
    const input = updateModuleItem(picker(), 'inputs', 'region', { name: 'area', testValue: 'EU' })
    expect(input.module!.inputs[1]).toEqual({ name: 'area', testValue: 'EU' })
    expect(sqlOf(input, 0)).toBe('select * from customers where region = {{ inputs.area }}')
    expect(codes(input)).toEqual([])

    expect(removeModuleItem(picker(), 'outputs', 'selectedId').module!.outputs).toEqual([])
  })
})

describe('renaming a module input (M21)', () => {
  it('rewrites inputs.<old> wherever the module reads it, and nothing else', () => {
    const def = picker({
      queries: [
        sqlQuery(
          'customers',
          'select * from c where region = {{ inputs.region }} and x = {{ other.region }}',
        ),
        {
          name: 'compute',
          kind: 'js',
          code: [
            'const a = inputs.region + inputs["region"] + inputs.label',
            'const f = (inputs) => inputs.region',
            'return a + f({})',
          ].join('\n'),
        },
      ] as AppDefinition['queries'],
    })
    def.module!.outputs[0]!.value = '{{ inputs?.region ?? null }}'
    const renamed = renameModuleInputReads(def, 'region', 'area')
    expect(sqlOf(renamed.definition, 0)).toBe(
      'select * from c where region = {{ inputs.area }} and x = {{ other.region }}',
    )
    // A parameter named inputs is the function's own: its reads stay.
    expect((renamed.definition.queries[1] as { code: string }).code).toBe(
      [
        'const a = inputs.area + inputs["area"] + inputs.label',
        'const f = (inputs) => inputs.region',
        'return a + f({})',
      ].join('\n'),
    )
    expect(renamed.definition.module!.outputs[0]!.value).toBe('{{ inputs?.area ?? null }}')
    expect(renamed.changed).toHaveLength(3)
  })

  it('leaves a field it can’t read alone, and says so', () => {
    const def = picker()
    def.components[1]!.props!.value = '{{ inputs.region +'
    const renamed = renameModuleInputReads(def, 'region', 'area')
    expect(renamed.skipped).toEqual([['components', 1, 'props', 'value']])
    expect(renamed.definition.components[1]!.props!.value).toBe('{{ inputs.region +')
  })

  it('leaves the reads alone when the new name is another input’s, or two share the old one (review fix)', () => {
    const def = picker()
    // `label` and `region`: renaming region to label would merge their reads.
    const merged = updateModuleItem(def, 'inputs', 'region', { name: 'label' })
    expect(sqlOf(merged, 0)).toBe('select * from customers where region = {{ inputs.region }}')
    // Two inputs now named label: renaming one back changes only the first, and no reads.
    const back = updateModuleItem(merged, 'inputs', 'label', { name: 'other' })
    expect(back.module!.inputs.map((i) => i.name)).toEqual(['other', 'label'])
    expect(back.components[1]!.props!.value).toBe('{{ inputs.label }}')
  })

  it('waits for a valid name', () => {
    expect(renameModuleInputReads(picker(), 'region', 'not valid').changed).toEqual([])
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
