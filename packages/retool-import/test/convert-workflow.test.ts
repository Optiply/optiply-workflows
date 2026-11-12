import { validateDefinition } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import { convertWorkflow, type RetoolWorkflow, readRetoolExport } from '../src'
import { appTemplate, plugin, workflowExport, writer } from './fixtures'

const js = (id: string, query: string, template: Record<string, unknown> = {}) =>
  plugin(id, { type: 'datasource', subtype: 'JavascriptQuery', template: { query, ...template } })

const TOKEN = 'sk_live_51HxAbCdEfGhIjKlMnOp'

/** A synthetic workflow with every block kind the samples have, and the awkward cases. */
function sample(): RetoolWorkflow {
  const blocks = [
    {
      uuid: 'u-start',
      pluginId: 'startTrigger',
      blockType: 'webhook',
      top: 0,
      left: 0,
      options: {},
      incomingOnSuccessEdges: [],
    },
    {
      uuid: 'u-orders',
      pluginId: 'getOrders',
      blockType: 'default',
      editorType: 'SqlQueryUnified',
      resourceName: 'db-uuid',
      top: 0,
      left: 400,
      dimensions: { width: 500, height: 300 },
      retryPolicy: { numAttempts: 2, initialIntervalMs: 1000 },
      comment: { body: 'All open orders', visible: true },
      incomingOnSuccessEdges: ['u-start'],
    },
    {
      uuid: 'u-moment',
      pluginId: 'moment',
      blockType: 'code',
      editorType: 'JavascriptQuery',
      top: 0,
      left: 800,
      incomingOnSuccessEdges: ['u-orders'],
    },
    {
      uuid: 'u-branch',
      pluginId: 'branch1',
      blockType: 'conditional',
      editorType: 'JavascriptQuery',
      top: 0,
      left: 1200,
      options: {
        conditions: [
          { id: 'x1', type: 'if', statement: 'moment.data.count > 0', outgoingPortId: 'p-if' },
          { id: 'x2', type: 'else', statement: '', outgoingPortId: 'p-else' },
        ],
      },
      outgoingPorts: [
        { id: 'p-if', name: '0', type: 'conditional' },
        { id: 'p-else', name: '1', type: 'conditional' },
      ],
      incomingOnSuccessEdges: ['u-moment'],
    },
    {
      uuid: 'u-filter',
      pluginId: 'openOnly',
      blockType: 'filter',
      editorType: 'JavascriptQuery',
      top: 0,
      left: 1600,
      options: { blockToIterate: 'u-orders', filterStatement: 'value.status === "open"' },
      incomingPorts: [{ portId: 'p-if', blockId: 'u-branch' }],
    },
    {
      uuid: 'u-loop',
      pluginId: 'notifyEach',
      blockType: 'loop',
      editorType: 'RESTQuery',
      top: 0,
      left: 2000,
      options: {
        iterable: 'u-filter',
        executionMode: 'sequential',
        batchConfig: { batchSize: 1, delayInMs: 10 },
        iterationErrorConfig: { errorPolicy: 'ignore' },
        functionId: 'u-fn-notify',
        functionParameters: { 'p-order': '{{ value.id }}' },
      },
      incomingOnSuccessEdges: ['u-filter'],
    },
    {
      uuid: 'u-post',
      pluginId: 'postSummary',
      blockType: 'default',
      editorType: 'RESTQuery',
      resourceName: 'REST-WithoutResource',
      top: 0,
      left: 2400,
      incomingOnSuccessEdges: ['u-loop'],
    },
    {
      uuid: 'u-reply',
      pluginId: 'response1',
      blockType: 'webhookReturn',
      editorType: 'JavascriptQuery',
      top: 0,
      left: 2800,
      options: { body: 'postSummary.data', status: '201' },
      incomingOnSuccessEdges: ['u-post'],
    },
    {
      uuid: 'u-wait',
      pluginId: 'pause1',
      blockType: 'wait',
      top: 300,
      left: 1600,
      options: {},
      incomingPorts: [{ portId: 'p-else', blockId: 'u-branch' }],
    },
    {
      uuid: 'u-old',
      pluginId: 'old_code',
      blockType: 'code',
      editorType: 'JavascriptQuery',
      top: 600,
      left: 0,
      incomingOnSuccessEdges: [],
    },
    // Function definitions: one a subflow, one a single REST query.
    {
      uuid: 'u-fn-notify',
      pluginId: 'notifyOrder',
      blockType: 'function',
      editorType: 'RESTQuery',
      resourceName: 'REST-WithoutResource',
      top: 900,
      left: 0,
      options: { subflowId: 'sub-1', parameters: [{ id: 'p-order', name: 'orderId', exampleValue: '42' }] },
      incomingOnSuccessEdges: [],
    },
    {
      uuid: 'u-fn-fetch',
      pluginId: 'fetchPage',
      blockType: 'function',
      editorType: 'RESTQuery',
      resourceName: 'REST-WithoutResource',
      top: 900,
      left: 400,
      options: { parameters: [{ id: 'p-off', name: 'offset', exampleValue: '0' }] },
      incomingOnSuccessEdges: [],
    },
  ]
  const templates = [
    plugin('startTrigger', { type: 'datasource', subtype: 'JavascriptQuery' }),
    plugin('getOrders', {
      type: 'datasource',
      subtype: 'SqlQueryUnified',
      resourceName: 'db-uuid',
      template: {
        query: "select * from orders where note = '{{ startTrigger.data.note.replace(/'/g, \"''\") }}'",
        queryTimeout: 600000,
      },
    }),
    js('moment', 'return { count: getOrders.data.length }'),
    js('branch1', ''),
    js('openOnly', ''),
    plugin('notifyEach', { type: 'datasource', subtype: 'RESTQuery' }),
    plugin('postSummary', {
      type: 'datasource',
      subtype: 'RESTQuery',
      template: {
        type: 'POST',
        query: 'https://hooks.example.com/summary?api_key=abcdef0123456789',
        headers: JSON.stringify([
          { key: 'Authorization', value: `Bearer ${TOKEN}` },
          { key: 'X-Run', value: '{{ workflowContext.workflowId }}' },
        ]),
        bodyType: 'json',
        body: JSON.stringify([
          { key: 'count', value: '{{ moment.data.count }}' },
          { key: 'title', value: 'Orders for "{{ startTrigger.data.shop }}"' },
        ]),
      },
    }),
    js('response1', ''),
    js('old_code', 'return 1'),
    plugin('fetchPage', {
      type: 'datasource',
      subtype: 'RESTQuery',
      template: {
        type: 'GET',
        query: 'https://api.example.com/items?offset={{ offset }}',
        headers: '',
        body: '',
        bodyType: 'none',
      },
    }),
  ]
  const subflow = {
    id: 'sub-1',
    parameters: [],
    blockData: [
      {
        uuid: 's-params',
        pluginId: 'params',
        blockType: 'webhook',
        top: 0,
        left: 0,
        options: {},
        incomingOnSuccessEdges: [],
      },
      {
        uuid: 's-get',
        pluginId: 'getOrder',
        blockType: 'default',
        editorType: 'SqlQueryUnified',
        resourceName: 'db-uuid',
        top: 0,
        left: 300,
        incomingOnSuccessEdges: ['s-params'],
      },
      {
        uuid: 's-mail',
        pluginId: 'mail',
        blockType: 'code',
        editorType: 'JavascriptQuery',
        top: 0,
        left: 600,
        incomingOnSuccessEdges: ['s-get'],
      },
      {
        uuid: 's-log',
        pluginId: 'log',
        blockType: 'code',
        editorType: 'JavascriptQuery',
        top: 200,
        left: 400,
        incomingOnSuccessEdges: ['s-get'],
      },
    ],
    templateData: writer.toJSON(
      appTemplate([
        plugin('getOrder', {
          type: 'datasource',
          subtype: 'SqlQueryUnified',
          resourceName: 'db-uuid',
          template: { query: 'select * from orders where id = {{ orderId }}' },
        }),
        js('mail', 'return { sent: params.orderId, row: getOrder.data[0], orderId }'),
        js('log', 'return 1'),
      ]),
    ),
  }
  return readRetoolExport(
    workflowExport(blocks, templates, {
      subflows: [subflow],
      customLibraries: [
        { version: '4.17.21', language: 'javascript', variable: '_', codeString: '', libraryName: 'lodash' },
        { version: '3.22.4', language: 'javascript', variable: 'z', codeString: '', libraryName: 'zod' },
      ],
      setupScripts: {
        python: { codeString: '' },
        javascript: { codeString: "const _ = require('lodash')\nconst z = require('zod')" },
      },
    }),
  ) as RetoolWorkflow
}

