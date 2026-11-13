import { COMPONENTS, type EventHandler, type HandlerAction, QUERY_EVENTS } from '@ow/app-definition'
import { parseTemplate } from '@ow/expressions'
import type { RetoolPlugin } from '../model'
import { inlineBraces } from './logic'

/**
 * Retool event handlers as ours. Each Retool handler is `{ event, type, method, pluginId, params, waitType, waitMs,
 * enabled, targetId }`: the owner's event, then what runs (a query, a script, a component's method, a state, a util).
 * Handlers with no counterpart are left out, with a note.
 */

export interface EventContext {
  /** Each Retool id's kind (`SqlQueryUnified`, `ModalFrameWidget`…). */
  kinds: Map<string, string>
  /** Each Retool component's type here (`modal`, `table`…). */
  ourTypes: Map<string, string>
}

type RetoolHandler = Record<string, unknown>

/** Retool event names that are ours under another name, by Retool kind (`*` for every kind). */
const EVENT_NAMES: Record<string, Record<string, string>> = {
  '*': { click: 'click', change: 'change', submit: 'submit', success: 'success', failure: 'failure' },
  TableWidget2: { selectRow: 'rowSelect', changeCell: 'changeCell', save: 'save' },
  TableWidget: { rowSelectChange: 'rowSelect', selectRow: 'rowSelect', save: 'save' },
  FileInputWidget: { parse: 'change' },
  FileDropzoneWidget: { parse: 'change' },
  FileButtonWidget: { parse: 'change' },
  ContainerWidget2: { change: 'viewChange' },
  ModalFrameWidget: { show: 'open', hide: 'close' },
  ModalWidget: { show: 'open', hide: 'close', open: 'open', close: 'close' },
}

/** Retool component methods that are ours under another name. */
const METHOD_NAMES: Record<string, string> = {
  show: 'open',
  hide: 'close',
  resetValue: 'clearValue',
  clearFiles: 'clearValue',
}

/** A Retool value as our template: strings as they are; anything else as one `{{ }}`. */
function template(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return `{{ ${JSON.stringify(value)} }}`
}

/** A Retool value as JavaScript source: `{{ x }}` alone is `x`; text with `{{ }}` a template literal. */
function jsValue(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? null)
  try {
    const parts = parseTemplate(value)
    if (parts.length === 1 && parts[0]!.type === 'expression') return `(${parts[0]!.code.trim()})`
    if (!parts.some((p) => p.type === 'expression')) return JSON.stringify(value)
    return `\`${parts.map((p) => (p.type === 'text' ? p.value.replace(/[`\\$]/g, (c) => `\\${c}`) : `\${${p.code.trim()}}`)).join('')}\``
  } catch {
    return JSON.stringify(value)
  }
}

/** Retool's `self` (the owner) in a template or code. */
function withSelf(text: string, owner: string): string {
  return text.replace(/(^|[^\w$.])self(?![\w$])/g, `$1${owner}`)
}

export function convertEvents(
  owner: RetoolPlugin,
  ctx: EventContext,
  notes: string[],
  /** For a navigation: Retool item ids (`targetId`) that are links here, by id. */
): EventHandler[] {
  const raw = Array.isArray(owner.template.events) ? (owner.template.events as RetoolHandler[]) : []
  const ourType = ctx.ourTypes.get(owner.id)
  const events: readonly string[] =
    owner.type === 'datasource' ? QUERY_EVENTS : ourType ? (COMPONENTS[ourType]?.events ?? []) : []
  const handlers: EventHandler[] = []
  const dropped: string[] = []
  raw.forEach((h, i) => {
    const retoolEvent = String(h.event ?? '')
    const conditions: string[] = []
    let event = EVENT_NAMES[owner.subtype]?.[retoolEvent] ?? EVENT_NAMES['*']![retoolEvent]
    // A switch's or checkbox's `true` and `false`: a change to that value.
    if ((retoolEvent === 'true' || retoolEvent === 'false') && events.includes('change')) {
      event = 'change'
      conditions.push(retoolEvent === 'true' ? `${owner.id}.value` : `!${owner.id}.value`)
    }
    // A navigation link: our action link with the Retool item's id as its key.
    if (owner.subtype === 'NavigationWidget2' && retoolEvent === 'click' && typeof h.targetId === 'string') {
      conditions.push(`${owner.id}.clickedItem === ${JSON.stringify(h.targetId)}`)
    }
    if (!event || !events.includes(event)) {
      dropped.push(`its ${retoolEvent} handler (${h.type}.${h.method})`)
      return
    }
    const action = convertAction(h, owner, ctx)
    if (!action) {
      dropped.push(`its ${retoolEvent} handler (${h.type}.${h.method})`)
      return
    }
    const enabled = typeof h.enabled === 'string' && h.enabled.trim() ? h.enabled.trim() : null
    if (enabled) conditions.push(loneCode(enabled) ?? JSON.stringify(enabled))
    const wait = Number(h.waitMs)
    const handler: EventHandler = {
      id: `h${i + 1}`,
      event,
      action,
      ...(conditions.length && {
        onlyIf: withSelf(
          `{{ ${conditions.map((c) => (conditions.length > 1 ? `(${c})` : c)).join(' && ')} }}`,
          owner.id,
        ),
      }),
      ...(Number.isFinite(wait) &&
        wait > 0 &&
        h.waitType === 'throttle' && { throttleMs: Math.min(60_000, Math.round(wait)) }),
      ...(Number.isFinite(wait) &&
        wait > 0 &&
        h.waitType !== 'throttle' && { debounceMs: Math.min(60_000, Math.round(wait)) }),
    }
    handlers.push(handler)
  })
  if (dropped.length) notes.push(`Not imported: ${[...new Set(dropped)].join(', ')}`)
  return handlers.slice(0, 50)
}

