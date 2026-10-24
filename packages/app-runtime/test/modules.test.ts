import type { AppDefinition } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { AppRuntime, type HostBridge, type ModuleReleases, type QueryModule, type StatePatch } from '../src'

const comp = (name: string, type: string, props: Record<string, unknown> = {}, extra: object = {}) =>
  ({ name, type, props, ...extra }) as AppDefinition['components'][number]
const on = (event: string, action: object) => ({ id: Math.random().toString(36).slice(2, 10), event, action })
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** A customer picker: finds customers by `inputs.search`, outputs the name typed, fires `picked`. */
const picker: AppDefinition = {
  schemaVersion: 1,
  components: [
    comp('name1', 'textInput', { defaultValue: '{{ inputs.search }}' }),
    comp('pick', 'button', {}, { events: [on('click', { type: 'moduleEvent', event: 'picked' })] }),
    comp('broken', 'text', { value: '{{ nope.x }}' }),
  ],
  queries: [
    {
      name: 'find',
      kind: 'resource',
      resource: 'db',
      query: { sql: 'select * from customers where name like {{ inputs.search }}' },
      run: 'auto',
    },
  ] as AppDefinition['queries'],
  module: {
    inputs: [{ name: 'search', default: 'A' }],
    outputs: [{ name: 'selected', value: '{{ name1.value }}' }],
    events: [{ name: 'picked' }],
  },
}

/** An app placing two pickers: the first follows `filter`, the second is fixed; `orders` reads the first's output. */
const host: AppDefinition = {
  schemaVersion: 1,
  components: [
    comp('filter', 'textInput', { defaultValue: 'Ad' }),
    comp(
      'picker1',
      'module',
      { module: 'picker', search: '{{ filter.value }}' },
      {
        events: [on('picked', { type: 'setVariable', variable: 'chosen', value: '{{ picker1.selected }}' })],
      },
    ),
    comp('picker2', 'module', { module: 'picker', version: '1.0.0', search: 'Gr' }),
    comp('missing', 'module', { module: 'gone' }),
  ],
  queries: [
    {
      name: 'orders',
      kind: 'resource',
      resource: 'db',
      query: { sql: 'select * from orders where customer = {{ picker1.selected }}' },
      run: 'auto',
    },
  ] as AppDefinition['queries'],
  variables: [{ name: 'chosen', initialValue: null }] as AppDefinition['variables'],
}

/** A shell (M21): a module holding a picker, passing its own `search` on and its picker's choice out. */
const shell: AppDefinition = {
  schemaVersion: 1,
  components: [comp('picker1', 'module', { module: 'picker', search: '{{ inputs.search }}' })],
  queries: [],
  module: {
    inputs: [{ name: 'search', default: 'Z' }],
    outputs: [{ name: 'chosen', value: '{{ picker1.selected }}' }],
    events: [],
  },
}

const modules: ModuleReleases = {
  'picker@latest': { definition: picker, releaseId: 'r-live' },
  'picker@1.0.0': { definition: picker, releaseId: 'r-1' },
  'shell@latest': { definition: shell, releaseId: 'r-shell' },
}

function setup(
  def: AppDefinition = host,
  previous?: { runtime: AppRuntime; state: Record<string, unknown> },
) {
  const calls: { query: string; values: Record<string, unknown>; module?: QueryModule }[] = []
  const logs: string[] = []
  const patches: StatePatch[] = []
  const state: Record<string, unknown> = { ...previous?.state }
  let errors: Record<string, string> = {}
  const bridge: HostBridge = {
    async runQuery(query, values, module) {
      calls.push({ query, values, ...(module && { module }) })
      return { ok: true, data: [{ query, instance: module?.map((m) => m.instance).join('/') ?? null }] }
    },
    confirm: async () => true,
    effect: () => {},
    publish: (p) => {
      patches.push(p)
      Object.assign(state, p.values)
      if (p.errors) errors = p.errors
    },
    log: (level, text) => logs.push(`${level}: ${text}`),
  }
  const runtime = new AppRuntime(def, bridge, { autoRunDelayMs: 0, modules })
  return {
    runtime,
    calls,
    logs,
    patches,
    state,
    errors: () => errors,
    started: runtime.start(previous ? { previous: previous.runtime } : {}),
  }
}

const sent = (calls: { query: string; values: Record<string, unknown>; module?: QueryModule }[]) =>
  calls.map(
    (c) =>
      `${c.module ? `${c.module.map((m) => `${m.instance}@${m.releaseId}`).join('/')}/` : ''}${c.query} ${Object.values(c.values).join()}`,
  )