describe('convertWorkflow', () => {
  const { definition, report } = convertWorkflow(sample(), { resources: { 'db-uuid': 'orders_db' } })
  const block = (name: string, fn?: string) =>
    (fn ? definition.functions!.find((f) => f.name === fn)!.blocks : definition.blocks).find(
      (b) => b.name === name,
    )

  it('builds a workflow our validator accepts', () => {
    expect(validateDefinition(definition).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(report.diagnostics).toEqual([])
  })

  it('converts each block kind', () => {
    expect(definition.blocks.map((b) => [b.name, b.type])).toEqual([
      ['startTrigger', 'startTrigger'],
      ['getOrders', 'resourceQuery'],
      ['moment_', 'code'],
      ['branch1', 'branch'],
      ['openOnly', 'filter'],
      ['notifyEach', 'loop'],
      ['postSummary', 'resourceQuery'],
      ['response1', 'response'],
      ['pause1', 'code'],
    ])
    expect(block('getOrders')).toEqual({
      name: 'getOrders',
      type: 'resourceQuery',
      description: 'All open orders',
      settings: { retry: { count: 2, intervalMs: 1000 }, timeoutMs: 600000 },
      config: {
        resource: 'orders_db',
        query: {
          sql: "select * from orders where note = '{{ startTrigger.data.note.replace(/'/g, \"''\") }}'",
        },
      },
    })
    expect(block('branch1')).toMatchObject({
      config: { conditions: [{ id: 'c1', expression: 'moment_.data.count > 0' }] },
    })
    expect(block('openOnly')).toMatchObject({
      config: { input: '{{ getOrders.data }}', condition: 'value.status === "open"' },
    })
    expect(block('notifyEach')).toEqual({
      name: 'notifyEach',
      type: 'loop',
      config: {
        input: '{{ openOnly.data }}',
        runner: { kind: 'function', function: 'notifyOrder', params: { orderId: '{{ value.id }}' } },
        mode: 'batch',
        batchSize: 1,
        batchDelayMs: 10,
        onError: 'continue',
      },
    })
    expect(block('response1')).toMatchObject({ config: { status: '201', body: '{{ postSummary.data }}' } })
    expect(block('pause1')).toMatchObject({
      type: 'code',
      config: { code: expect.stringContaining('throw new Error') },
    })
  })

  it('wires success edges and branch ports, and keeps the canvas positions', () => {
    expect(definition.edges).toEqual(
      expect.arrayContaining([
        { from: 'startTrigger', port: 'out', to: 'getOrders' },
        { from: 'moment_', port: 'out', to: 'branch1' },
        { from: 'branch1', port: 'cond:c1', to: 'openOnly' },
        { from: 'branch1', port: 'else', to: 'pause1' },
        { from: 'postSummary', port: 'out', to: 'response1' },
      ]),
    )
    expect(definition.layout?.blocks?.getOrders).toEqual({ x: 400, y: 0, w: 500 })
  })

  it('renames a name reserved here, with its references', () => {
    expect(block('moment_')).toMatchObject({
      config: { code: 'return { count: getOrders.data.length }' },
    })
    expect(report.entries.find((e) => e.retool === 'moment')).toMatchObject({
      name: 'moment_',
      status: 'converted',
    })
  })

  it('turns a REST query without a resource into the built-in REST API, secrets into config vars', () => {
    expect(block('postSummary')).toMatchObject({
      config: {
        resource: 'rest_api',
        query: {
          method: 'POST',
          url: 'https://hooks.example.com/summary?api_key={{ configVars.RETOOL_SECRET_1 }}',
          headers: [
            { key: 'Authorization', value: 'Bearer {{ configVars.RETOOL_SECRET_2 }}' },
            { key: 'X-Run', value: '{{ workflowContext.workflowId }}' },
          ],
          body: {
            type: 'json',
            json: '{\n  "count": {{ moment_.data.count }},\n  "title": "Orders for \\"{{ startTrigger.data.shop }}\\""\n}',
          },
          auth: { type: 'none' },
        },
      },
    })
    expect(report.secrets).toEqual([
      { where: 'postSummary URL', configVar: 'RETOOL_SECRET_1' },
      { where: 'postSummary header Authorization', configVar: 'RETOOL_SECRET_2' },
    ])
    const everything = JSON.stringify({ definition, report })
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('abcdef0123456789')
  })

  it('gives the same secret the same config var', () => {
    const wf = sample()
    const fetchPage = wf.blocks.find((b) => b.name === 'fetchPage')!
    fetchPage.plugin!.template.headers = JSON.stringify([{ key: 'Authorization', value: `Bearer ${TOKEN}` }])
    expect(convertWorkflow(wf).report.secrets).toEqual([
      { where: 'postSummary URL', configVar: 'RETOOL_SECRET_1' },
      { where: 'postSummary header Authorization', configVar: 'RETOOL_SECRET_2' },
      { where: 'fetchPage header Authorization', configVar: 'RETOOL_SECRET_2' },
    ])
  })

  it('converts functions: a subflow and a single query, parameters read as params', () => {
    const notify = definition.functions!.find((f) => f.name === 'notifyOrder')!
    expect(notify.params).toEqual([{ name: 'orderId', testValue: 42 }])
    expect(notify.blocks.map((b) => b.name)).toEqual(['getOrder', 'mail', 'log'])
    expect(notify.edges).toEqual([
      { from: 'getOrder', port: 'out', to: 'mail' },
      { from: 'getOrder', port: 'out', to: 'log' },
    ])
    expect(notify.returns).toBe('mail')
    expect(block('getOrder', 'notifyOrder')).toMatchObject({
      config: { query: { sql: 'select * from orders where id = {{ params.orderId }}' } },
    })
    expect(block('mail', 'notifyOrder')).toMatchObject({
      config: { code: 'return { sent: params.orderId, row: getOrder.data[0], orderId: params.orderId }' },
    })
    const fetch = definition.functions!.find((f) => f.name === 'fetchPage')!
    expect(fetch.blocks).toEqual([
      expect.objectContaining({
        name: 'request',
        type: 'resourceQuery',
        config: expect.objectContaining({
          resource: 'rest_api',
          query: expect.objectContaining({ url: 'https://api.example.com/items?offset={{ params.offset }}' }),
        }),
      }),
    ])
    expect(report.entries.find((e) => e.retool === 'notifyOrder')).toMatchObject({ status: 'approximated' })
  })

  it("skips blocks nothing leads to, since they never ran in Retool, and reports what it couldn't import", () => {
    expect(block('old_code')).toBeUndefined()
    expect(report.entries.find((e) => e.retool === 'old_code')).toMatchObject({
      status: 'skipped',
      became: 'nothing',
    })
    expect(report.entries.find((e) => e.retool === 'pause1')).toMatchObject({
      status: 'unsupported',
      kind: 'wait',
    })
    expect(report.counts).toEqual({ converted: 12, approximated: 1, unsupported: 1, skipped: 1 })
  })

  it('lists the resources to map, with placeholders for unmapped ones', () => {
    expect(report.resources).toEqual([
      {
        key: 'db-uuid',
        label: 'db-uuid',
        kind: 'sql',
        slug: 'orders_db',
        mapped: true,
        usedBy: ['getOrders', 'notifyOrder.getOrder'],
      },
      {
        key: 'REST-WithoutResource',
        label: 'REST API (built in)',
        kind: 'rest',
        slug: 'rest_api',
        mapped: true,
        usedBy: ['postSummary', 'fetchPage'],
      },
    ])
    const unmapped = convertWorkflow(sample()).report.resources[0]!
    expect(unmapped).toMatchObject({ key: 'db-uuid', slug: 'retool_db_uuid', mapped: false })
  })

  it('imports extra libraries as JavaScript packages and drops a setup script that only loads them', () => {
    expect(definition.settings).toEqual({ javascript: { packages: ['zod@3.22.4'] } })
    expect(report.notes).toContain(
      'Retool libraries zod became JavaScript packages, imported where code uses them',
    )
    expect(definition.triggers).toEqual({
      webhook: { enabled: true, bodySchema: { type: 'object', properties: { orderId: { type: 'string' } } } },
    })
  })
})