function loneCode(text: string): string | null {
  try {
    const parts = parseTemplate(text)
    return parts.length === 1 && parts[0]!.type === 'expression' ? parts[0]!.code.trim() : null
  } catch {
    return null
  }
}

function convertAction(h: RetoolHandler, owner: RetoolPlugin, ctx: EventContext): HandlerAction | null {
  const params = (h.params && typeof h.params === 'object' ? h.params : {}) as Record<string, unknown>
  const target = typeof h.pluginId === 'string' ? h.pluginId : ''
  const method = String(h.method ?? '')
  const self = (s: string) => withSelf(s, owner.id)
  switch (h.type) {
    case 'datasource': {
      if (!ctx.kinds.has(target)) return null
      const options = params.options as Record<string, unknown> | undefined
      const scope = options?.additionalScope as Record<string, unknown> | undefined
      if (method === 'trigger' && scope && typeof scope === 'object' && Object.keys(scope).length) {
        const entries = Object.entries(scope).map(([k, v]) => `${JSON.stringify(k)}: ${jsValue(v)}`)
        return {
          type: 'runScript',
          code: self(`await ${target}.trigger({ additionalScope: { ${entries.join(', ')} } })`),
        }
      }
      if (method === 'trigger' || method === 'reset') return { type: 'controlQuery', query: target, method }
      return null
    }
    case 'script': {
      const src = typeof params.src === 'string' ? params.src : ''
      return src.trim() ? { type: 'runScript', code: self(inlineBraces(src)) } : null
    }
    case 'state': {
      if (method === 'setValue')
        return { type: 'setVariable', variable: target, value: self(template(params.value)) }
      if (method === 'setIn') {
        return {
          type: 'runScript',
          code: self(`${target}.setIn(${jsValue(params.path)}, ${jsValue(params.value)})`),
        }
      }
      return null
    }
    case 'widget': {
      const ourType = ctx.ourTypes.get(target)
      if (!ourType) return null
      if (method === 'exportData' && ourType === 'table') {
        return { type: 'download', data: `{{ ${target}.data }}`, fileName: `${target}.csv` }
      }
      if (method === 'setHidden' && ourType === 'modal') {
        const hidden = params.hidden
        return {
          type: 'controlComponent',
          component: target,
          method: hidden === false || hidden === 'false' ? 'open' : 'close',
        }
      }
      const ours = METHOD_NAMES[method] ?? method
      if (!(ours in (COMPONENTS[ourType]?.methods ?? {})) && ours !== 'setHidden') return null
      // As many as our method takes: Retool's `show()` also takes scroll options, say.
      const takes = COMPONENTS[ourType]?.methods[ours]?.params.length ?? 0
      const args = Object.values(params)
        .filter((v) => v !== undefined)
        .slice(0, takes)
        .map((v) => self(template(v)))
      return { type: 'controlComponent', component: target, method: ours, ...(args.length && { args }) }
    }
    case 'util': {
      if (method === 'openUrl') {
        const options = params.options as Record<string, unknown> | undefined
        return {
          type: 'openUrl',
          url: self(template(params.url)),
          ...(options?.newTab === true && { newTab: true }),
        }
      }
      if (method === 'copyToClipboard') return { type: 'copyToClipboard', text: self(template(params.value)) }
      if (method === 'showNotification') {
        const options = (params.options ?? params) as Record<string, unknown>
        const message = [options.title, options.description]
          .filter((x) => typeof x === 'string' && x)
          .join(': ')
        const tone =
          options.notificationType === 'success' || options.notificationType === 'error'
            ? options.notificationType
            : 'info'
        return { type: 'notify', message: self(message || 'Done'), tone }
      }
      if (method === 'downloadFile' || method === 'exportData') {
        return {
          type: 'download',
          data: self(template(params.data ?? params.value)),
          fileName: self(template(params.fileName ?? 'download')),
        }
      }
      return null
    }
    case 'localStorage': {
      if (method === 'setValue' && typeof params.key === 'string') {
        return { type: 'setLocalStorage', key: params.key, value: self(template(params.value)) }
      }
      if (method === 'clear') return { type: 'clearLocalStorage' }
      return null
    }
    default:
      return null
  }
}
