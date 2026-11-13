import { describe, expect, it } from 'vitest'
import { convertApp, type RetoolApp, readRetoolExport } from '../src'
import { appExport, plugin } from './fixtures'

const at = (row: number) => ({ container: '', row, col: 0, width: 6, height: 1 })
const h = (event: string, type: string, method: string, extra: Record<string, unknown> = {}) => ({
  event,
  type,
  method,
  waitType: 'debounce',
  waitMs: '0',
  ...extra,
})

/** Retool event handlers of every kind the samples have. No real data. */
function sample(): RetoolApp {
  return readRetoolExport(
    appExport([
      plugin('modal1', { type: 'frame', subtype: 'ModalFrameWidget', template: {} }),
      plugin('orders', { subtype: 'TableWidget2', template: { data: '[]' }, position: at(0) }),
      plugin('tabs', { subtype: 'ContainerWidget2', template: { _viewKeys: ['A', 'B'] }, position: at(2) }),
      plugin('active', {
        subtype: 'SwitchWidget2',
        template: {
          events: [
            h('true', 'datasource', 'trigger', { pluginId: 'load' }),
            h('false', 'script', 'run', {
              params: { src: 'self.setValue(true)' },
              enabled: '{{ orders.selectedRow }}',
            }),
          ],
        },
        position: at(4),
      }),
      plugin('go', {
        subtype: 'ButtonWidget2',
        template: {
          text: 'Go',
          events: [
            h('click', 'datasource', 'trigger', {
              pluginId: 'save',
              params: {
                options: {
                  additionalScope: {
                    row: '{{ orders.selectedRow }}',
                    note: 'id {{ orders.selectedRow.id }}',
                  },
                },
              },
              waitMs: '300',
            }),
            h('click', 'widget', 'show', { pluginId: 'modal1', params: { options: { block: 'center' } } }),
            h('click', 'widget', 'setCurrentViewIndex', { pluginId: 'tabs', params: { viewIndex: 1 } }),
            h('click', 'state', 'setValue', { pluginId: 'picked', params: { value: '{{ self.text }}' } }),
            h('click', 'util', 'openUrl', {
              params: { url: 'https://example.com/{{ orders.selectedRow.id }}', options: { newTab: true } },
            }),
            h('click', 'util', 'copyToClipboard', { params: { value: 'copied' } }),
            h('click', 'localStorage', 'setValue', { params: { key: 'k', value: '{{ 1 }}' } }),
            h('click', 'widget', 'refresh', { pluginId: 'orders' }),
          ],
        },
        position: at(5),
      }),
      plugin('table2', {
        subtype: 'TableWidget2',
        template: {
          data: '[]',
          events: [
            h('selectRow', 'datasource', 'trigger', { pluginId: 'load' }),
            h('clickToolbar', 'widget', 'exportData', { pluginId: 'table2', targetId: 'tb1' }),
          ],
        },
        position: at(6),
      }),
      plugin('nav', {
        subtype: 'NavigationWidget2',
        template: {
          _ids: ['i1', 'i2'],
          _labels: ['Home', 'Docs'],
          _screenTargetByIndex: ['', ''],
          events: [
            h('click', 'script', 'run', { targetId: 'i1', params: { src: "tabs.setCurrentView('A')" } }),
            h('click', 'util', 'openUrl', { targetId: 'i2', params: { url: 'https://docs.example.com' } }),
          ],
        },
        position: at(7),
      }),
      plugin('load', {
        type: 'datasource',
        subtype: 'JavascriptQuery',
        template: {
          query: 'return triggeredById',
          events: [h('success', 'widget', 'exportData', { pluginId: 'orders' })],
        },
      }),
      plugin('save', {
        type: 'datasource',
        subtype: 'SqlQueryUnified',
        template: { query: 'update t set n = {{ note }} where id = {{ row.id }}' },
        resourceName: 'db',
      }),
      plugin('picked', { type: 'state', subtype: 'State', template: { value: '' } }),
    ]),
  ) as RetoolApp
}

describe('convertApp: event handlers', () => {
  const { definition, report } = convertApp(sample(), { resources: { db: 'orders_db' } })
  const events = (name: string) =>
    [...definition.components, ...definition.queries].find((x) => x.name === name)?.events ?? []

  it('maps a switch’s true and false to change, with conditions', () => {
    expect(events('active')).toEqual([
      {
        id: 'h1',
        event: 'change',
        action: { type: 'controlQuery', query: 'load', method: 'trigger' },
        onlyIf: '{{ active.value }}',
      },
      {
        id: 'h2',
        event: 'change',
        action: { type: 'runScript', code: 'active.setValue(true)' },
        onlyIf: '{{ (!active.value) && (orders.selectedRow) }}',
      },
    ])
  })

  it('maps queries, components, state, utils and local storage', () => {
    expect(events('go')).toEqual([
      {
        id: 'h1',
        event: 'click',
        action: {
          type: 'runScript',
          code: 'await save.trigger({ additionalScope: { "row": (orders.selectedRow), "note": `id ${orders.selectedRow.id}` } })',
        },
        debounceMs: 300,
      },
      { id: 'h2', event: 'click', action: { type: 'controlComponent', component: 'modal1', method: 'open' } },
      {
        id: 'h3',
        event: 'click',
        action: {
          type: 'controlComponent',
          component: 'tabs',
          method: 'setCurrentViewIndex',
          args: ['{{ 1 }}'],
        },
      },
      {
        id: 'h4',
        event: 'click',
        action: { type: 'setVariable', variable: 'picked', value: '{{ go.text }}' },
      },
      {
        id: 'h5',
        event: 'click',
        action: { type: 'openUrl', url: 'https://example.com/{{ orders.selectedRow.id }}', newTab: true },
      },
      { id: 'h6', event: 'click', action: { type: 'copyToClipboard', text: 'copied' } },
      { id: 'h7', event: 'click', action: { type: 'setLocalStorage', key: 'k', value: '{{ 1 }}' } },
    ])
    expect(report.entries.find((e) => e.retool === 'go')?.notes).toContain(
      'Not imported: its click handler (widget.refresh)',
    )
    // The trigger's additionalScope declares the query's scope.
    expect(definition.queries.find((q) => q.name === 'save')?.scope).toEqual(['note', 'row'])
  })

  it('maps table and query events, and leaves out the toolbar', () => {
    expect(events('table2')).toEqual([
      { id: 'h1', event: 'rowSelect', action: { type: 'controlQuery', query: 'load', method: 'trigger' } },
    ])
    expect(events('load')).toEqual([
      {
        id: 'h1',
        event: 'success',
        action: { type: 'download', data: '{{ orders.data }}', fileName: 'orders.csv' },
      },
    ])
    expect(definition.queries.find((q) => q.name === 'load')?.scope).toEqual(['triggeredById'])
  })

  it('turns navigation links that ran handlers into action links', () => {
    const nav = definition.components.find((c) => c.name === 'nav')
    expect(nav?.props?.items).toEqual([
      { key: 'i1', label: 'Home' },
      { key: 'i2', label: 'Docs' },
    ])
    expect(nav?.events).toEqual([
      {
        id: 'h1',
        event: 'click',
        action: { type: 'runScript', code: "tabs.setCurrentView('A')" },
        onlyIf: '{{ nav.clickedItem === "i1" }}',
      },
      {
        id: 'h2',
        event: 'click',
        action: { type: 'openUrl', url: 'https://docs.example.com' },
        onlyIf: '{{ nav.clickedItem === "i2" }}',
      },
    ])
  })

  it('validates, once the export is complete', () => {
    expect(report.diagnostics).toEqual([])
  })
})
