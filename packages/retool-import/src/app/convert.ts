import {
  APP_SCHEMA_VERSION,
  type AppComponent,
  type AppDefinition,
  COMPONENTS,
  GRID_COLUMNS,
  type JsonValue,
  type Position,
} from '@ow/app-definition'
import { parseTemplate } from '@ow/expressions'
import type { RetoolApp, RetoolPlugin } from '../model'
import { ReportBuilder } from '../report'
import { containerViews, unknownWidget, WIDGETS, type WidgetContext, type WidgetResult } from './widgets'

/** Retool's grid row is about one line of controls (≈40 px); ours is 16 px. */
const ROWS_PER_RETOOL_ROW = 2.5
const OUR_ROW_PX = 16

/** Our types that hold other components. */
const HOLDERS = new Set(['container', 'form', 'modal'])

/** Retool's top-level frames: `$main` is the page, `$header` a bar above it. */
const HEADER_FRAMES = new Set(['$header', 'header'])

/** One converted component, before names are fixed and layout is set. */
interface Part {
  plugin: RetoolPlugin
  component: AppComponent
  result: WidgetResult
  /** Where its Retool position puts it: header/body/footer of its parent (or of the app, for the header frame). */
  group: 'header' | 'body' | 'footer'
  /** Its size on our grid, once known. */
  size?: { w: number; h: number }
}

export interface AppComponentsConversion {
  components: AppComponent[]
  layout: Record<string, Position>
  pages?: AppDefinition['pages']
  frame?: AppDefinition['frame']
}

/**
 * Retool's components (widgets and modal frames) as ours, with parents, slots, pages and grid positions. Queries,
 * state and functions are converted separately (step 4); events too.
 */
export function convertComponents(app: RetoolApp, report: ReportBuilder): AppComponentsConversion {
  const byId = new Map(app.plugins.map((p) => [p.id, p]))
  const tabbed = new Set<string>()
  for (const p of app.plugins) {
    const target = p.template.targetContainerId
    // A tabs widget Retool always hid only switched views from code: the container's tabs stay off.
    const hidden = p.template.hidden === true || p.template.hidden === 'true'
    if (p.subtype === 'TabsWidget2' && typeof target === 'string' && byId.has(target) && !hidden)
      tabbed.add(target)
  }
  const ctx: WidgetContext = { byId, tabbed }

  const parts = new Map<string, Part>()
  const extra: AppComponent[] = []
  /** A Retool modal widget's id → the button that opens it here. */
  const modalButtons = new Map<string, string>()
  for (const p of app.plugins) {
    if (p.type === 'frame' && p.subtype !== 'ModalFrameWidget') continue
    if (p.type !== 'widget' && p.type !== 'frame') continue
    const convert = WIDGETS[p.subtype]
    const result = convert ? convert(p, ctx) : unknownWidget(p)
    report.add({
      retool: p.id,
      kind: p.subtype,
      became: result.type || 'nothing',
      status: result.status,
      notes: result.notes,
    })
    if (!result.type) continue
    const props = withSelf(result.props, p.id)
    parts.set(p.id, {
      plugin: p,
      component: { name: p.id, type: result.type, ...(Object.keys(props).length && { props }) },
      result,
      group:
        p.position?.rowGroup === 'header' ? 'header' : p.position?.rowGroup === 'footer' ? 'footer' : 'body',
    })
  }

  // Parents: a container, form or modal by id; a modal frame by the frame named as `subcontainer`.
  const screens = [...new Set(app.plugins.flatMap((p) => (p.screen ? [p.screen] : [])))]
  const headerTop = new Set<string>()
  for (const part of parts.values()) {
    const pos = part.plugin.position
    const holderId =
      pos?.container && parts.has(pos.container)
        ? pos.container
        : pos?.subcontainer && parts.get(pos.subcontainer)?.component.type === 'modal'
          ? pos.subcontainer
          : null
    const holder = holderId ? parts.get(holderId) : undefined
    if (holder && HOLDERS.has(holder.component.type)) {
      part.component.parent = holder.plugin.id
      if (holder.component.type === 'container') {
        const shown =
          part.group === 'header' ? holder.plugin.template.showHeader : holder.plugin.template.showFooter
        if (part.group !== 'body' && shown === false) {
          // Retool hid that header or footer (its default "Container title" sits there): hidden here too.
          part.component.props = { ...part.component.props, hidden: true }
          part.result.notes.push(`Hidden: its container's ${part.group} was off in Retool`)
        }
        if (part.group !== 'body') part.component.slot = part.group
        else {
          const view = containerViews(holder.plugin).find((v) => v.key === pos?.subcontainer)
          if (view) part.component.slot = view.name
        }
      }
    } else if (holder) {
      // Inside something that isn't a container here (an unsupported one): it stays on the page.
      part.result.notes.push(`Its Retool parent ${holder.plugin.id} isn't a container here: it's on the page`)
    } else if (pos && HEADER_FRAMES.has(pos.subcontainer ?? '')) {
      headerTop.add(part.plugin.id)
    }
    if (!part.component.parent && part.plugin.screen && screens.length)
      part.component.page = part.plugin.screen
  }

  // Retool's modal button: the modal, plus a button where it was that opens it.
  for (const part of parts.values()) {
    if (part.plugin.subtype !== 'ModalWidget') continue
    const name = freshName(`${part.plugin.id}Button`, parts)
    modalButtons.set(part.plugin.id, name)
    const text = part.plugin.template.buttonText
    extra.push({
      name,
      type: 'button',
      ...(part.component.parent && { parent: part.component.parent }),
      ...(part.component.slot && { slot: part.component.slot }),
      ...(part.component.page && { page: part.component.page }),
      props: { text: typeof text === 'string' && text ? text : 'Open' },
      events: [
        {
          id: 'open',
          event: 'click',
          action: { type: 'controlComponent', component: part.plugin.id, method: 'open' },
        },
      ],
    })
    delete part.component.parent
    delete part.component.slot
  }

  const layout = layOut(parts, modalButtons, headerTop, screens.length > 0)
  const components = [...[...parts.values()].map((p) => p.component), ...extra]

  const out: AppComponentsConversion = { components, layout }
  if (screens.length) {
    const ordered =
      app.rootScreen && screens.includes(app.rootScreen)
        ? [app.rootScreen, ...screens.filter((s) => s !== app.rootScreen)]
        : screens
    out.pages = ordered.map((name) => ({ name }))
    if (headerTop.size) out.frame = { header: true }
  } else if (headerTop.size) {
    report.note("Retool's header frame became the top of the page")
  }
  return out
}

