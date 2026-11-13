import type { AppDefinition } from '@ow/app-definition'
import { describe, expect, it, vi } from 'vitest'
import { AppRuntime, type Effect, type QueryOutcome, type StatePatch, setIn, toCsv } from '../src'

type Def = Partial<Omit<AppDefinition, 'schemaVersion'>>
const app = (parts: Def): AppDefinition => ({ schemaVersion: 1, components: [], queries: [], ...parts })
const comp = (name: string, type: string, props: Record<string, unknown> = {}, extra: object = {}) =>
  ({ name, type, props, ...extra }) as AppDefinition['components'][number]
const sql = (name: string, text: string, run: 'auto' | 'manual' = 'auto', extra: object = {}) =>
  ({
    name,
    kind: 'resource',
    resource: 'db',
    query: { sql: text },
    run,
    ...extra,
  }) as AppDefinition['queries'][number]
const js = (name: string, code: string, extra: object = {}) =>
  ({ name, kind: 'js', code, ...extra }) as AppDefinition['queries'][number]
const on = (event: string, action: object, extra: object = {}) => ({
  id: Math.random().toString(36).slice(2, 10),
  event,
  action,
  ...extra,
})
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** A runtime with a fake page: records what it publishes, runs and shows; `respond` answers queries. */
function setup(
  def: Def,
  opts: {
    respond?: (query: string, values: Record<string, unknown>) => unknown
    confirm?: boolean
    delay?: number
    url?: { page?: string | null; params?: Record<string, string> }
    storage?: Record<string, unknown>
  } = {},
) {
  const calls: { query: string; values: Record<string, unknown> }[] = []
  const effects: Effect[] = []
  const patches: StatePatch[] = []
  const confirms: string[] = []
  const state: Record<string, unknown> = {}
  const runtime = new AppRuntime(
    app(def),
    {
      async runQuery(query, values): Promise<QueryOutcome> {
        calls.push({ query, values })
        try {
          return { ok: true, data: await (opts.respond?.(query, values) ?? null) }
        } catch (err) {
          return { ok: false, error: { message: (err as Error).message } }
        }
      },
      async confirm(message) {
        confirms.push(message)
        return opts.confirm ?? true
      },
      effect: (e) => effects.push(e),
      publish: (p) => {
        patches.push(p)
        Object.assign(state, p.values)
      },
      log: () => {},
    },
    {
      autoRunDelayMs: opts.delay ?? 0,
      globals: { current_user: { email: 'a@optiply.nl' } },
      ...(opts.url && { url: opts.url }),
      ...(opts.storage && { storage: opts.storage }),
    },
  )
  return { runtime, calls, effects, patches, confirms, state }
}

const customers = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
]

