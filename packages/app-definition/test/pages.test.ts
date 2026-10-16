import { describe, expect, it } from 'vitest'
import { AppModel, defaultPage, entityPages, resolvePage, validateApp } from '../src'
import { app, comp, sqlQuery } from './helpers'

const pages = [{ name: 'list', title: 'Customers' }, { name: 'detail' }]

/** A two-page app: a header on every page, a list page and a detail page reading `url.params.id`. */
const twoPages = (extra: Partial<Parameters<typeof app>[0]> = {}) =>
  app({
    pages,
    components: [
      comp('header', 'text', { value: 'On {{ url.page }}' }),
      comp('table1', 'table', { data: '{{ customers.data }}' }, { page: 'list' }),
      comp('box', 'container', {}, { page: 'detail' }),
      comp('title', 'text', { value: '{{ customer.data?.[0]?.name }}' }, { parent: 'box' }),
    ],
    queries: [
      sqlQuery('customers', 'select * from customers', 'auto', { page: 'list' }),
      sqlQuery('customer', 'select * from customers where id = {{ url.params.id }}', 'auto', {
        page: 'detail',
      }),
      sqlQuery('plans', 'select * from plans'),
    ],
    transformers: [{ name: 'count', code: 'return customers.data?.length ?? 0', page: 'list' }],
    variables: [{ name: 'flag', initialValue: false }],
    ...extra,
  })

const problems = (def: unknown) =>
  validateApp(def).diagnostics.map((d) => [d.code, d.path.join('.'), d.entity ?? null])

describe('pages', () => {
  it('put each component, query and transformer on a page or on every page', () => {
    const def = twoPages()
    expect(Object.fromEntries(entityPages(def))).toEqual({
      header: null,
      table1: 'list',
      box: 'detail',
      // Inside a container: the container's page.
      title: 'detail',
      customers: 'list',
      customer: 'detail',
      plans: null,
      count: 'list',
      flag: null,
    })
    expect(defaultPage(def)).toBe('list')
    expect(resolvePage(def, 'detail')).toBe('detail')
    expect(resolvePage(def, 'nope')).toBe('list')
    expect(defaultPage(app())).toBeNull()
    expect(problems(def)).toEqual([])
  })

  it('url holds the page shown and its parameters, as code reads them', () => {
    const def = twoPages()
    const m = new AppModel(def, { url: { page: 'detail', params: { id: '42' } } })
    m.init()
    expect(m.get('url.page')).toBe('detail')
    expect(m.get('url.params')).toEqual({ id: '42' })
    expect(m.get('header.value')).toBe('On detail')
    // Moving to another page re-evaluates what reads url.
    expect(m.set({ 'url.page': 'list', 'url.params': {} })).toContain('header.value')
    expect(m.get('header.value')).toBe('On list')
    const plain = new AppModel(
      app({ components: [comp('t', 'text', { value: '{{ url.page }}|{{ url.params.x }}' })] }),
    )
    plain.init()
    expect(plain.get('url.page')).toBeNull()
    expect(plain.get('t.value')).toBe('|')
    // A page that doesn't exist opens the first.
    const lost = new AppModel(def, { url: { page: 'gone' } })
    lost.init()
    expect(lost.get('url.page')).toBe('list')
  })

  it('code reads what is global and what is on its own page only', () => {
    const def = twoPages({
      components: [
        comp('header', 'text', { value: '{{ table1.selectedRow?.name }}' }),
        comp('table1', 'table', { data: '{{ customers.data }} {{ customer.data }}' }, { page: 'list' }),
        comp(
          'go',
          'button',
          {},
          {
            page: 'detail',
            events: [
              {
                id: 'a',
                event: 'click',
                action: { type: 'controlQuery', query: 'customers', method: 'trigger' },
              },
            ],
          },
        ),
      ],
      transformers: [{ name: 'count', code: 'return customers.data?.length + plans.data?.length' }],
    })
    expect(problems(def)).toEqual([
      // Handler targets are checked with the component, code afterwards.
      ['other_page', 'components.2.events.0.action.query', 'go'],
      ['other_page', 'components.0.props.value', 'header'],
      ['other_page', 'components.1.props.data', 'table1'],
      ['other_page', 'transformers.0.code', 'count'],
    ])
    const messages = validateApp(def)
      .diagnostics.map((d) => d.message)
      .slice(1)
    expect(messages[0]).toBe(
      '"table1" is on page list; "header" is global (on every page), so it can only use what\'s global',
    )
    expect(messages[1]).toBe('"customer" is on page detail, not on list with "table1"')
  })

  it("pages must exist and be unique; components in containers take their container's", () => {
    const def = app({
      pages: [{ name: 'a' }, { name: 'a' }],
      components: [
        comp('box', 'container', {}, { page: 'a' }),
        comp('inner', 'text', {}, { parent: 'box', page: 'b' }),
        comp('lost', 'text', {}, { page: 'b' }),
      ],
      queries: [sqlQuery('q', 'select 1', 'auto', { page: 'c' })],
      transformers: [{ name: 't', code: 'return 1', page: 'd' }],
    })
    expect(problems(def)).toEqual([
      ['duplicate_page', 'pages.1.name', null],
      ['invalid_page', 'components.1.page', 'inner'],
      ['unknown_page', 'components.2.page', 'lost'],
      ['unknown_page', 'queries.0.page', 'q'],
      ['unknown_page', 'transformers.0.page', 't'],
    ])
  })

  it('url is built in: nothing can take its name, and typos in it are flagged', () => {
    expect(problems(app({ variables: [{ name: 'url' }] }))).toEqual([
      ['invalid_name', 'variables.0.name', 'url'],
    ])
    const typo = validateApp(app({ components: [comp('t', 'text', { value: '{{ url.prams }}' })] }))
    expect(typo.diagnostics.map((d) => [d.code, d.severity])).toEqual([['unknown_property', 'warning']])
  })
})
