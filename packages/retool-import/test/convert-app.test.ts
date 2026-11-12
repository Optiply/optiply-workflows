import { validateApp } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { convertApp, type RetoolApp, readRetoolExport } from '../src'
import { appExport, plugin } from './fixtures'

const at = (
  container: string,
  row: number,
  col: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
) => ({
  container,
  row,
  col,
  width,
  height,
  ...extra,
})
const stacked = (
  container: string,
  subcontainer: string,
  ordinal: number,
  width: number,
  extra: Record<string, unknown> = {},
) => ({
  container,
  subcontainer,
  row: 0,
  col: 0,
  width,
  height: 0.2,
  stackPosition: { ordinal, widthType: 'fixed', width: 0, height: 0 },
  ...extra,
})

/** A synthetic app: grid and stack layouts, views with tabs, a form, both kinds of modal, a table. No real data. */
function sample(): RetoolApp {
  return readRetoolExport(
    appExport([
      plugin('$main', { type: 'frame', subtype: 'Frame', template: { type: 'main' } }),
      plugin('$header', { type: 'frame', subtype: 'Frame', template: { type: 'header' } }),
      plugin('title', {
        subtype: 'TextWidget2',
        template: { value: '### Orders' },
        position: at('', 0, 0, 12, 0.6, { subcontainer: '$header' }),
      }),
      plugin('tabs1', {
        subtype: 'TabsWidget2',
        template: { targetContainerId: 'details', navigateContainer: true },
        position: at('details', 0, 0, 12, 0.8, { rowGroup: 'header' }),
      }),
      plugin('details', {
        subtype: 'ContainerWidget2',
        template: { _viewKeys: ['Open orders', 'History'], showBorder: true, _direction: 'horizontal' },
        position: at('', 0, 0, 12, 0.2, {
          subcontainer: '$main',
          stackPosition: { ordinal: 0, widthType: 'fixed', width: 0, height: 0 },
        }),
      }),
      plugin('search', {
        subtype: 'TextInputWidget2',
        template: { label: 'Search', placeholder: 'SKU', formDataKey: '{{ self.id }}', value: '' },
        position: stacked('details', 'Open orders', 0, 4),
      }),
      plugin('status', {
        subtype: 'SelectWidget2',
        template: {
          label: 'Status',
          itemMode: 'dynamic',
          data: '{{ statuses.data }}',
          values: '{{ item.code }}',
          labels: '{{ item.name }}',
          value: '{{ self.values[0] }}',
        },
        position: stacked('details', 'Open orders', 1, 4),
      }),
      plugin('orders', {
        subtype: 'TableWidget2',
        template: {
          data: '{{ getOrders.data }}',
          _columnIds: ['a1', 'b2', 'c3'],
          _columnKey: { a1: 'id', b2: 'total', c3: '' },
          _columnLabel: { a1: 'ID', b2: 'Total', c3: 'Customer' },
          _columnFormat: { a1: 'string', b2: 'decimal', c3: 'string' },
          _columnEditable: { a1: false, b2: 'true', c3: '' },
          _columnHidden: { a1: '', b2: '', c3: '{{ !showCustomer.value }}' },
          _columnSize: { a1: 80.5, b2: 120, c3: 0 },
          _columnValueOverride: { a1: '', b2: '', c3: '{{ currentSourceRow.customer.name }}' },
          _columnReferenceId: { a1: '', b2: '', c3: 'customer' },
          _primaryKeyColumnId: 'a1',
          _rowSelection: 'multiple',
          overflowType: 'pagination',
          _templatePageSize: 25,
          _toolbarButtonType: { t1: 'filter', t2: 'custom' },
          _actionIds: ['x1'],
        },
        position: stacked('details', 'Open orders', 2, 12, { height: 8 }),
      }),
      plugin('archive', {
        subtype: 'TextWidget2',
        template: { value: 'Nothing **archived** yet', disableMarkdown: false },
        position: stacked('details', 'History', 0, 12),
      }),
      plugin('form1', {
        subtype: 'FormWidget2',
        template: { resetAfterSubmit: true },
        position: at('', 2, 0, 6, 4, { subcontainer: '$main' }),
      }),
      plugin('note', {
        subtype: 'TextAreaWidget',
        template: { label: 'Note', minLines: '5', hidden: '{{ !form1.data.open }}' },
        position: at('form1', 0, 0, 6, 1),
      }),
      plugin('save', {
        subtype: 'ButtonWidget2',
        template: { text: 'Save', submit: true, submitTargetId: 'form1', disabled: 'false' },
        position: at('form1', 0, 0, 2, 1, { rowGroup: 'footer' }),
      }),
      plugin('modalFrame1', {
        type: 'frame',
        subtype: 'ModalFrameWidget',
        template: { size: 'large', overlayInteraction: true },
      }),
      plugin('modalTitle', {
        subtype: 'TextWidget2',
        template: { value: '#### Edit order' },
        position: at('', 0, 0, 12, 0.6, { subcontainer: 'modalFrame1', rowGroup: 'header' }),
      }),
      plugin('qty', {
        subtype: 'NumberInputWidget',
        template: { label: 'Quantity', value: '1', min: '0', format: 'percent' },
        position: at('', 0, 0, 6, 0.2, { subcontainer: 'modalFrame1' }),
      }),
      plugin('help', {
        subtype: 'ModalWidget',
        template: { buttonText: 'Help' },
        position: at('', 4, 6, 2, 1, { subcontainer: '$main' }),
      }),
      plugin('helpText', {
        subtype: 'TextWidget2',
        template: { value: 'Call us' },
        position: at('help', 0, 0, 12, 0.6),
      }),
      plugin('chat1', {
        subtype: 'ChatWidget',
        template: {},
        position: at('', 8, 0, 6, 4, { subcontainer: '$main' }),
      }),
      plugin('wizard', {
        subtype: 'ContainerWidget2',
        template: { _viewKeys: ['Step 1', 'Step 2'], showHeader: false },
        position: at('', 12, 0, 12, 6, { subcontainer: '$main' }),
      }),
      plugin('wizardTitle', {
        subtype: 'TextWidget2',
        template: { value: 'Container title' },
        position: at('wizard', 0, 0, 12, 0.6, { rowGroup: 'header' }),
      }),
      plugin('refresh', {
        subtype: 'ButtonWidget2',
        template: { text: '', iconBefore: 'bold/interface-arrows-synchronize' },
        position: at('wizard', 0, 0, 1, 1, { subcontainer: 'Step 1' }),
      }),
      plugin('getOrders', {
        type: 'datasource',
        subtype: 'SqlQueryUnified',
        template: { query: 'select 1' },
      }),
    ]),
    { fileName: 'Order%20Desk.json' },
  ) as RetoolApp
}

