import { validateApp } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { convertApp, type RetoolApp, readRetoolExport } from '../src'
import { appExport, plugin } from './fixtures'

const ds = (id: string, subtype: string, template: Record<string, unknown>, resourceName = 'db-uuid') =>
  plugin(id, { type: 'datasource', subtype, template, resourceName })
const at = (row: number) => ({ container: '', row, col: 0, width: 6, height: 1 })

/** Queries, State, Functions and the Retool-only names code reads. No real data. */
function sample(): RetoolApp {
  return readRetoolExport(
    appExport([
      plugin('orders', {
        subtype: 'TableWidget2',
        template: { data: '{{ getOrders.data }}' },
        position: at(0),
      }),
      plugin('legacy', {
        subtype: 'TableWidget',
        template: { data: '{{ getOrders.data }}' },
        position: at(2),
      }),
      plugin('modal1', { type: 'frame', subtype: 'ModalFrameWidget', template: {} }),
      plugin('tabs', {
        subtype: 'ContainerWidget2',
        template: { _viewKeys: ['Data', 'Log'] },
        position: at(4),
      }),
      plugin('url', { subtype: 'TextInputWidget2', template: { label: 'URL' }, position: at(8) }),
      plugin('summary', {
        subtype: 'TextWidget2',
        template: {
          value:
            '{{ listIds.data.id.length }} orders, first {{ listIds.data.id[0] }}; {{ legacy.selectedRow.data.sku }} in {{ tabs.currentViewKey }} for {{ current_user.fullName }} ({{ url.value }}) {{ getOrders.data.total }}',
        },
        position: at(9),
      }),
      ds('listIds', 'SqlQueryUnified', { query: 'select id from orders' }),
      ds('getOrders', 'SqlQueryUnified', {
        query: 'select * from orders where shop = {{ shop }}',
        runWhenModelUpdates: true,
        runWhenPageLoads: false,
        enableTransformer: true,
        transformer:
          'return formatDataAsArray(data).filter((r) => r.total > {{ minTotal.value }}).map((r) => data.total)',
        queryTimeout: 120000,
        queryDisabled: '{{ !url.value }}',
      }),
      ds(
        'save',
        'RESTQuery',
        {
          type: 'POST',
          query: 'https://api.example.com/orders/{{ row.id }}',
          bodyType: 'raw',
          body: '{{ row }}',
          requireConfirmation: true,
          confirmationMessage: 'Save {{ row.id }}?',
          showSuccessToaster: true,
          successMessage: 'Saved',
        },
        'REST-WithoutResource',
      ),
      ds('refreshAll', 'JavascriptQuery', {
        query: [
          "await save.trigger({ additionalScope: { row: orders.selectedSourceRow, 'note': 'x', ...extra } })",
          'legacy.setData(getOrders.data)',
          'modal1.show()',
          'const wb = XLSX.read(file, { type: "base64" })',
        ].join('\n'),
        runWhenPageLoads: true,
      }),
      ds(
        'startFlow',
        'WorkflowRun',
        {
          workflowId: 'wf-uuid',
          workflowParams: '{"order": {{ orders.selectedRow.id }}}',
          workflowRunExecutionType: 'sync',
        },
        'WorkflowRun',
      ),
      plugin('minTotal', { type: 'state', subtype: 'State', template: { value: '10' } }),
      plugin('filters', {
        type: 'state',
        subtype: 'State',
        template: { value: '{{ { shop: url.value } }}' },
      }),
      plugin('label', { type: 'state', subtype: 'State', template: { value: 'plain words' } }),
      plugin('total', {
        type: 'function',
        subtype: 'Function',
        template: {
          funcBody: 'const rows = {{ getOrders.data }};\nreturn rows.length * {{ minTotal.value }}',
        },
      }),
    ]),
  ) as RetoolApp
}