describe('AppRuntime', () => {
  it('publishes every value, then runs automatic and on-load queries with the values the browser evaluates', async () => {
    const t = setup(
      {
        components: [
          comp('search', 'textInput', { defaultValue: 'a' }),
          comp('table1', 'table', { data: '{{ list.data ?? [] }}' }),
        ],
        queries: [
          sql(
            'list',
            "select * from c where name ilike {{ '%' + search.value + '%' }} and owner = {{ current_user.email }}",
          ),
          sql('stats', 'select 1', 'manual', { runOnLoad: true }),
          sql('save', 'update c set x = 1', 'manual'),
        ],
      },
      { respond: (q) => (q === 'list' ? customers : [{ n: 1 }]) },
    )
    await t.runtime.start()
    expect(t.patches[0]!.values).toMatchObject({ 'search.value': 'a', 'table1.data': [], 'list.data': null })
    // Of the internal values, only a table's rows (M24), which its renderer reads.
    expect(Object.keys(t.patches[0]!.values).filter((k) => k.includes('$'))).toEqual(['table1.$rows'])
    // current_user is evaluated on the server, so the browser doesn't send it.
    expect(t.calls).toEqual([
      { query: 'list', values: { " '%' + search.value + '%' ": '%a%' } },
      { query: 'stats', values: {} },
    ])
    expect(t.state['table1.data']).toEqual(customers)
    expect(t.state['list.isFetching']).toBe(false)
    expect(t.state['list.lastRunAt']).toEqual(expect.any(String))
  })

  it('runs an automatic query once after typing settles, and keeps only the newest result', async () => {
    let n = 0
    let answered = 0
    const t = setup(
      {
        components: [comp('search', 'textInput')],
        queries: [sql('list', 'select {{ search.value }}')],
      },
      {
        delay: 20,
        // The first answer comes back last.
        respond: async (_q, values) => {
          const mine = ++n
          await wait(mine === 2 ? 60 : 5)
          answered++
          return values[' search.value ']
        },
      },
    )
    const searched = () => t.calls.map((c) => c.values[' search.value '])
    await t.runtime.start()
    t.runtime.set({ 'search.value': 'a' })
    t.runtime.set({ 'search.value': 'ab' })
    t.runtime.set({ 'search.value': 'abc' })
    // Waits for what happened, not for a fixed time: a busy CI runner can be several times slower. Polled every
    // millisecond so `abcd` is typed while the `abc` run (60 ms) is still out.
    await vi.waitFor(() => expect(searched()).toHaveLength(2), { interval: 1 })
    expect(searched()).toEqual(['', 'abc'])
    t.runtime.set({ 'search.value': 'abcd' })
    // Both answers are in (the older one last), and the newest stays.
    await vi.waitFor(() => expect(answered).toBe(3), { timeout: 5_000, interval: 1 })
    await wait()
    expect(searched()).toEqual(['', 'abc', 'abcd'])
    expect(t.state['list.data']).toBe('abcd')
  })

  it('keeps the newest result when an older run finishes later', async () => {
    const t = setup(
      {
        queries: [sql('q', 'select {{ v.value }}', 'manual')],
        variables: [{ name: 'v', initialValue: 'slow' }],
      },
      {
        respond: async (_q, values) => {
          await wait(values[' v.value '] === 'slow' ? 40 : 1)
          return values[' v.value ']
        },
      },
    )
    await t.runtime.start()
    const slow = t.runtime.trigger('q')
    t.runtime.set({ 'v.value': 'fast' })
    await t.runtime.trigger('q')
    expect(await slow).toBe('slow')
    expect(t.state['q.data']).toBe('fast')
  })

  it('confirms, runs, transforms, and fires success and failure handlers', async () => {
    let fail = false
    const t = setup(
      {
        components: [
          comp(
            'btn',
            'button',
            {},
            { events: [on('click', { type: 'controlQuery', query: 'save', method: 'trigger' })] },
          ),
        ],
        queries: [
          sql('save', 'update x', 'manual', {
            confirm: 'Save {{ 2 }} rows?',
            transform: 'return data.length',
            events: [
              on('success', { type: 'notify', message: 'Saved {{ save.data }}', tone: 'success' }),
              on('failure', { type: 'setVariable', variable: 'last', value: '{{ save.error.message }}' }),
            ],
          }),
        ],
        variables: [{ name: 'last' }],
      },
      {
        respond: () => {
          if (fail) throw new Error('duplicate key')
          return [1, 2]
        },
      },
    )
    await t.runtime.start()
    expect(await t.runtime.fire('btn', 'click')).toBe(true)
    await wait()
    expect(t.confirms).toEqual(['Save 2 rows?'])
    expect(t.state['save.data']).toBe(2)
    expect(t.effects).toEqual([{ type: 'notify', message: 'Saved 2', tone: 'success' }])

    fail = true
    expect(await t.runtime.fire('btn', 'click')).toBe(false)
    await wait()
    expect(t.state['save.error']).toEqual({ message: 'duplicate key' })
    expect(t.state['last.value']).toBe('duplicate key')
    // Told once, though the failure passed through the query and the handler.
    expect(t.effects.filter((e) => e.type === 'notify' && e.tone === 'error')).toEqual([
      { type: 'notify', message: 'save failed: duplicate key', tone: 'error' },
    ])
  })

  it('keeps a failing automatic read quiet: its error is in the state, with no notification', async () => {
    const t = setup(
      { queries: [sql('list', 'select nope')] },
      {
        respond: () => {
          throw new Error('column "nope" does not exist')
        },
      },
    )
    await t.runtime.start()
    expect(t.state['list.error']).toEqual({ message: 'column "nope" does not exist' })
    expect(t.effects).toEqual([])
  })

  it('skips a query the user doesn’t confirm, or that is disabled', async () => {
    const t = setup(
      {
        queries: [
          sql('a', 'delete', 'manual', { confirm: 'Sure?' }),
          sql('b', 'select 1', 'manual', { disabled: '{{ true }}' }),
        ],
      },
      { confirm: false },
    )
    await t.runtime.start()
    expect(await t.runtime.trigger('a')).toBeUndefined()
    expect(await t.runtime.trigger('b')).toBeUndefined()
    expect(t.calls).toEqual([])
    expect(t.state['a.isFetching']).toBe(false)
  })

  it('runs JS queries that trigger queries, call methods, set variables and use utils', async () => {
    const t = setup(
      {
        components: [
          comp('name', 'textInput'),
          comp('m', 'modal'),
          comp('t', 'text', { value: '{{ v.value.n }}' }),
        ],
        queries: [
          sql('get', 'select {{ id }}', 'manual'),
          js(
            'script',
            `const rows = await get.trigger({ additionalScope: { id: 7 } })
             name.setValue(rows[0].name)
             v.setIn('n', rows.length)
             m.open()
             utils.notify('done', 'success')
             return rows.map(r => r.name)`,
          ),
        ],
        variables: [{ name: 'v', initialValue: { n: 0 } }],
      },
      { respond: (_q, values) => [{ name: `row ${values[' id ']}` }] },
    )
    await t.runtime.start()
    expect(await t.runtime.trigger('script')).toEqual(['row 7'])
    expect(t.state).toMatchObject({
      'name.value': 'row 7',
      'v.value': { n: 1 },
      't.value': '1',
      'm.isOpen': true,
      'script.data': ['row 7'],
    })
    expect(t.effects).toEqual([{ type: 'notify', message: 'done', tone: 'success' }])
  })

  it("gives a query's declared scope names, undefined when a trigger doesn't pass them (M36)", async () => {
    const t = setup(
      {
        queries: [
          sql('get', 'select {{ id ?? 0 }}, {{ note ?? "none" }}', 'manual', { scope: ['id', 'note'] }),
        ],
      },
      { respond: (_q, values) => [values] },
    )
    await t.runtime.start()
    expect(await t.runtime.trigger('get', { additionalScope: { id: 7 } })).toEqual([
      { ' id ?? 0 ': 7, ' note ?? "none" ': 'none' },
    ])
  })

  it('reports a failing script handler once', async () => {
    const t = setup({
      components: [
        comp(
          'b',
          'button',
          {},
          { events: [on('click', { type: 'runScript', code: 'throw new Error("boom")' })] },
        ),
      ],
    })
    await t.runtime.start()
    expect(await t.runtime.fire('b', 'click')).toBe(false)
    expect(t.effects).toEqual([{ type: 'notify', message: 'b (click): boom', tone: 'error' }])
  })

  it('submits forms: required inputs first, reset only when every handler succeeded', async () => {
    let fail = false
    const t = setup(
      {
        components: [
          comp(
            'f',
            'form',
            {},
            { events: [on('submit', { type: 'controlQuery', query: 'insert', method: 'trigger' })] },
          ),
          comp(
            'first',
            'textInput',
            { label: 'First name', required: true, defaultValue: '' },
            { parent: 'f' },
          ),
          comp('vip', 'checkbox', {}, { parent: 'f' }),
        ],
        queries: [sql('insert', 'insert {{ f.data }}', 'manual')],
      },
      {
        respond: () => {
          if (fail) throw new Error('nope')
          return []
        },
      },
    )
    await t.runtime.start()
    expect(await t.runtime.call('f', 'submit')).toBe(false)
    expect(t.effects.at(-1)).toEqual({ type: 'notify', message: 'Fill in First name', tone: 'error' })
    expect(t.calls).toEqual([])

    t.runtime.set({ 'first.value': 'Ada', 'vip.value': true })
    fail = true
    expect(await t.runtime.call('f', 'submit')).toBe(false)
    expect(t.state['first.value']).toBe('Ada')
    fail = false
    expect(await t.runtime.call('f', 'submit')).toBe(true)
    expect(t.calls.at(-1)!.values).toEqual({ ' f.data ': { first: 'Ada', vip: true } })
    expect(t.state).toMatchObject({ 'first.value': '', 'vip.value': false })
  })

  it('selects table rows, opens and closes modals, and hides components', async () => {
    const t = setup({
      components: [
        comp(
          't',
          'table',
          { data: customers },
          {
            events: [
              on(
                'rowSelect',
                { type: 'controlComponent', component: 'm', method: 'open' },
                { onlyIf: '{{ t.selectedRow.id > 1 }}' },
              ),
            ],
          },
        ),
        comp('m', 'modal', {}, { events: [on('close', { type: 'notify', message: 'closed' })] }),
        comp('x', 'text'),
      ],
    })
    await t.runtime.start()
    await t.runtime.call('t', 'selectRow', [0])
    expect(t.state).toMatchObject({ 't.selectedRow': customers[0], 't.selectedIndex': 0, 'm.isOpen': false })
    await t.runtime.call('t', 'selectRow', [1])
    expect(t.state).toMatchObject({ 't.selectedRows': [customers[1]], 'm.isOpen': true })
    await t.runtime.call('m', 'close')
    expect(t.effects).toEqual([{ type: 'notify', message: 'closed', tone: 'info' }])
    await t.runtime.call('x', 'setHidden', [true])
    expect(t.state['x.hidden']).toBe(true)
    await expect(t.runtime.call('x', 'explode')).rejects.toThrow('x has no method explode')
  })

  it('pages, sorts and searches a server-side table: its query re-runs with the new values', async () => {
    const t = setup({
      components: [
        comp(
          't',
          'table',
          { data: '{{ page.data }}', paging: 'server', pageSize: 2 },
          {
            events: [
              on('pageChange', { type: 'notify', message: 'page {{ t.page }}' }),
              on('sortChange', { type: 'notify', message: 'sort {{ t.sort?.column }}' }),
              on('searchChange', { type: 'notify', message: 'search {{ t.searchText }}' }),
              on('filterChange', { type: 'notify', message: 'filters {{ t.filters.length }}' }),
            ],
          },
        ),
      ],
      queries: [
        sql(
          'page',
          'select * from c where name ilike {{ t.searchText }} and {{ t.filters.length }} >= 0 order by {{ t.sort?.column }} {{ t.sort?.desc }} limit {{ t.pagination.pageSize }} offset {{ t.pagination.offset }}',
        ),
      ],
    })
    await t.runtime.start()
    await wait()
    const last = () => t.calls.at(-1)!.values
    expect(last()).toMatchObject({
      ' t.searchText ': '',
      ' t.sort?.column ': undefined,
      ' t.pagination.pageSize ': 2,
      ' t.pagination.offset ': 0,
    })
    await t.runtime.call('t', 'setPage', [2])
    await wait()
    expect(last()).toMatchObject({ ' t.pagination.offset ': 4 })
    // Sorting and searching go back to the first page.
    await t.runtime.call('t', 'setSort', ['name', true])
    await wait()
    expect(last()).toMatchObject({
      ' t.sort?.column ': 'name',
      ' t.sort?.desc ': true,
      ' t.pagination.offset ': 0,
    })
    await t.runtime.call('t', 'setPage', ['1'])
    await t.runtime.call('t', 'setSearchText', ['ada'])
    await wait()
    expect(last()).toMatchObject({ ' t.searchText ': 'ada', ' t.pagination.offset ': 0 })
    await t.runtime.call('t', 'setSort', [null])
    expect(t.state['t.sort']).toBeNull()
    // Filters (M24): kept normalized, back to the first page, an event; the query re-runs with them.
    await t.runtime.call('t', 'setPage', [1])
    await t.runtime.call('t', 'setFilters', [
      [{ column: 'name', op: 'contains', value: 'a', type: 'text' }, { column: 'x', op: 'drop' }, 'junk'],
    ])
    await wait()
    expect(t.state['t.filters']).toEqual([{ column: 'name', op: 'contains', value: 'a', type: 'text' }])
    expect(last()).toMatchObject({ ' t.pagination.offset ': 0 })
    await t.runtime.call('t', 'clearFilters')
    expect(t.state['t.filters']).toEqual([])
    expect(t.effects.map((e) => (e as { message: string }).message)).toEqual([
      'page 2',
      'sort name',
      'page 1',
      'search ada',
      'sort ',
      'page 1',
      'filters 1',
      'filters 0',
    ])
  })

  it('saves table changes, clearing them only when every save handler succeeded', async () => {
    let fail = true
    const t = setup(
      {
        components: [
          comp(
            't',
            'table',
            { data: customers },
            {
              events: [on('save', { type: 'controlQuery', query: 'save', method: 'trigger' })],
            },
          ),
        ],
        queries: [sql('save', 'update c from {{ t.changesetArray }}', 'manual')],
      },
      {
        respond: () => {
          if (fail) throw new Error('nope')
          return []
        },
      },
    )
    await t.runtime.start()
    const changes = [{ id: 2, name: 'Grace Hopper' }]
    t.runtime.set({ 't.changesetArray': changes })
    expect(await t.runtime.call('t', 'saveChanges')).toBe(false)
    expect(t.state['t.changesetArray']).toEqual(changes)
    fail = false
    expect(await t.runtime.call('t', 'saveChanges')).toBe(true)
    expect(t.calls.at(-1)!.values).toEqual({ ' t.changesetArray ': changes })
    expect(t.state['t.changesetArray']).toEqual([])
  })

  it('adds rows to newRows, saved and cleared with the changeset (M24)', async () => {
    const t = setup({
      components: [
        comp(
          't',
          'table',
          { data: customers },
          {
            events: [
              on('save', { type: 'controlQuery', query: 'insert', method: 'trigger' }),
              on('addRow', { type: 'notify', message: 'added {{ t.newRows.length }}' }),
            ],
          },
        ),
      ],
      queries: [sql('insert', 'insert into c select * from {{ t.newRows }}', 'manual')],
    })
    await t.runtime.start()
    await t.runtime.call('t', 'addRow')
    await t.runtime.call('t', 'addRow', [{ name: 'Ada', id: 9 }])
    await t.runtime.call('t', 'addRow', ['not a row'])
    expect(t.state['t.newRows']).toEqual([{}, { name: 'Ada', id: 9 }, {}])
    expect(t.effects.map((e) => (e as { message: string }).message)).toEqual([
      'added 1',
      'added 2',
      'added 3',
    ])
    t.runtime.set({ 't.changesetArray': [{ id: 2, name: 'Grace' }] })
    await t.runtime.call('t', 'clearChangeset')
    expect([t.state['t.newRows'], t.state['t.changesetArray']]).toEqual([[], []])
    await t.runtime.call('t', 'addRow', [{ name: 'Lin' }])
    expect(await t.runtime.call('t', 'saveChanges')).toBe(true)
    expect(t.calls.at(-1)!.values).toEqual({ ' t.newRows ': [{ name: 'Lin' }] })
    expect(t.state['t.newRows']).toEqual([])
  })

  it('switches a container’s views, firing viewChange only when the view changes (M24)', async () => {
    const t = setup({
      components: [
        comp(
          'box',
          'container',
          { views: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], defaultView: 'b' },
          { events: [on('viewChange', { type: 'notify', message: 'now {{ box.currentView }}' })] },
        ),
      ],
    })
    await t.runtime.start()
    expect(t.state['box.currentView']).toBe('b')
    await t.runtime.call('box', 'nextView')
    await t.runtime.call('box', 'nextView')
    expect(t.state['box.currentView']).toBe('c')
    await t.runtime.call('box', 'setView', ['a'])
    await t.runtime.call('box', 'setView', ['a'])
    await t.runtime.call('box', 'previousView')
    await expect(t.runtime.call('box', 'setView', ['nope'])).rejects.toThrow(
      'box has no view "nope": it has a, b, c',
    )
    expect(t.effects.map((e) => (e as { message: string }).message)).toEqual(['now c', 'now a'])
  })

  it('folds and unfolds a container, firing only when it changes (M24)', async () => {
    const t = setup({
      components: [
        comp(
          'box',
          'container',
          { collapsible: true, defaultExpanded: false },
          {
            events: [
              on('expand', { type: 'notify', message: 'open' }),
              on('collapse', { type: 'notify', message: 'shut' }),
            ],
          },
        ),
      ],
    })
    await t.runtime.start()
    expect(t.state['box.expanded']).toBe(false)
    await t.runtime.call('box', 'collapse')
    await t.runtime.call('box', 'toggle')
    await t.runtime.call('box', 'expand')
    await t.runtime.call('box', 'toggle')
    expect(t.state['box.expanded']).toBe(false)
    expect(t.effects.map((e) => (e as { message: string }).message)).toEqual(['open', 'shut'])
  })

  it('debounces handlers that ask for it', async () => {
    const t = setup({
      components: [
        comp(
          's',
          'textInput',
          {},
          { events: [on('change', { type: 'notify', message: '{{ s.value }}' }, { debounceMs: 20 })] },
        ),
      ],
    })
    await t.runtime.start()
    for (const v of ['a', 'ab', 'abc']) {
      t.runtime.set({ 's.value': v })
      void t.runtime.fire('s', 'change')
    }
    await wait(40)
    expect(t.effects).toEqual([{ type: 'notify', message: 'abc', tone: 'info' }])
  })

  it('downloads CSV and JSON through utils', async () => {
    const t = setup({
      queries: [
        js(
          'dl',
          "utils.downloadFile([{ a: 1, b: '=1+1' }, { a: 'x,y' }], 'out.csv'); utils.downloadFile({ a: 1 }, 'o.json')",
        ),
      ],
    })
    await t.runtime.start()
    await t.runtime.trigger('dl')
    expect(t.effects).toEqual([
      { type: 'download', data: 'a,b\r\n1,\'=1+1\r\n"x,y",\r\n', fileName: 'out.csv', mimeType: 'text/csv' },
      { type: 'download', data: '{\n  "a": 1\n}', fileName: 'o.json', mimeType: 'application/json' },
    ])
  })

  it("runs Retool's APIs: views by key, local storage, notifications, files, column data (M36)", async () => {
    const t = setup({
      components: [
        comp('box', 'container', {
          views: [
            { name: 'orders', label: 'Orders' },
            { name: 'log', label: '7' },
          ],
        }),
        comp('seen', 'text', { value: '{{ box.currentView }} {{ localStorage.values.k ?? "none" }}' }),
      ],
      queries: [
        js(
          'retool',
          [
            'box.setCurrentView(7)',
            "localStorage.setValue('k', 'v'); localStorage.setValue('gone', 1); localStorage.removeValue('gone')",
            "utils.showNotification({ title: 'Saved', description: '3 rows', notificationType: 'success' })",
            "utils.downloadFile('a', 'report', 'txt')",
            "return [formatDataAsArray({ id: [1, 2], n: ['a', 'b'] }), formatDataAsArray([{ id: 1 }]), formatDataAsObject([{ id: 1 }, { id: 2, x: 3 }])]",
          ].join('\n'),
        ),
        js('first', 'box.setCurrentViewIndex(0); localStorage.clear()'),
      ],
    })
    await t.runtime.start()
    expect(await t.runtime.trigger('retool')).toEqual([
      [
        { id: 1, n: 'a' },
        { id: 2, n: 'b' },
      ],
      [{ id: 1 }],
      { id: [1, 2], x: [undefined, 3] },
    ])
    expect(t.state['seen.value']).toBe('log v')
    expect(t.effects).toContainEqual({ type: 'notify', message: 'Saved: 3 rows', tone: 'success' })
    expect(t.effects).toContainEqual({
      type: 'download',
      data: 'a',
      fileName: 'report.txt',
      mimeType: 'text/plain',
    })
    await t.runtime.trigger('first')
    expect(t.state['seen.value']).toBe('orders none')
  })

  it("passes a handler's owner to the query it triggers as triggeredById (M36)", async () => {
    const t = setup({
      components: [
        comp(
          'b',
          'button',
          {},
          { events: [on('click', { type: 'controlQuery', query: 'who', method: 'trigger' })] },
        ),
      ],
      queries: [js('who', 'return triggeredById', { scope: ['triggeredById'] })],
    })
    await t.runtime.start()
    await t.runtime.fire('b', 'click')
    expect(t.state['who.data']).toBe('b')
    expect(await t.runtime.trigger('who')).toBeUndefined()
  })

  it('takes over after an edit, keeping what the user did and re-running only what changed', async () => {
    const calls: string[] = []
    const effects: Effect[] = []
    const state: Record<string, unknown> = {}
    const bridge = {
      async runQuery(query: string, values: Record<string, unknown>): Promise<QueryOutcome> {
        calls.push(`${query}:${JSON.stringify(values)}`)
        return { ok: true, data: [values] }
      },
      confirm: async () => true,
      effect: (e: Effect) => effects.push(e),
      publish: (p: StatePatch) => Object.assign(state, p.values),
      log: () => {},
    }
    const base = {
      components: [
        comp('search', 'textInput', { defaultValue: 'a' }),
        comp('title', 'text', { value: 'One' }),
      ],
      queries: [sql('list', 'select {{ search.value }}')],
      variables: [{ name: 'picked', initialValue: '{{ 1 }}' }],
    }
    const start = (def: Def, previous?: AppRuntime) => {
      const r = new AppRuntime(app(def), bridge, { autoRunDelayMs: 0 })
      return { r, done: r.start(previous ? { previous } : {}) }
    }

    let { r, done } = start(base)
    await done
    r.set({ 'search.value': 'typed', 'picked.value': 7 })
    await wait()
    expect(calls).toEqual(['list:{" search.value ":"a"}', 'list:{" search.value ":"typed"}'])

    // An unrelated change: nothing runs again, and what the user did stays.
    const edited = { ...base, components: [base.components[0]!, comp('title', 'text', { value: 'Two' })] }
    ;({ r, done } = start(edited, r))
    await done
    expect(calls).toHaveLength(2)
    expect(state).toMatchObject({
      'title.value': 'Two',
      'search.value': 'typed',
      'picked.value': 7,
      'list.data': [{ ' search.value ': 'typed' }],
    })

    // The query changed: it runs again with what was typed.
    const newSql = { ...edited, queries: [sql('list', 'select {{ search.value }}, 1')] }
    ;({ r, done } = start(newSql, r))
    await done
    expect(calls.at(-1)).toBe('list:{" search.value ":"typed"}')
    expect(calls).toHaveLength(3)

    // The input's default changed: it starts from it, so the query's value changed too; the variable's initial
    // value changed: it starts again.
    const newDefaults = {
      ...newSql,
      components: [comp('search', 'textInput', { defaultValue: 'b' }), edited.components[1]!],
      variables: [{ name: 'picked', initialValue: '{{ 2 }}' }],
    }
    ;({ r, done } = start(newDefaults, r))
    await done
    expect(calls.at(-1)).toBe('list:{" search.value ":"b"}')
    expect(state).toMatchObject({ 'search.value': 'b', 'picked.value': 2 })
  })

  it('starts what Reset state names afresh, the rest keeping what the user did', async () => {
    const calls: string[] = []
    const state: Record<string, unknown> = {}
    const bridge = {
      async runQuery(query: string): Promise<QueryOutcome> {
        calls.push(query)
        return { ok: true, data: calls.length }
      },
      confirm: async () => true,
      effect: () => {},
      publish: (p: StatePatch) => Object.assign(state, p.values),
      log: () => {},
    }
    const def = app({
      components: [comp('a', 'textInput', { defaultValue: 'x' }), comp('b', 'textInput')],
      queries: [sql('list', 'select 1')],
      variables: [{ name: 'v', initialValue: 1 }],
    })
    const first = new AppRuntime(def, bridge, { autoRunDelayMs: 0 })
    await first.start()
    first.set({ 'a.value': 'typed', 'b.value': 'kept', 'v.value': 5 })
    await wait()
    const next = new AppRuntime(def, bridge, { autoRunDelayMs: 0 })
    await next.start({ previous: first, reset: ['a', 'v', 'list'] })
    expect(state).toMatchObject({ 'a.value': 'x', 'b.value': 'kept', 'v.value': 1, 'list.data': 2 })
    // The query reset runs again, as on load.
    expect(calls).toEqual(['list', 'list'])
  })

  it('sets nested values immutably', () => {
    const before = { a: { b: [1, 2] } }
    expect(setIn(before, 'a.b.1', 9)).toEqual({ a: { b: [1, 9] } })
    expect(before).toEqual({ a: { b: [1, 2] } })
    expect(setIn(null, ['x', 0], 'y')).toEqual({ x: ['y'] })
    expect(toCsv([])).toBe('\r\n')
  })
})

