import { describe, expect, it } from 'vitest'
import {
  appFields,
  browserExpressions,
  buildAppGraph,
  type LibraryInfo,
  queryTemplates,
  renameAppEntity,
  runsAutomatically,
  type ServerAppQuery,
  validateApp,
} from '../src'
import { app, comp } from './helpers'

const lib = (name: string, extra: object = {}) => ({
  name,
  kind: 'library' as const,
  library: 'orders_by_customer',
  version: 'latest',
  params: { customerId: '{{ table1.selectedRow.id }}', owner: '{{ current_user.email }}' },
  run: 'auto' as const,
  ...extra,
})

const libraries: Record<string, LibraryInfo> = {
  orders_by_customer: {
    liveVersion: '1.1.0',
    versions: { '1.0.0': ['customerId'], '1.1.0': ['customerId', 'owner', 'status'] },
  },
  draft_only: { liveVersion: null, versions: {} },
}
const resolveLibrary = (slug: string) => libraries[slug]

const codes = (def: object) =>
  validateApp(def, { resolveLibrary }).diagnostics.map((d) => [d.code, d.path.join('.'), d.severity])

describe('library queries in apps', () => {
  it('validates the reference: slug, live or pinned version, the parameters passed', () => {
    const table = comp('table1', 'table')
    expect(codes(app({ components: [table], queries: [lib('orders')] }))).toEqual([
      ['missing_param', 'queries.0.params', 'warning'],
    ])
    expect(
      codes(
        app({
          components: [table],
          queries: [
            lib('a', { library: 'nope' }),
            lib('b', { library: 'draft_only' }),
            lib('c', { version: '2.0.0' }),
            lib('d', { version: '1.0.0' }),
          ],
        }),
      ),
    ).toEqual([
      ['unknown_library', 'queries.0.library', 'error'],
      ['unpublished_library', 'queries.1.version', 'error'],
      ['unknown_version', 'queries.2.version', 'error'],
      ['unknown_param', 'queries.3.params.owner', 'error'],
    ])
    // Without the library, only the app's own rules apply.
    expect(validateApp(app({ components: [table], queries: [lib('a', { library: 'nope' })] })).ok).toBe(true)
  })

  it('checks the schema of the reference', () => {
    const bad = app({ queries: [lib('a', { version: 'v1' }), lib('b', { params: { 'not a name': 1 } })] })
    expect(validateApp(bad).diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['schema', 'queries.0.version'],
      ['schema', 'queries.1.params.not a name'],
    ])
  })

  it('treats parameters like a resource query: fields, automatic runs, values the browser sends', () => {
    const def = app({
      components: [comp('table1', 'table')],
      queries: [lib('orders'), lib('save', { run: 'manual' })],
    })
    const q = def.queries[0] as ServerAppQuery
    expect(runsAutomatically(q)).toBe(true)
    expect(runsAutomatically(def.queries[1]!)).toBe(false)
    expect(browserExpressions(queryTemplates(q))).toEqual([' table1.selectedRow.id '])
    expect(appFields(def).filter((f) => f.owner === 'orders')).toEqual([
      expect.objectContaining({ path: ['queries', 0, 'params', 'customerId'], node: 'orders.$deps' }),
      expect.objectContaining({ path: ['queries', 0, 'params', 'owner'], node: 'orders.$deps' }),
    ])
    expect(buildAppGraph(def).nodes.get('orders.$deps')!.deps).toContain('table1.selectedRow')
  })

  it('refuses mixing current_user with app values in a parameter', () => {
    const def = app({
      components: [comp('table1', 'table')],
      queries: [
        lib('orders', { params: { customerId: '{{ current_user.email + table1.selectedRow.id }}' } }),
      ],
    })
    expect(validateApp(def).diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['mixed_current_user', 'queries.0.params.customerId'],
    ])
  })

  it('rewrites parameter templates on rename', () => {
    const def = app({ components: [comp('table1', 'table')], queries: [lib('orders')] })
    const renamed = renameAppEntity(def, 'table1', 'customers')
    expect(renamed.ok && renamed.definition.queries[0]).toMatchObject({
      params: { customerId: '{{ customers.selectedRow.id }}' },
    })
  })
})
