/// <reference path="./transit-immutable-js.d.ts" />
/**
 * Synthetic Retool exports, written with the libraries Retool itself uses (Immutable records through
 * transit-immutable-js), so the reader is tested against the real encoder, cache codes included. No real data.
 */
import Immutable from 'immutable'
import transit from 'transit-immutable-js'

export const Position2 = Immutable.Record(
  {
    type: 'grid',
    container: '',
    rowGroup: 'body',
    subcontainer: '',
    row: 0,
    col: 0,
    height: 1,
    width: 1,
    tabNum: 0,
    stackPosition: null,
  },
  'position2',
)

export const PluginTemplate = Immutable.Record(
  {
    id: '',
    uuid: '',
    _comment: null,
    type: 'widget',
    subtype: '',
    namespace: null,
    resourceName: null,
    resourceDisplayName: null,
    template: Immutable.Map(),
    style: Immutable.Map(),
    position2: null,
    mobilePosition2: null,
    container: '',
    screen: null,
    folder: '',
    createdAt: null,
    updatedAt: null,
  },
  'pluginTemplate',
)

export const AppTemplate = Immutable.Record(
  {
    appMaxWidth: '100%',
    appStyles: '',
    appThemeName: null,
    customDocumentTitle: '',
    customDocumentTitleEnabled: false,
    plugins: Immutable.OrderedMap(),
    rootScreen: null,
    createdAt: null,
  },
  'appTemplate',
)

export const writer = transit.withRecords([Position2, PluginTemplate, AppTemplate])

type Plain = Record<string, unknown>

/** Immutable values from plain ones: objects become ordered maps, arrays lists. */
export function immutable(value: unknown): unknown {
  if (Array.isArray(value)) return Immutable.List(value.map(immutable))
  if (value instanceof Date || value === null || typeof value !== 'object') return value
  return Immutable.OrderedMap(Object.entries(value as Plain).map(([k, v]) => [k, immutable(v)]))
}

export function plugin(
  id: string,
  fields: {
    subtype: string
    type?: string
    template?: Plain
    position?: Plain
    resourceName?: string
    screen?: string
  },
) {
  return new PluginTemplate({
    id,
    uuid: `uuid-${id}`,
    type: fields.type ?? 'widget',
    subtype: fields.subtype,
    template: immutable(fields.template ?? {}),
    position2: fields.position ? new Position2(fields.position) : null,
    resourceName: fields.resourceName ?? null,
    screen: fields.screen ?? null,
  } as never)
}

export function appTemplate(plugins: ReturnType<typeof plugin>[], fields: Plain = {}) {
  return new AppTemplate({
    ...fields,
    plugins: Immutable.OrderedMap(plugins.map((p) => [p.get('id') as string, p])),
  } as never)
}

/** An app export, as Retool's "Export to JSON" writes it. */
export function appExport(plugins: ReturnType<typeof plugin>[], fields: Plain = {}) {
  return {
    uuid: '00000000-0000-4000-8000-000000000001',
    page: {
      id: 1,
      data: { appState: writer.toJSON(appTemplate(plugins, fields)) },
      changesRecord: [],
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z',
    },
    modules: {},
  }
}

/** A workflow export: blocks in plain JSON, their settings in `templateData`. */
export function workflowExport(
  blocks: Plain[],
  plugins: ReturnType<typeof plugin>[],
  extra: Plain = {},
): Plain {
  return {
    name: 'Sync orders',
    description: null,
    organizationId: 1,
    isEnabled: true,
    crontab: null,
    timezone: 'Europe/Amsterdam',
    blockData: blocks,
    templateData: writer.toJSON(appTemplate(plugins)),
    triggerWebhooks: [
      {
        name: 'webhook',
        uuid: 'hook-1',
        inputSchema: { properties: [{ key: 'orderId', type: 'string' }] },
        useHeaderApiKey: true,
        exampleInputJSON: '{"orderId":"A1"}',
      },
    ],
    customLibraries: [
      { version: '4.17.21', language: 'javascript', variable: '_', codeString: '', libraryName: 'lodash' },
    ],
    setupScripts: { python: { codeString: '' }, javascript: { codeString: 'const ONE = 1' } },
    subflows: [],
    type: 'workflow',
    codeExecutorMemoryLimitMbs: null,
    ...extra,
  }
}