describe('convertApp: queries, state, functions and Retool names', () => {
  const { definition, report } = convertApp(sample(), { resources: { 'db-uuid': 'orders_db' } })
  const q = (name: string) => definition.queries.find((x) => x.name === name)

  it('converts resource and JS queries with their settings', () => {
    expect(q('getOrders')).toEqual({
      name: 'getOrders',
      kind: 'resource',
      resource: 'orders_db',
      query: { sql: 'select * from orders where shop = {{ shop }}' },
      run: 'auto',
      disabled: '{{ !url_.value }}',
      transform:
        'return formatDataAsArray(data).filter((r) => r.total > (minTotal.value)).map((r) => data.map((r) => r.total))',
      timeoutMs: 120000,
    })
    expect(q('save')).toMatchObject({
      kind: 'resource',
      resource: 'rest_api',
      run: 'manual',
      confirm: 'Save {{ row.id }}?',
      query: {
        method: 'POST',
        url: 'https://api.example.com/orders/{{ row.id }}',
        body: { type: 'json', json: '{{ row }}' },
      },
      events: [{ event: 'success', action: { type: 'notify', message: 'Saved', tone: 'success' } }],
    })
    expect(q('refreshAll')).toMatchObject({ kind: 'js', runOnLoad: true })
  })

  it("declares the names a trigger's additionalScope passes", () => {
    expect(q('save')?.scope).toEqual(['note', 'row'])
  })

  it('rewrites what Retool calls by other names', () => {
    expect((q('refreshAll') as { code: string }).code).toBe(
      [
        "import * as XLSX from 'xlsx'",
        "await save.trigger({ additionalScope: { row: orders.selectedRow, 'note': 'x', ...extra } })",
        'legacyData.setValue(getOrders.data)',
        'modal1.open()',
        'const wb = XLSX.read(file, { type: "base64" })',
      ].join('\n'),
    )
    expect(definition.components.find((c) => c.name === 'summary')?.props?.value).toBe(
      '{{ listIds.data.map((r) => r.id).length }} orders, first {{ listIds.data.map((r) => r.id)[0] }}; ' +
        '{{ legacy.selectedRow.sku }} in {{ (tabs.views.find((v) => v.name === tabs.currentView)?.label ?? tabs.currentView) }} ' +
        // getOrders has a transform: its data is what the transform returns, left as Retool reads it.
        'for {{ current_user.name }} ({{ url_.value }}) {{ getOrders.data.total }}',
    )
    expect(definition.components.find((c) => c.name === 'legacy')?.props?.data).toBe(
      '{{ legacyData.value ?? (getOrders.data) }}',
    )
    expect(definition.javascript).toEqual({ packages: ['xlsx@0.18.5'] })
  })

  it('turns State into variables and Functions into transformers', () => {
    expect(definition.variables).toEqual([
      { name: 'minTotal', initialValue: 10 },
      { name: 'filters', initialValue: '{{ { shop: url_.value } }}' },
      { name: 'label', initialValue: 'plain words' },
      { name: 'legacyData', description: 'The data legacy.setData() set in Retool' },
    ])
    expect(definition.transformers).toEqual([
      { name: 'total', code: 'const rows = (getOrders.data);\nreturn rows.length * (minTotal.value)' },
    ])
  })

  it("runs Retool workflows as workflow queries, and renames what's reserved", () => {
    expect(q('startFlow')).toEqual({
      name: 'startFlow',
      kind: 'workflow',
      workflow: 'retool-wfuuid',
      input: '{"order": {{ orders.selectedRow.id }}}',
      mode: 'sync',
      run: 'manual',
    })
    expect(report.workflows).toEqual([
      { key: 'wf-uuid', slug: 'retool-wfuuid', mapped: false, usedBy: ['startFlow'] },
    ])
    expect(report.entries.find((e) => e.retool === 'startFlow')).toMatchObject({ status: 'approximated' })
    const mapped = convertApp(sample(), { workflows: { 'wf-uuid': 'place-order' } })
    expect(mapped.definition.queries.find((x) => x.name === 'startFlow')).toMatchObject({
      workflow: 'place-order',
    })
    expect(mapped.report.workflows).toEqual([
      { key: 'wf-uuid', slug: 'place-order', mapped: true, usedBy: ['startFlow'] },
    ])
    expect(report.entries.find((e) => e.retool === 'url')).toMatchObject({ name: 'url_' })
  })

  it('leaves only what Retool itself would fail on', () => {
    const errors = validateApp(definition).diagnostics.filter((d) => d.severity === 'error')
    expect([...new Set(errors.map((d) => d.message))].sort()).toEqual([
      // In the query's own SQL, `shop` isn't passed by any trigger: Retool would fail on it too.
      '"extra" is not defined',
      '"file" is not defined',
      '"shop" is not defined',
    ])
  })
})