describe('convertApp: components and layout', () => {
  const { definition, report } = convertApp(sample())
  const c = (name: string) => definition.components.find((x) => x.name === name)

  it('converts each component kind, and drops frames and the tabs that became a container’s', () => {
    expect(definition.components.map((x) => [x.name, x.type])).toEqual([
      ['title', 'text'],
      ['details', 'container'],
      ['search', 'textInput'],
      ['status', 'select'],
      ['orders', 'table'],
      ['archive', 'text'],
      ['form1', 'form'],
      ['note', 'textArea'],
      ['save', 'button'],
      ['modalFrame1', 'modal'],
      ['modalTitle', 'text'],
      ['qty', 'numberInput'],
      ['help', 'modal'],
      ['helpText', 'text'],
      ['chat1', 'alert'],
      ['wizard', 'container'],
      ['wizardTitle', 'text'],
      ['refresh', 'button'],
      ['helpButton', 'button'],
    ])
    expect(report.entries.find((e) => e.retool === 'tabs1')).toMatchObject({
      became: 'nothing',
      status: 'approximated',
    })
    expect(report.entries.find((e) => e.retool === 'chat1')).toMatchObject({ status: 'unsupported' })
  })

  it('maps props: markdown text, inputs, options from data, self', () => {
    expect(c('title')?.props).toEqual({ value: '### Orders', markdown: true })
    expect(c('search')?.props).toEqual({ label: 'Search', placeholder: 'SKU' })
    expect(c('status')?.props).toEqual({
      label: 'Status',
      options: '{{ (statuses.data || []).map((item, i) => ({ value: item.code, label: item.name })) }}',
      defaultValue: '{{ status.values[0] }}',
    })
    expect(c('note')?.props).toEqual({ label: 'Note', rows: 5, hidden: '{{ !form1.data.open }}' })
    // `false` where ours defaults to false is left out; where ours defaults to true it's kept.
    expect(c('save')?.props).toEqual({ text: 'Save' })
    expect(c('refresh')?.props).toEqual({ text: 'Arrows synchronize' })
    expect(c('wizard')?.props).toEqual({
      views: [
        { name: 'step1', label: 'Step 1' },
        { name: 'step2', label: 'Step 2' },
      ],
      showTabs: false,
    })
    expect(c('wizardTitle')).toMatchObject({ slot: 'header', props: { hidden: true } })
    expect(c('qty')?.props).toEqual({ label: 'Quantity', defaultValue: 1, min: 0 })
    expect(report.entries.find((e) => e.retool === 'qty')).toMatchObject({ status: 'approximated' })
  })

  it("builds a table's columns from Retool's per-column settings", () => {
    expect(c('orders')?.props).toEqual({
      data: '{{ getOrders.data }}',
      columns: [
        { key: 'id', label: 'ID', width: 81 },
        { key: 'total', label: 'Total', type: 'number', editable: true, width: 120 },
        {
          key: 'customer',
          label: 'Customer',
          hidden: '{{ !showCustomer.value }}',
          value: '{{ currentRow.customer.name }}',
        },
      ],
      primaryKey: 'id',
      rowSelection: 'multiple',
      showFilters: true,
      paging: 'pages',
      pageSize: 25,
    })
    expect(report.entries.find((e) => e.retool === 'orders')?.notes).toEqual([
      "Its 1 row action button(s) weren't imported: use a column or a button outside",
      "Its toolbar's custom buttons (Download, Refresh…) weren't imported",
      '1 computed column(s): check they read currentRow',
    ])
  })

  it('puts children in their containers, views, forms and modals', () => {
    expect(c('details')?.props).toMatchObject({
      views: [
        { name: 'openOrders', label: 'Open orders' },
        { name: 'history', label: 'History' },
      ],
    })
    expect(c('details')?.props?.showTabs).toBeUndefined()
    expect(c('search')).toMatchObject({ parent: 'details', slot: 'openOrders' })
    expect(c('archive')).toMatchObject({ parent: 'details', slot: 'history' })
    expect(c('note')).toMatchObject({ parent: 'form1' })
    expect(c('save')).toMatchObject({ parent: 'form1' })
    expect(c('qty')).toMatchObject({ parent: 'modalFrame1' })
    expect(c('helpText')).toMatchObject({ parent: 'help' })
    expect(c('helpButton')).toMatchObject({
      props: { text: 'Help' },
      events: [{ event: 'click', action: { type: 'controlComponent', component: 'help', method: 'open' } }],
    })
  })

  it('lays out stacks in order, wrapping at 12 columns, and stacks a header over its body', () => {
    const l = definition.layout!
    expect(l.search).toEqual({ x: 0, y: 0, w: 4, h: 3 })
    expect(l.status).toEqual({ x: 4, y: 0, w: 4, h: 3 })
    expect(l.orders).toEqual({ x: 0, y: 3, w: 12, h: 20 })
    // The header frame's title sits above the page's content.
    expect(l.title).toEqual({ x: 0, y: 0, w: 12, h: 3 })
    expect(l.details!.y).toBeGreaterThanOrEqual(3)
    // Modals have no place on the page; the modal widget's place is its button's.
    expect(l.modalFrame1).toBeUndefined()
    expect(l.help).toBeUndefined()
    expect(l.helpButton).toMatchObject({ x: 6, w: 2 })
    // In a modal: the header first, then the body.
    expect(l.qty!.y).toBeGreaterThanOrEqual(l.modalTitle!.y + l.modalTitle!.h)
    // In a form: the footer below the body.
    expect(l.save!.y).toBeGreaterThanOrEqual(l.note!.y + l.note!.h)
    // A container is as tall as its content.
    expect(l.details!.h).toBeGreaterThanOrEqual(23)
  })

  it('gives a definition whose only problems are the queries step 4 adds', () => {
    const problems = validateApp(definition).diagnostics.filter((d) => d.severity === 'error')
    expect([...new Set(problems.map((d) => d.code))]).toEqual(['unknown_identifier'])
    expect([...new Set(problems.map((d) => d.message))].sort()).toEqual([
      '"getOrders" is not defined',
      '"showCustomer" is not defined',
      '"statuses" is not defined',
    ])
  })
})