describe('module instances', () => {
  it('runs each instance on its own, with its inputs, and its queries tagged with the instance and release', async () => {
    const t = setup()
    await t.started
    expect(sent(t.calls).sort()).toEqual(['orders Ad', 'picker1@r-live/find Ad', 'picker2@r-1/find Gr'])
    // The first patch holds the app's values and the instances' (prefixed); their outputs are the instance's state.
    expect(t.patches[0]!.values).toMatchObject({
      'filter.value': 'Ad',
      'picker1.selected': 'Ad',
      'picker2.selected': 'Gr',
      'picker1/name1.value': 'Ad',
      'picker2/name1.value': 'Gr',
    })
    expect(Object.keys(t.patches[0]!.values).some((k) => k.includes('$outputs'))).toBe(false)
    expect(t.state['picker1/find.data']).toEqual([{ query: 'find', instance: 'picker1' }])
    // The instance whose release the page didn't send doesn't run.
    expect(Object.keys(t.state).some((k) => k.startsWith('missing/'))).toBe(false)
  })

  it('keeps two instances apart, and passes changed inputs in', async () => {
    const t = setup()
    await t.started
    t.calls.length = 0
    t.runtime.set({ 'picker2/name1.value': 'Grace' })
    expect(t.state['picker2/name1.value']).toBe('Grace')
    expect(t.state['picker2.selected']).toBe('Grace')
    expect(t.state['picker1/name1.value']).toBe('Ad')
    expect(t.state['picker1.selected']).toBe('Ad')

    t.runtime.set({ 'filter.value': 'Bo' })
    await wait()
    // picker1's search follows filter: its find runs again; its name follows its new default; orders follows that.
    expect(sent(t.calls).sort()).toEqual(['orders Bo', 'picker1@r-live/find Bo'])
    expect(t.state['picker2/name1.value']).toBe('Grace')
  })

  it("fires the module's events on the instance, and routes calls and runs to the instance", async () => {
    const t = setup()
    await t.started
    t.runtime.set({ 'picker1/name1.value': 'Ada' })
    expect(await t.runtime.fire('picker1/pick', 'click')).toBe(true)
    expect(t.state['chosen.value']).toBe('Ada')

    await t.runtime.call('picker2/name1', 'setValue', ['Grace'])
    expect(t.state['picker2.selected']).toBe('Grace')
    t.calls.length = 0
    await t.runtime.trigger('picker2/find')
    expect(sent(t.calls)).toEqual(['picker2@r-1/find Gr'])
    await expect(t.runtime.trigger('nobody/find')).rejects.toThrow('No module instance is named nobody')
  })

  it("prefixes the instances' errors", async () => {
    const t = setup()
    await t.started
    expect(t.errors()['picker1/broken.value']).toMatch(/nope/)
    expect(t.errors()['picker2/broken.value']).toMatch(/nope/)
  })

  it('carries instances over an edit of the app, with the inputs as they are now', async () => {
    const before = setup()
    await before.started
    before.runtime.set({ 'picker1/name1.value': 'Ada', 'picker2/name1.value': 'Grace' })
    await wait()
    const edited = structuredClone(host)
    edited.components[2]!.props!.search = 'Gl'
    const after = setup(edited, before)
    await after.started
    // What was typed stays, unless its default changed (picker2's follows its input); only the query whose input
    // changed runs again.
    expect(after.state['picker1/name1.value']).toBe('Ada')
    expect(after.state['picker2/name1.value']).toBe('Gl')
    expect(sent(after.calls)).toEqual(['picker2@r-1/find Gl'])
    // The old instances are stopped.
    before.runtime.set({ 'picker1/name1.value': 'x' })
    expect(after.state['picker1/name1.value']).toBe('Ada')
  })

  it('logs a module event when the module runs on its own', async () => {
    const calls: string[] = []
    const runtime = new AppRuntime(
      picker,
      {
        runQuery: async () => ({ ok: true, data: null }),
        confirm: async () => true,
        effect: () => {},
        publish: () => {},
        log: (level, text) => calls.push(`${level}: ${text}`),
      },
      { autoRunDelayMs: 0, inputs: { search: 'Z' } },
    )
    await runtime.start()
    expect(runtime.model.get('inputs.search')).toBe('Z')
    expect(await runtime.fire('pick', 'click')).toBe(true)
    expect(calls).toContain('info: Module event: picked')
  })
})

describe('modules inside modules (M21)', () => {
  const nested: AppDefinition = {
    schemaVersion: 1,
    components: [
      comp('shellA', 'module', { module: 'shell', search: 'Ad' }),
      comp('shellB', 'module', { module: 'shell', search: 'Gr' }),
      comp('shown', 'text', { value: '{{ shellA.chosen }}' }),
    ],
    queries: [],
  }

  it('runs an instance’s own instances, each apart, with queries naming their whole path', async () => {
    const t = setup(nested)
    await t.started
    expect(sent(t.calls).sort()).toEqual([
      'shellA@r-shell/picker1@r-live/find Ad',
      'shellB@r-shell/picker1@r-live/find Gr',
    ])
    expect(t.state['shellA/picker1/name1.value']).toBe('Ad')
    expect(t.state['shellB/picker1/name1.value']).toBe('Gr')
    expect(t.state['shellA/picker1/find.data']).toEqual([{ query: 'find', instance: 'shellA/picker1' }])
    // Outputs come up a level at a time: the picker's into the shell's, the shell's into the app.
    expect(t.state['shellA.chosen']).toBe('Ad')
    expect(t.state['shown.value']).toBe('Ad')
  })

  it('routes what the user types to the innermost instance, and its output back up', async () => {
    const t = setup(nested)
    await t.started
    t.runtime.set({ 'shellA/picker1/name1.value': 'Bea' })
    await wait()
    expect(t.state['shellA/picker1/name1.value']).toBe('Bea')
    expect(t.state['shellB/picker1/name1.value']).toBe('Gr')
    expect(t.state['shellA.chosen']).toBe('Bea')
    expect(t.state['shown.value']).toBe('Bea')
  })

  it('names errors by their whole path', async () => {
    const t = setup(nested)
    await t.started
    expect(
      Object.keys(t.errors())
        .filter((k) => k.includes('broken'))
        .sort(),
    ).toEqual(['shellA/picker1/broken.value', 'shellB/picker1/broken.value'])
  })
})