describe('pages', () => {
  const twoPages = {
    pages: [{ name: 'list' }, { name: 'detail' }],
    components: [
      comp('search', 'textInput', {}, { page: 'list' }),
      comp('title', 'text', { value: '{{ customer.data?.name }}' }, { page: 'detail' }),
    ],
    queries: [
      sql('plans', 'select * from plans'),
      sql('customers', 'select * from c where name like {{ search.value }}', 'auto', { page: 'list' }),
      sql('customer', 'select * from c where id = {{ url.params.id }}', 'auto', { page: 'detail' }),
      js('opened', 'return url.params.id', { page: 'detail', runOnLoad: true }),
    ],
  }
  const runs = (t: ReturnType<typeof setup>) => t.calls.map((c) => c.query)

  it("runs global queries and the open page's, and the others' when their page opens", async () => {
    const t = setup(twoPages)
    await t.runtime.start()
    expect(runs(t).sort()).toEqual(['customers', 'plans'])
    expect(t.state['url.page']).toBe('list')

    await t.runtime.navigate('detail', { id: '7' })
    await wait()
    expect(runs(t).slice(2)).toEqual(['customer'])
    expect(t.calls.at(-1)!.values).toEqual({ ' url.params.id ': '7' })
    expect(t.state).toMatchObject({ 'url.page': 'detail', 'url.params': { id: '7' }, 'opened.data': '7' })

    // Same page, other parameters: what reads them runs again (the run-on-load query doesn't).
    await t.runtime.navigate('detail', { id: '8' })
    await wait()
    expect(runs(t).slice(3)).toEqual(['customer'])
    expect(t.state['opened.data']).toBe('7')

    // Back on the list: nothing changed there, so nothing runs; typing there runs its query again.
    await t.runtime.navigate('list')
    await wait()
    expect(runs(t)).toHaveLength(4)
    t.runtime.set({ 'search.value': 'a' })
    await wait()
    expect(runs(t).at(-1)).toBe('customers')
  })

  it("doesn't run a closed page's query as its values change; it runs once when the page opens", async () => {
    const t = setup(twoPages, { url: { page: 'detail', params: { id: '1' } } })
    await t.runtime.start()
    expect(runs(t).sort()).toEqual(['customer', 'plans'])
    expect(t.state['opened.data']).toBe('1')
    await t.runtime.navigate('list')
    // A list query never ran: it runs now.
    await wait()
    expect(runs(t).at(-1)).toBe('customers')
    // Detail is closed: its query waits, however often its values change…
    await t.runtime.navigate('list', { id: '2' })
    await t.runtime.navigate('list', { id: '3' })
    await wait()
    expect(runs(t).filter((q) => q === 'customer')).toHaveLength(1)
    // …and runs once when it opens (with the run-on-load query, each time its page opens).
    await t.runtime.navigate('detail', { id: '3' })
    await wait()
    expect(runs(t).filter((q) => q === 'customer')).toHaveLength(2)
    expect(t.state['opened.data']).toBe('3')
  })

  it('a query waiting to run when its page closes runs when the page opens again, not meanwhile', async () => {
    const t = setup(twoPages, { delay: 20 })
    await t.runtime.start()
    const before = runs(t).length
    t.runtime.set({ 'search.value': 'b' })
    // Leaves the list page within the query's wait.
    await t.runtime.navigate('detail', { id: '1' })
    await wait(60)
    expect(
      runs(t)
        .slice(before)
        .filter((q) => q === 'customers'),
    ).toEqual([])
    await t.runtime.navigate('list')
    await wait(60)
    expect(runs(t).at(-1)).toBe('customers')
    expect(t.calls.at(-1)!.values).toEqual({ ' search.value ': 'b' })
  })

  it('an app with its own entity named url (from before pages) keeps running when the page moves', async () => {
    const t = setup({ components: [comp('url', 'textInput')] })
    await t.runtime.start()
    await expect(t.runtime.navigate('x', { a: '1' })).resolves.toBeUndefined()
    t.runtime.set({ 'url.value': 'still mine' })
    expect(t.state['url.value']).toBe('still mine')
  })

  it('utils.openPage asks the page to go there, with parameters as strings', async () => {
    const t = setup({
      ...twoPages,
      queries: [
        js('go', "utils.openPage('detail', { params: { id: 42, skip: null, tags: ['a'] }, newTab: true })"),
        js('lost', "utils.openPage('nowhere')"),
      ],
    })
    await t.runtime.start()
    await t.runtime.trigger('go')
    expect(t.effects).toEqual([
      { type: 'openPage', page: 'detail', params: { id: '42', tags: '["a"]' }, newTab: true },
    ])
    await expect(t.runtime.trigger('lost')).rejects.toThrow(
      'No page is named "nowhere"; the pages are list, detail',
    )
    // The page doesn't change until the page's URL has.
    expect(t.state['url.page']).toBe('list')
  })

  it('an unknown page opens the first; an app without pages has none', async () => {
    const t = setup(twoPages, { url: { page: 'gone' } })
    await t.runtime.start()
    expect(t.state['url.page']).toBe('list')
    const plain = setup({ components: [comp('t', 'text', { value: '{{ url.page }}' })] })
    await plain.runtime.start()
    expect(plain.state['url.page']).toBeNull()
    await plain.runtime.navigate('x', { a: '1' })
    expect(plain.state).toMatchObject({ 'url.page': null, 'url.params': { a: '1' } })
  })
})

