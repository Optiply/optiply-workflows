import { describe, expect, it } from 'vitest'
import { type RetoolApp, RetoolReadError, type RetoolWorkflow, readRetoolExport } from '../src'
import { appExport, appTemplate, plugin, workflowExport, writer } from './fixtures'

const readError = (input: unknown) => {
  try {
    readRetoolExport(input)
  } catch (err) {
    return err instanceof RetoolReadError ? err.code : 'other'
  }
  return 'none'
}

describe('readRetoolExport: apps', () => {
  const exported = appExport(
    [
      plugin('$main', { type: 'frame', subtype: 'Frame', template: { type: 'main', sticky: false } }),
      plugin('container1', {
        subtype: 'ContainerWidget2',
        position: { container: '', row: 2, col: 0, width: 12, height: 10 },
      }),
      plugin('table1', {
        subtype: 'TableWidget2',
        template: { data: '{{ getOrders.data }}', columns: [{ key: 'id', label: 'ID' }] },
        position: {
          container: 'container1',
          subcontainer: 'view1',
          row: 0,
          col: 2,
          width: 8,
          height: 6,
          tabNum: 1,
        },
      }),
      plugin('getOrders', {
        type: 'datasource',
        subtype: 'SqlQueryUnified',
        resourceName: 'b1c2-resource-uuid',
        template: { query: 'select * from orders', runWhenPageLoads: true },
      }),
      plugin('state1', { type: 'state', subtype: 'State', template: { value: '[]' } }),
    ],
    { customDocumentTitle: 'Orders', customDocumentTitleEnabled: true, appStyles: '.x { color: red }' },
  )

  it('reads the parts, their settings and where they sit', () => {
    const app = readRetoolExport(JSON.stringify(exported), {
      fileName: 'exports/Order%20Desk%20-%20v2.json',
    }) as RetoolApp
    expect(app).toMatchObject({
      kind: 'app',
      uuid: '00000000-0000-4000-8000-000000000001',
      name: 'Order Desk - v2',
      rootScreen: null,
      settings: { title: 'Orders', maxWidth: '100%', css: '.x { color: red }', theme: null },
      modules: {},
      updatedAt: '2026-11-02T10:00:00.000Z',
    })
    expect(app.plugins.map((p) => `${p.type}/${p.subtype}/${p.id}`)).toEqual([
      'frame/Frame/$main',
      'widget/ContainerWidget2/container1',
      'widget/TableWidget2/table1',
      'datasource/SqlQueryUnified/getOrders',
      'state/State/state1',
    ])
    const table = app.plugins[2]!
    expect(table.template).toEqual({ data: '{{ getOrders.data }}', columns: [{ key: 'id', label: 'ID' }] })
    expect(table.position).toEqual({
      container: 'container1',
      subcontainer: 'view1',
      rowGroup: 'body',
      row: 0,
      col: 2,
      width: 8,
      height: 6,
      tabNum: 1,
      stack: null,
    })
    expect(app.plugins[1]!.position?.container).toBeNull()
    expect(app.plugins[3]).toMatchObject({
      resourceName: 'b1c2-resource-uuid',
      position: null,
      uuid: 'uuid-getOrders',
    })
  })

  it('names an app from its title, then a default, when there is no file name', () => {
    expect((readRetoolExport(exported) as RetoolApp).name).toBe('Orders')
    expect((readRetoolExport(appExport([])) as RetoolApp).name).toBe('Retool app')
  })
})