/** Positions on our grid for every placed component (modals have none: they open over the page). */
function layOut(
  parts: Map<string, Part>,
  modalButtons: Map<string, string>,
  headerTop: Set<string>,
  hasPages: boolean,
): Record<string, Position> {
  const layout: Record<string, Position> = {}
  const childrenOf = (parent: string | undefined) =>
    // Modals open over the page; a Retool modal widget's place is kept for the button that opens it.
    [...parts.values()].filter(
      (p) => p.component.parent === parent && (p.component.type !== 'modal' || modalButtons.has(p.plugin.id)),
    )

  /** Lays out `parent`'s children (recursively) and returns how many rows its content takes, per slot. */
  const place = (parent: string | undefined): number => {
    const kids = childrenOf(parent)
    for (const kid of kids)
      if (HOLDERS.has(kid.component.type) && !modalButtons.has(kid.plugin.id)) sizeHolder(kid)
    // Buckets: a container's slots each a grid; elsewhere header, body and footer stack into one.
    const holder = parent ? parts.get(parent) : undefined
    const container = holder?.component.type === 'container'
    const buckets = new Map<string, Part[]>()
    for (const kid of kids) {
      const key = container
        ? (kid.component.slot ?? '')
        : parent === undefined && !hasPages
          ? headerTop.has(kid.plugin.id)
            ? '0header'
            : `1${kid.component.page ?? ''}`
          : parent === undefined
            ? `${headerTop.has(kid.plugin.id) ? 'frame' : (kid.component.page ?? '')}`
            : `${{ header: 0, body: 1, footer: 2 }[kid.group]}`
      buckets.set(key, [...(buckets.get(key) ?? []), kid])
    }
    const direction = holder?.plugin.template._direction
    let offset = 0
    let tallest = 0
    const keys = [...buckets.keys()].sort()
    for (const key of keys) {
      const placed = arrange(buckets.get(key)!, direction === 'vertical')
      const stacked = !container && !(parent === undefined && hasPages)
      for (const [name, pos] of placed) layout[name] = stacked ? { ...pos, y: pos.y + offset } : pos
      const bottom = Math.max(0, ...[...placed.values()].map((p) => p.y + p.h))
      if (stacked) offset += bottom
      else tallest = Math.max(tallest, bottom)
    }
    return container || (parent === undefined && hasPages) ? tallest : offset
  }

  /** A container's, form's or modal's size: from Retool when it was fixed, else from its content. */
  const sizeHolder = (part: Part) => {
    const content = place(part.plugin.id)
    const views =
      Array.isArray(part.component.props?.views) && (part.component.props.views as unknown[]).length > 0
    // Padding, plus the tabs and a form's Submit button.
    const chrome =
      3 + (views && part.component.props?.showTabs ? 3 : 0) + (part.component.type === 'form' ? 4 : 0)
    const fromRetool = retoolHeight(part)
    part.size = { w: width(part), h: Math.max(fromRetool ?? 0, content + chrome, 4) }
  }

  // Modals first (their content), then the page from the top.
  for (const part of parts.values()) if (part.component.type === 'modal') place(part.plugin.id)
  place(undefined)
  // The modal buttons sit where Retool's modal widget was.
  for (const part of parts.values()) {
    const button = modalButtons.get(part.plugin.id)
    if (button && layout[part.plugin.id]) {
      layout[button] = layout[part.plugin.id]!
      delete layout[part.plugin.id]
    }
  }
  return layout

  function arrange(items: Part[], vertical: boolean): Map<string, Position> {
    const out = new Map<string, Position>()
    const stacked = items.filter((p) => p.plugin.position?.stack)
    if (stacked.length > items.length / 2) {
      // Retool's stack: in order, wrapping at 12 columns (or one per row when vertical).
      const ordered = [...items].sort(
        (a, b) => (a.plugin.position?.stack?.ordinal ?? 0) - (b.plugin.position?.stack?.ordinal ?? 0),
      )
      let x = 0
      let y = 0
      let rowHeight = 0
      for (const item of ordered) {
        const w = width(item)
        const h = height(item)
        if (vertical || x + w > GRID_COLUMNS) {
          y += rowHeight
          x = 0
          rowHeight = 0
        }
        out.set(item.plugin.id, { x, y, w, h })
        x += w
        rowHeight = Math.max(rowHeight, h)
        if (vertical) {
          y += h
          rowHeight = 0
        }
      }
      return out
    }
    // Retool's grid: same columns, rows scaled; then anything overlapping moves down.
    const wanted = items
      .map((item) => {
        const pos = item.plugin.position
        const w = width(item)
        const x = Math.min(Math.max(0, Math.round(pos?.col ?? 0)), GRID_COLUMNS - w)
        return {
          item,
          x,
          y: Math.max(0, Math.round((pos?.row ?? 0) * ROWS_PER_RETOOL_ROW)),
          w,
          h: height(item),
        }
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const placed: Position[] = []
    for (const next of wanted) {
      let y = next.y
      for (;;) {
        const blocker = placed.find(
          (p) => p.x < next.x + next.w && next.x < p.x + p.w && p.y < y + next.h && y < p.y + p.h,
        )
        if (!blocker) break
        y = blocker.y + blocker.h
      }
      const pos = { x: next.x, y, w: next.w, h: next.h }
      placed.push(pos)
      out.set(next.item.plugin.id, pos)
    }
    return out
  }

  function width(part: Part): number {
    const w = Math.round(part.plugin.position?.width ?? COMPONENTS[part.component.type]?.defaultSize.w ?? 4)
    return Math.min(GRID_COLUMNS, Math.max(1, w))
  }

  function height(part: Part): number {
    if (part.size) return part.size.h
    return retoolHeight(part) ?? defaultHeight(part)
  }
}

/** The height Retool fixed for it, on our grid; null when Retool sized it to its content. */
function retoolHeight(part: Part): number | null {
  const pos = part.plugin.position
  if (!pos) return null
  if (pos.stack)
    return pos.stack.height && pos.stack.height > 0
      ? Math.max(1, Math.ceil(pos.stack.height / OUR_ROW_PX))
      : null
  return pos.height >= 1 ? Math.max(1, Math.round(pos.height * ROWS_PER_RETOOL_ROW)) : null
}

/** Our height for a component Retool sized to its content: the type's own, more for long text. */
function defaultHeight(part: Part): number {
  const base = COMPONENTS[part.component.type]?.defaultSize.h ?? 3
  const value = part.component.props?.value
  if (part.component.type === 'text' && typeof value === 'string') {
    const lines = value.split('\n').length
    const heading = /^#{1,3}\s/m.test(value) ? 1 : 0
    return Math.max(base, Math.ceil(lines * 1.4) + heading)
  }
  return base
}

/** Retool's `self` in a component's templates is the component itself. */
function withSelf(props: Record<string, JsonValue>, name: string): Record<string, JsonValue> {
  const map = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return v.includes('self') ? replaceSelf(v, name) : v
    if (Array.isArray(v)) return v.map(map)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]))
    return v
  }
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, map(v)]))
}

function replaceSelf(template: string, name: string): string {
  try {
    return parseTemplate(template)
      .map((part) =>
        part.type === 'text'
          ? part.value
          : `{{${part.code.replace(/(^|[^\w$.])self(?![\w$])/g, `$1${name}`)}}}`,
      )
      .join('')
  } catch {
    return template
  }
}

function freshName(base: string, parts: Map<string, Part>): string {
  let name = base
  for (let n = 2; parts.has(name); n++) name = `${base}${n}`
  return name
}

/** Converts a read Retool app: for now its components and layout (queries and events: step 4). */
export function convertApp(app: RetoolApp): {
  definition: AppDefinition
  report: ReturnType<ReportBuilder['build']>
} {
  const report = new ReportBuilder('app', app.name)
  const converted = convertComponents(app, report)
  const definition: AppDefinition = {
    schemaVersion: APP_SCHEMA_VERSION,
    ...(converted.pages && { pages: converted.pages }),
    components: converted.components,
    queries: [],
    layout: converted.layout,
    ...(converted.frame && { frame: converted.frame }),
  }
  if (app.settings.css) report.note("Retool's custom CSS wasn't imported: it styles Retool's own markup")
  return { definition, report: report.build() }
}