describe('library queries (M14)', () => {
  it('send their parameters’ values, run automatically and re-run when a parameter changes', async () => {
    const t = setup(
      {
        components: [comp('customer', 'numberInput', { defaultValue: 7 })],
        queries: [
          {
            name: 'orders',
            kind: 'library',
            library: 'orders_by_customer',
            version: 'latest',
            params: { customerId: '{{ customer.value }}', owner: '{{ current_user.email }}', limit: 10 },
            run: 'auto',
          } as AppDefinition['queries'][number],
        ],
      },
      { respond: () => [{ id: 1 }] },
    )
    await t.runtime.start()
    // current_user is evaluated on the server; constants need nothing from the browser.
    expect(t.calls).toEqual([{ query: 'orders', values: { ' customer.value ': 7 } }])
    expect(t.state['orders.data']).toEqual([{ id: 1 }])
    t.runtime.set({ 'customer.value': 8 })
    await wait(20)
    expect(t.calls.at(-1)).toEqual({ query: 'orders', values: { ' customer.value ': 8 } })
  })
})

describe('event actions of session 41', () => {
  const button = (events: object[]) => comp('go', 'button', {}, { events })
  const pages = [{ name: 'list' }, { name: 'detail' }]

  it('goes to a page with parameters, and sets the shown page’s parameters keeping the others', async () => {
    const t = setup(
      {
        pages,
        components: [
          comp('id', 'textInput', { defaultValue: '7' }),
          button([
            on('click', { type: 'openPage', page: 'detail', params: { id: '{{ id.value }}' }, newTab: true }),
            on('click', { type: 'setUrlParams', params: { tab: 'notes', q: '{{ null }}' } }),
          ]),
        ],
      },
      { url: { page: 'list', params: { q: 'old', keep: 'yes' } } },
    )
    await t.runtime.start()
    await t.runtime.fire('go', 'click')
    expect(t.effects).toEqual([
      { type: 'openPage', page: 'detail', params: { id: '7' }, newTab: true },
      // An empty value removes the parameter.
      { type: 'openPage', page: 'list', params: { keep: 'yes', tab: 'notes' }, newTab: false },
    ])
  })

  it('copies, downloads, and keeps values in local storage', async () => {
    const t = setup(
      {
        components: [
          comp('note', 'text', { value: '{{ localStorage.values.theme ?? "none" }}' }),
          button([
            on('click', { type: 'copyToClipboard', text: '{{ 1 + 1 }}' }),
            on('click', { type: 'download', data: '{{ [{ a: 1 }] }}', fileName: 'rows.csv' }),
            on('click', { type: 'setLocalStorage', key: 'theme', value: '{{ "dark" }}' }),
          ]),
          comp(
            'forget',
            'button',
            {},
            { events: [on('click', { type: 'clearLocalStorage', key: 'theme' })] },
          ),
          comp('wipe', 'button', {}, { events: [on('click', { type: 'clearLocalStorage' })] }),
        ],
      },
      { storage: { size: 'big' } },
    )
    await t.runtime.start()
    expect(t.state['note.value']).toBe('none')
    expect(t.state['localStorage.values']).toEqual({ size: 'big' })
    await t.runtime.fire('go', 'click')
    expect(t.effects).toEqual([
      { type: 'copy', text: '2' },
      { type: 'download', data: 'a\r\n1\r\n', fileName: 'rows.csv', mimeType: 'text/csv' },
      { type: 'storage', key: 'theme', value: 'dark' },
    ])
    expect(t.state['note.value']).toBe('dark')
    await t.runtime.fire('forget', 'click')
    expect(t.state['localStorage.values']).toEqual({ size: 'big' })
    await t.runtime.fire('wipe', 'click')
    expect(t.state['localStorage.values']).toEqual({})
    expect(t.effects.slice(-2)).toEqual([
      { type: 'storage', key: 'theme' },
      { type: 'storage', key: null },
    ])
  })

  it('throttles: one run per window, the events within it dropped', async () => {
    const t = setup({
      components: [
        comp(
          'go',
          'button',
          {},
          { events: [on('click', { type: 'notify', message: 'hi' }, { throttleMs: 200 })] },
        ),
      ],
    })
    await t.runtime.start()
    await t.runtime.fire('go', 'click')
    await t.runtime.fire('go', 'click')
    expect(t.effects).toHaveLength(1)
    await wait(220)
    await t.runtime.fire('go', 'click')
    expect(t.effects).toHaveLength(2)
  })
})