describe('readRetoolExport: workflows', () => {
  const blocks = [
    {
      uuid: 'b-start',
      pluginId: 'startTrigger',
      blockType: 'webhook',
      top: 0,
      left: 0,
      options: {},
      incomingOnSuccessEdges: [],
    },
    {
      uuid: 'b-query',
      pluginId: 'getOrder',
      blockType: 'default',
      editorType: 'SqlQueryUnified',
      resourceName: 'db-uuid',
      top: 200,
      left: 40,
      dimensions: { width: 400, height: 300 },
      retryPolicy: { numAttempts: 3, initialIntervalMs: 1000 },
      comment: { body: 'Reads the order', visible: true, pluginId: 'getOrder' },
      incomingOnSuccessEdges: ['b-start'],
    },
    {
      uuid: 'b-branch',
      pluginId: 'branch1',
      blockType: 'conditional',
      options: {
        conditions: [{ id: 'c1', type: 'if', statement: 'getOrder.data.length > 0', outgoingPortId: 'p-if' }],
      },
      outgoingPorts: [
        { id: 'p-if', name: 'if', type: 'conditional' },
        { id: 'p-else', name: 'else', type: 'conditional' },
      ],
      incomingOnSuccessEdges: ['b-query'],
    },
    {
      uuid: 'b-reply',
      pluginId: 'response1',
      blockType: 'webhookReturn',
      options: { body: '{{ getOrder.data }}', status: '200' },
      incomingPorts: [{ portId: 'p-if', blockId: 'b-branch' }],
      failureCondition: 'false',
    },
  ]
  const templates = [
    plugin('startTrigger', { type: 'datasource', subtype: 'JavascriptQuery' }),
    plugin('getOrder', {
      type: 'datasource',
      subtype: 'SqlQueryUnified',
      resourceName: 'db-uuid',
      template: { query: 'select * from orders where id = {{ startTrigger.data.orderId }}' },
    }),
    plugin('branch1', { type: 'datasource', subtype: 'JavascriptQuery' }),
  ]
  const fnBlocks = [
    { uuid: 'f-code', pluginId: 'double', blockType: 'code', top: 0, left: 0, incomingOnSuccessEdges: [] },
  ]
  const exported = workflowExport(blocks, templates, {
    subflows: [
      {
        id: 'fn-1',
        parameters: [{ id: 'p1', name: 'n', exampleValue: '2' }],
        blockData: fnBlocks,
        // A function's template is an app template of its own.
        templateData: writer.toJSON(
          appTemplate([
            plugin('double', {
              type: 'datasource',
              subtype: 'JavascriptQuery',
              template: { query: 'return params.n * 2' },
            }),
          ]),
        ),
      },
    ],
  })

  it('reads blocks with their settings, edges, ports, retries and comments', () => {
    const wf = readRetoolExport(JSON.stringify(exported)) as RetoolWorkflow
    expect(wf).toMatchObject({
      kind: 'workflow',
      uuid: null,
      name: 'Sync orders',
      enabled: true,
      timezone: 'Europe/Amsterdam',
      crontab: null,
      setupScript: { javascript: 'const ONE = 1', python: '' },
      libraries: [{ name: 'lodash', version: '4.17.21', variable: '_', language: 'javascript' }],
      webhooks: [
        {
          uuid: 'hook-1',
          name: 'webhook',
          inputSchema: { properties: [{ key: 'orderId', type: 'string' }] },
          exampleInput: '{"orderId":"A1"}',
          useHeaderApiKey: true,
        },
      ],
    })
    expect(wf.blocks.map((b) => [b.name, b.blockType, b.incoming])).toEqual([
      ['startTrigger', 'webhook', []],
      ['getOrder', 'default', ['b-start']],
      ['branch1', 'conditional', ['b-query']],
      ['response1', 'webhookReturn', []],
    ])
    expect(wf.blocks[1]).toMatchObject({
      editorType: 'SqlQueryUnified',
      top: 200,
      left: 40,
      width: 400,
      height: 300,
      retry: { attempts: 3, intervalMs: 1000 },
      comment: 'Reads the order',
      resourceName: 'db-uuid',
      plugin: { template: { query: 'select * from orders where id = {{ startTrigger.data.orderId }}' } },
    })
    expect(wf.blocks[2]!.outgoingPorts.map((p) => p.name)).toEqual(['if', 'else'])
    expect(wf.blocks[3]).toMatchObject({
      incomingPorts: [{ portId: 'p-if', blockId: 'b-branch' }],
      failureCondition: 'false',
      options: { status: '200' },
      // No template for it: settings live in the block's options.
      plugin: null,
      width: null,
      retry: null,
    })
  })

  it('reads functions with their parameters and blocks', () => {
    const wf = readRetoolExport(exported) as RetoolWorkflow
    expect(wf.functions).toEqual([
      {
        id: 'fn-1',
        parameters: [{ id: 'p1', name: 'n', exampleValue: '2' }],
        blocks: [
          expect.objectContaining({
            name: 'double',
            blockType: 'code',
            plugin: expect.objectContaining({ template: { query: 'return params.n * 2' } }),
          }),
        ],
      },
    ])
  })
})

describe('readRetoolExport: other files', () => {
  it('says what is wrong with a file that is not a Retool export', () => {
    expect(readError('not json')).toBe('not_json')
    expect(readError('{"name": "a workflow of something else"}')).toBe('not_retool')
    expect(readError([1, 2])).toBe('not_retool')
    expect(readError({ page: { data: { appState: '["^ ", "^9", 1]' } } })).toBe('unreadable')
    expect(readError({ page: { data: { appState: '["^ ", "x", 1]' } } })).toBe('unreadable')
    expect(readError({ blockData: [], templateData: '{' })).toBe('unreadable')
  })
})
