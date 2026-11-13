import type {
  RetoolApp,
  RetoolBlock,
  RetoolExport,
  RetoolFunction,
  RetoolPlugin,
  RetoolPosition,
  RetoolWebhookTrigger,
  RetoolWorkflow,
} from './model'
import { decodeTransit, RECORD_KEY, TransitError } from './transit'

export type RetoolReadErrorCode = 'not_json' | 'not_retool' | 'unreadable'

export class RetoolReadError extends Error {
  override name = 'RetoolReadError'
  constructor(
    readonly code: RetoolReadErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ReadOptions {
  /** The file's name, for an app's name (app exports don't carry one): `Order%20Desk.json` → "Order Desk". */
  fileName?: string
}

/**
 * Reads a Retool export (the JSON text, or parsed): an app (`page.data.appState`) or a workflow (`blockData` and
 * `templateData`). Anything else is `not_retool`.
 */
export function readRetoolExport(input: string | unknown, options: ReadOptions = {}): RetoolExport {
  let json: unknown = input
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input)
    } catch {
      throw new RetoolReadError('not_json', "This file isn't JSON")
    }
  }
  const root = obj(json)
  const appState = obj(obj(root.page).data).appState
  if (typeof appState === 'string') return readApp(root, appState, options)
  if (Array.isArray(root.blockData) && typeof root.templateData === 'string') return readWorkflow(root)
  throw new RetoolReadError('not_retool', "This isn't a Retool app or workflow export")
}

function readApp(root: Record<string, unknown>, appState: string, options: ReadOptions): RetoolApp {
  const state = obj(decode(appState, 'the app'))
  if (!isRecordOf(state.plugins))
    throw new RetoolReadError('unreadable', 'The app export has no components or queries')
  const title = str(state.customDocumentTitle)?.trim() || null
  return {
    kind: 'app',
    uuid: str(root.uuid) ?? '',
    name: nameFromFile(options.fileName) ?? title ?? 'Retool app',
    plugins: readPlugins(state.plugins),
    rootScreen: str(state.rootScreen),
    settings: {
      title: state.customDocumentTitleEnabled ? title : null,
      maxWidth: str(state.appMaxWidth),
      css: str(state.appStyles) || null,
      theme: str(state.appThemeName),
    },
    modules: obj(root.modules),
    updatedAt: str(obj(root.page).updatedAt),
  }
}

function readWorkflow(root: Record<string, unknown>): RetoolWorkflow {
  const setup = obj(root.setupScripts)
  return {
    kind: 'workflow',
    uuid: null,
    name: str(root.name) ?? 'Retool workflow',
    description: str(root.description),
    enabled: root.isEnabled === true,
    timezone: str(root.timezone),
    crontab: str(root.crontab),
    blocks: readBlocks(root.blockData, root.templateData, 'the workflow'),
    functions: list(root.subflows).map((raw, i) => {
      const sub = obj(raw)
      return {
        id: str(sub.id) ?? `function${i + 1}`,
        parameters: list(sub.parameters).map((p) => {
          const param = obj(p)
          return {
            id: str(param.id) ?? '',
            name: str(param.name) ?? '',
            exampleValue: str(param.exampleValue),
          }
        }),
        blocks: readBlocks(sub.blockData, sub.templateData, `function ${i + 1}`),
      } satisfies RetoolFunction
    }),
    webhooks: list(root.triggerWebhooks).map((raw) => {
      const hook = obj(raw)
      return {
        uuid: str(hook.uuid),
        name: str(hook.name),
        inputSchema: hook.inputSchema ?? null,
        exampleInput: str(hook.exampleInputJSON),
        useHeaderApiKey: hook.useHeaderApiKey === true,
      } satisfies RetoolWebhookTrigger
    }),
    setupScript: {
      javascript: str(obj(setup.javascript).codeString) ?? '',
      python: str(obj(setup.python).codeString) ?? '',
    },
    libraries: list(root.customLibraries).map((raw) => {
      const lib = obj(raw)
      return {
        name: str(lib.libraryName) ?? '',
        version: str(lib.version),
        variable: str(lib.variable),
        language: str(lib.language),
      }
    }),
    memoryLimitMb: num(root.codeExecutorMemoryLimitMbs),
  }
}

function readBlocks(blockData: unknown, templateData: unknown, what: string): RetoolBlock[] {
  const template = typeof templateData === 'string' ? obj(decode(templateData, what)) : obj(templateData)
  const plugins = new Map(readPlugins(template.plugins).map((p) => [p.id, p]))
  return list(blockData).map((raw, i) => {
    const block = obj(raw)
    const name = str(block.pluginId) ?? `block${i + 1}`
    const dimensions = obj(block.dimensions)
    const retry = obj(block.retryPolicy)
    const attempts = num(retry.numAttempts)
    return {
      uuid: str(block.uuid) ?? name,
      name,
      blockType: str(block.blockType) ?? 'unknown',
      editorType: str(block.editorType),
      top: num(block.top) ?? 0,
      left: num(block.left) ?? 0,
      width: num(dimensions.width),
      height: num(dimensions.height),
      options: obj(block.options),
      incoming: list(block.incomingOnSuccessEdges).filter((e): e is string => typeof e === 'string'),
      incomingPorts: list(block.incomingPorts).flatMap((p) => {
        const port = obj(p)
        const blockId = str(port.blockId)
        const portId = str(port.portId)
        return blockId && portId ? [{ blockId, portId }] : []
      }),
      outgoingPorts: list(block.outgoingPorts).map((p) => {
        const port = obj(p)
        return { id: str(port.id) ?? '', name: str(port.name) ?? '', type: str(port.type) ?? '' }
      }),
      retry: attempts === null ? null : { attempts, intervalMs: num(retry.initialIntervalMs) },
      comment: str(obj(block.comment).body),
      failureCondition: str(block.failureCondition),
      resourceName: str(block.resourceName),
      plugin: plugins.get(name) ?? null,
    } satisfies RetoolBlock
  })
}

function readPlugins(raw: unknown): RetoolPlugin[] {
  return Object.entries(obj(raw)).map(([key, value]) => {
    const p = obj(value)
    return {
      id: str(p.id) ?? key,
      uuid: str(p.uuid),
      type: str(p.type) ?? 'unknown',
      subtype: str(p.subtype) ?? 'unknown',
      resourceName: str(p.resourceName),
      resourceDisplayName: str(p.resourceDisplayName),
      template: obj(p.template),
      style: obj(p.style),
      position: readPosition(p.position2),
      screen: str(p.screen),
      folder: str(p.folder),
      comment: str(p._comment),
    }
  })
}

function readPosition(raw: unknown): RetoolPosition | null {
  const p = obj(raw)
  const row = num(p.row)
  const col = num(p.col)
  if (row === null || col === null) return null
  const stack = p.stackPosition && typeof p.stackPosition === 'object' ? obj(p.stackPosition) : null
  return {
    container: str(p.container) || null,
    subcontainer: str(p.subcontainer) || null,
    rowGroup: str(p.rowGroup),
    row,
    col,
    width: num(p.width) ?? 1,
    height: num(p.height) ?? 1,
    tabNum: num(p.tabNum),
    stack: stack && {
      ordinal: num(stack.ordinal) ?? 0,
      widthType: str(stack.widthType),
      width: num(stack.width),
      height: num(stack.height),
    },
  }
}

function decode(text: string, what: string): unknown {
  try {
    return decodeTransit(text)
  } catch (err) {
    const reason = err instanceof TransitError ? err.message : String(err)
    throw new RetoolReadError('unreadable', `Couldn't read ${what}'s contents: ${reason}`)
  }
}

/** `Order%20Desk%20-%20v2.json` → "Order Desk - v2". */
function nameFromFile(fileName: string | undefined): string | null {
  if (!fileName) return null
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.json$/i, '')
  let name = base
  try {
    name = decodeURIComponent(base)
  } catch {}
  return name.trim() || null
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function isRecordOf(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** True for a decoded Immutable record of that name (`$record: 'ColumnSettings'`). */
export function isRecord(v: unknown, name?: string): v is Record<string, unknown> {
  return (
    isRecordOf(v) &&
    typeof (v as Record<string, unknown>)[RECORD_KEY] === 'string' &&
    (!name || (v as Record<string, unknown>)[RECORD_KEY] === name)
  )
}
