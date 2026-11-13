import { COMPONENTS, type JsonValue } from '@ow/app-definition'
import { parseTemplate } from '@ow/expressions'
import type { RetoolPlugin } from '../model'
import type { EntryStatus } from '../report'

/**
 * Retool components (widgets) as ours, one small converter per Retool kind (`subtype`). Each gives our type and props;
 * layout, parents and events are done elsewhere. A kind without a converter becomes an alert saying what it was.
 * Supporting a new Retool widget is one entry here (and a fixture in the tests).
 */

export interface WidgetResult {
  type: string
  props: Record<string, JsonValue>
  status: EntryStatus
  notes: string[]
}

export interface WidgetContext {
  /** Every part of the app, by Retool id (a select's options can read a query, a tabs widget names a container). */
  byId: Map<string, RetoolPlugin>
  /** Containers a tabs widget drives: their tabs are shown on the container itself. */
  tabbed: Set<string>
}

type WidgetConverter = (p: RetoolPlugin, ctx: WidgetContext) => WidgetResult

const t = (p: RetoolPlugin, key: string): unknown => p.template[key]

/** Our props for `type` from Retool values: each coerced to the prop's type, empty ones left out. */
function props(type: string, values: Record<string, unknown>): Record<string, JsonValue> {
  const spec = COMPONENTS[type]
  const out: Record<string, JsonValue> = {}
  for (const [name, raw] of Object.entries(values)) {
    const prop = spec?.props[name]
    const value = coerce(raw, prop?.type, prop?.default)
    if (value !== undefined) out[name] = value
  }
  return out
}

/** A Retool value as one of ours: templates stay strings; `"true"` is true for a boolean, `"3"` 3 for a number. */
function coerce(raw: unknown, type: unknown, fallback?: JsonValue): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '' || s === 'null') return undefined
    if (s.includes('{{')) return raw
    if (type === 'boolean') {
      const b = s === 'true' ? true : s === 'false' ? false : null
      return b === null ? raw : b === (fallback === true) ? undefined : b
    }
    if (type === 'number') return Number.isFinite(Number(s)) ? Number(s) : raw
    return raw
  }
  // `false` matters only where our default is true.
  if (type === 'boolean' && typeof raw === 'boolean') return raw === (fallback === true) ? undefined : raw
  return raw as JsonValue
}

const ok = (type: string, values: Record<string, unknown>, notes: string[] = []): WidgetResult => ({
  type,
  props: props(type, values),
  status: notes.length ? 'approximated' : 'converted',
  notes,
})

/** What every component has. */
const common = (p: RetoolPlugin) => ({ hidden: t(p, 'hidden') })

/** An input's label, required flag, form key and disabled state. */
function inputBase(p: RetoolPlugin) {
  const key = t(p, 'formDataKey')
  return {
    ...common(p),
    label: t(p, 'hideLabel') === true ? '' : t(p, 'label'),
    disabled: t(p, 'disabled'),
    required: t(p, 'required'),
    // Retool's default key is the component's own id (`{{ self.id }}`): ours uses the name without one.
    ...(typeof key === 'string' && !/^\s*\{\{\s*self\.id\s*\}\}\s*$/.test(key) && { formDataKey: key }),
  }
}

/** A label for a button Retool showed as an icon: its tooltip, else the icon's name (`…/arrows-synchronize`). */
function iconLabel(p: RetoolPlugin): string {
  const tooltip = t(p, 'tooltipText')
  if (typeof tooltip === 'string' && tooltip.trim()) return tooltip.trim()
  const icon = t(p, 'iconBefore') ?? t(p, 'iconAfter')
  if (typeof icon === 'string' && icon) {
    const words = icon
      .split('/')
      .pop()!
      .replace(/^interface-/, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    if (words) return words.charAt(0).toUpperCase() + words.slice(1)
  }
  return 'Button'
}

/** Accepted file types: Retool keeps a list (`['.csv', '.xlsx']`), ours is text (`.csv,.xlsx`). */
function accept(p: RetoolPlugin): unknown {
  const raw = t(p, 'accept')
  return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x).join(',') : raw
}

/** The code inside a value that is one `{{ }}`, else null. */
function loneCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const parts = parseTemplate(value.trim())
    return parts.length === 1 && parts[0]!.type === 'expression' ? parts[0]!.code.trim() : null
  } catch {
    return null
  }
}

/**
 * A select's, radio group's or segmented control's options. Retool's static mode lists `_values` and `_labels`; its
 * dynamic mode maps `data` with `values` and `labels` templates per `item` (and `i`).
 */
function options(p: RetoolPlugin): JsonValue {
  if (t(p, 'itemMode') !== 'dynamic') {
    const values = Array.isArray(t(p, '_values')) ? (t(p, '_values') as unknown[]) : []
    const labels = Array.isArray(t(p, '_labels')) ? (t(p, '_labels') as unknown[]) : []
    return values.map((v, i) => {
      const label = typeof labels[i] === 'string' && labels[i] ? (labels[i] as string) : String(v ?? '')
      return { label, value: v as JsonValue }
    })
  }
  const data = loneCode(t(p, 'data')) ?? jsonText(t(p, 'data'))
  const value = loneCode(t(p, 'values')) ?? 'item'
  const label = loneCode(t(p, 'labels')) ?? value
  return `{{ (${data} || []).map((item, i) => ({ value: ${value}, label: ${label} })) }}`
}

/** A literal Retool value as JavaScript source. */
function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return '[]'
    }
  }
  return JSON.stringify(value ?? [])
}

/** A component standing in for one we have no counterpart for. */
function placeholder(p: RetoolPlugin, why: string): WidgetResult {
  return {
    type: 'alert',
    props: {
      title: 'Not imported from Retool',
      description: `${p.subtype} "${p.id}": ${why}`,
      tone: 'warning',
    },
    status: 'unsupported',
    notes: [why],
  }
}

const NUMBER_FORMAT_NOTE =
  "Its number format (currency, percent, decimals) isn't kept: it shows a plain number"

export const WIDGETS: Record<string, WidgetConverter> = {
  TextWidget2: (p) =>
    ok('text', {
      ...common(p),
      value: t(p, 'value'),
      markdown: t(p, 'disableMarkdown') !== true,
    }),
  ButtonWidget2: (p) => {
    const text = t(p, 'text')
    const iconOnly = typeof text !== 'string' || !text.trim()
    return ok(
      'button',
      {
        ...common(p),
        text: iconOnly ? iconLabel(p) : text,
        disabled: t(p, 'disabled'),
        loading: t(p, 'loading'),
      },
      iconOnly ? ['Retool showed only an icon: it has a label here'] : [],
    )
  },
  LinkWidget: (p) =>
    ok('button', { ...common(p), text: t(p, 'text'), variant: 'secondary', disabled: t(p, 'disabled') }, [
      'A link became a secondary button',
    ]),
  TextInputWidget2: (p) =>
    ok('textInput', { ...inputBase(p), placeholder: t(p, 'placeholder'), defaultValue: t(p, 'value') }),
  EditableTextWidget2: (p) =>
    ok('textInput', { ...inputBase(p), placeholder: t(p, 'placeholder'), defaultValue: t(p, 'value') }, [
      'An editable text became a text input (always editable)',
    ]),
  TextAreaWidget: (p) =>
    ok('textArea', {
      ...inputBase(p),
      placeholder: t(p, 'placeholder'),
      defaultValue: t(p, 'value'),
      rows: t(p, 'minLines'),
    }),
  NumberInputWidget: (p) => {
    const format = t(p, 'format')
    return ok(
      'numberInput',
      {
        ...inputBase(p),
        placeholder: t(p, 'placeholder'),
        defaultValue: t(p, 'value'),
        min: t(p, 'min'),
        max: t(p, 'max'),
      },
      format && format !== 'decimal' ? [NUMBER_FORMAT_NOTE] : [],
    )
  },
  EditableNumberWidget: (p) =>
    ok('numberInput', { ...inputBase(p), defaultValue: t(p, 'value'), min: t(p, 'min'), max: t(p, 'max') }, [
      'An editable number became a number input (always editable)',
    ]),
  SwitchWidget2: (p) => ok('switch', { ...inputBase(p), defaultValue: t(p, 'value') }),
  CheckboxWidget2: (p) => ok('checkbox', { ...inputBase(p), defaultValue: t(p, 'value') }),
  SelectWidget2: (p) =>
    ok('select', {
      ...inputBase(p),
      placeholder: t(p, 'placeholder'),
      options: options(p),
      defaultValue: t(p, 'value'),
    }),
  RadioGroupWidget2: (p) =>
    ok('radioGroup', { ...inputBase(p), options: options(p), defaultValue: t(p, 'value') }),
  DateWidget: (p) =>
    ok('dateInput', {
      ...inputBase(p),
      defaultValue: t(p, 'value'),
      min: t(p, 'minDate'),
      max: t(p, 'maxDate'),
    }),
  DateRangeWidget: (p) => {
    const v = t(p, 'value')
    const value =
      v && typeof v === 'object' && !Array.isArray(v)
        ? {
            start: (v as Record<string, unknown>).start ?? null,
            end: (v as Record<string, unknown>).end ?? null,
          }
        : v
    return ok('dateRange', { ...inputBase(p), defaultValue: value })
  },
  FileInputWidget: (p) =>
    ok('fileInput', { ...inputBase(p), accept: accept(p), multiple: t(p, 'selectionType') === 'multiple' }),
  FileDropzoneWidget: (p) =>
    ok('fileInput', { ...inputBase(p), accept: accept(p), multiple: t(p, 'selectionType') === 'multiple' }, [
      'A file drop zone became a file input',
    ]),
  FileButtonWidget: (p) =>
    ok(
      'fileInput',
      {
        ...inputBase(p),
        label: t(p, 'text'),
        accept: accept(p),
        multiple: t(p, 'selectionType') === 'multiple',
      },
      ['A file button became a file input'],
    ),
  JSONExplorerWidget: (p) =>
    ok('jsonExplorer', {
      ...common(p),
      value: t(p, 'value'),
      expandDepth: t(p, 'expandNodes') === true ? 2 : 1,
    }),
  ImageWidget2: (p) => {
    const src = t(p, 'src')
    const stored =
      !!t(p, 'storageBlobId') || (typeof t(p, 'srcType') === 'string' && t(p, 'srcType') !== 'src')
    return ok(
      'image',
      { ...common(p), src: stored ? '' : src, alt: t(p, 'altText'), fit: t(p, 'fit') },
      stored ? ["Its image was in Retool's storage: put it somewhere reachable and set its URL"] : [],
    )
  },
  DividerWidget: (p) => ok('divider', { ...common(p), label: t(p, 'text') }),
  ProgressBarWidget: (p) => ok('progressBar', { ...common(p), label: t(p, 'label'), value: t(p, 'value') }),
  ProgressCircleWidget: (p) =>
    ok('progressBar', { ...common(p), label: t(p, 'label'), value: t(p, 'value') }, [
      'A progress circle became a progress bar',
    ]),
  ChartWidget2: (p) => {
    const kind = String(t(p, 'chartType') ?? 'bar')
    const chartType = ['bar', 'line', 'pie'].includes(kind) ? kind : kind === 'scatter' ? 'line' : 'bar'
    return ok('chart', { ...common(p), chartType, data: t(p, 'data') }, [
      "Retool's chart (Plotly) settings aren't kept: set its data, x axis and series",
    ])
  },
  TableWidget2: (p) => table2(p),
  TableWidget: (p) => legacyTable(p),
  NavigationWidget2: (p) => navigation(p),
  ContainerWidget2: (p, ctx) => container(p, ctx),
  FormWidget2: (p) =>
    ok('form', { ...common(p), disabled: t(p, 'disabled'), resetAfterSubmit: t(p, 'resetAfterSubmit') }, [
      "Our form has its own Submit button: check it against the form's buttons",
    ]),
  ModalFrameWidget: (p) => {
    const size = t(p, 'size')
    return ok('modal', {
      size: size === 'small' || size === 'large' ? size : 'medium',
      closeOnOutsideClick: t(p, 'overlayInteraction') !== false,
    })
  },
  ModalWidget: (p) =>
    ok('modal', { title: t(p, 'modalTitle') ?? t(p, 'buttonText') }, [
      "Retool's modal button became a modal and a button that opens it",
    ]),
  TabsWidget2: (p, ctx) => tabs(p, ctx),
  CustomComponentWidget: (p) => placeholder(p, "Retool's custom (iframe) components aren't supported"),
  ChatWidget: (p) => placeholder(p, "Retool's chat component isn't supported"),
}

/** Retool's placeholder for an unknown kind. */
export function unknownWidget(p: RetoolPlugin): WidgetResult {
  return placeholder(p, `Retool ${p.subtype} components aren't supported yet`)
}

/** Retool column formats → our column types. */
const COLUMN_TYPES: Record<string, string> = {
  string: 'text',
  decimal: 'number',
  percent: 'number',
  currency: 'number',
  integer: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  json: 'json',
  tag: 'text',
  tags: 'text',
  link: 'text',
  email: 'text',
}

/** Retool's Table (Table2): columns from its per-column maps, in `_columnIds` order. */
function table2(p: RetoolPlugin): WidgetResult {
  const notes: string[] = []
  const map = (key: string) => {
    const m = t(p, key)
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {}
  }
  const ids = Array.isArray(t(p, '_columnIds')) ? (t(p, '_columnIds') as string[]) : []
  const keys = map('_columnKey')
  const labels = map('_columnLabel')
  const formats = map('_columnFormat')
  const editable = map('_columnEditable')
  const hidden = map('_columnHidden')
  const sizes = map('_columnSize')
  const overrides = map('_columnValueOverride')
  const references = map('_columnReferenceId')
  const columns: JsonValue[] = []
  const seen = new Set<string>()
  let computed = 0
  for (const id of ids) {
    const override =
      typeof overrides[id] === 'string' && (overrides[id] as string).trim() ? (overrides[id] as string) : null
    const rawKey =
      (typeof keys[id] === 'string' && keys[id]) ||
      (typeof references[id] === 'string' && references[id]) ||
      id
    let key = String(rawKey)
    if (seen.has(key)) key = `${key}_${id}`
    seen.add(key)
    const format = typeof formats[id] === 'string' ? (formats[id] as string) : 'string'
    const column: Record<string, JsonValue> = { key }
    if (typeof labels[id] === 'string' && labels[id]) column.label = labels[id] as string
    const type = COLUMN_TYPES[format] ?? 'text'
    if (type !== 'text') column.type = type
    if (editable[id] === true || editable[id] === 'true') column.editable = true
    const hide = hidden[id]
    if (hide === true || hide === 'true') column.hidden = true
    else if (typeof hide === 'string' && hide.includes('{{')) column.hidden = hide
    if (typeof sizes[id] === 'number' && (sizes[id] as number) > 0)
      column.width = Math.round(sizes[id] as number)
    if (override) {
      // Retool's row in a column's value is `currentSourceRow` (or `currentRow`); ours is `currentRow`.
      // `item` is the cell's own value.
      column.value = override
        .replace(/\bcurrentSourceRow\b/g, 'currentRow')
        .replace(/(^|[^\w$.])item(?![\w$])/g, `$1currentRow[${JSON.stringify(String(rawKey))}]`)
      delete column.editable
      computed++
    }
    if (!COLUMN_TYPES[format]) notes.push(`Column "${key}"'s ${format} format shows as text`)
    columns.push(column)
  }
  const primaryId = t(p, '_primaryKeyColumnId')
  const primaryKey = typeof primaryId === 'string' && primaryId ? keys[primaryId] : undefined
  const selection = t(p, '_rowSelection')
  const pages = t(p, 'overflowType') === 'pagination'
  const server = t(p, '_serverPaginated') === true
  const pageSize = Number(t(p, '_templatePageSize') ?? t(p, '_pageSize'))
  const actions = Array.isArray(t(p, '_actionIds')) ? (t(p, '_actionIds') as unknown[]).length : 0
  if (actions)
    notes.push(`Its ${actions} row action button(s) weren't imported: use a column or a button outside`)
  const toolbar = map('_toolbarButtonType')
  if (Object.values(toolbar).some((type) => type === 'custom')) {
    notes.push("Its toolbar's custom buttons (Download, Refresh…) weren't imported")
  }
  if (computed) notes.push(`${computed} computed column(s): check they read currentRow`)
  return ok(
    'table',
    {
      ...common(p),
      data: t(p, 'data'),
      columns,
      primaryKey: typeof primaryKey === 'string' && primaryKey ? primaryKey : undefined,
      rowSelection: selection === 'none' || selection === 'multiple' ? selection : 'single',
      emptyMessage: t(p, 'emptyMessage'),
      showFilters: Object.values(toolbar).includes('filter'),
      paging: server ? 'server' : pages ? 'pages' : undefined,
      pageSize: pages && Number.isFinite(pageSize) && pageSize > 0 ? pageSize : undefined,
    },
    // Retool's tables do more than ours shows; these notes say what to check.
    [...new Set(notes)],
  )
}

/** Retool's legacy Table: its data and the visible columns. */
function legacyTable(p: RetoolPlugin): WidgetResult {
  const visibility = (t(p, '_columnVisibility') ?? t(p, 'columnVisibility') ?? {}) as Record<string, unknown>
  const names = (t(p, 'columnHeaderNames') ?? {}) as Record<string, unknown>
  const order = Array.isArray(t(p, '_columns')) ? (t(p, '_columns') as string[]) : Object.keys(visibility)
  const columns = order
    .filter((key) => visibility[key] !== false)
    .map((key) =>
      typeof names[key] === 'string' && names[key] ? { key, label: names[key] as string } : { key },
    )
  return ok('table', { ...common(p), data: t(p, 'data'), columns }, [
    "Retool's legacy table: its column formats, colours and actions weren't imported",
  ])
}

/**
 * Retool's navigation: links to screens become links to pages; other links (which run handlers in Retool) become our
 * action links, keyed by Retool's item id, whose handlers are converted with the component's.
 */
function navigation(p: RetoolPlugin): WidgetResult {
  const list = (key: string) => (Array.isArray(t(p, key)) ? (t(p, key) as unknown[]) : [])
  const labels = list('_labels')
  const screens = list('_screenTargetByIndex')
  const ids = list('_ids')
  const hidden = list('_hiddenByIndex')
  const items = labels.map((label, i) => {
    const text = String(label ?? '')
    const hide =
      hidden[i] === true || hidden[i] === 'true'
        ? { hidden: true }
        : typeof hidden[i] === 'string' && (hidden[i] as string).includes('{{')
          ? { hidden: hidden[i] as string }
          : {}
    return typeof screens[i] === 'string' && screens[i]
      ? { page: screens[i] as string, label: text, ...hide }
      : { key: String(ids[i] ?? i), label: text, ...hide }
  })
  return ok('navigation', {
    ...common(p),
    items,
    orientation: t(p, 'orientation') === 'vertical' ? 'vertical' : 'horizontal',
  })
}

/** A view key as one of our names: `View 1` → `view1`. */
export function viewName(key: string, taken: Set<string>): string {
  const base =
    key
      .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
      .replace(/^[^A-Za-z_]+/, '')
      .replace(/^./, (c) => c.toLowerCase()) || 'view'
  let name = base === 'header' || base === 'footer' ? `${base}View` : base.slice(0, 60)
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 58)}${n}`
  taken.add(name)
  return name
}

/** The views of a Retool container, by Retool view key → our view. One view is no views here. */
export function containerViews(p: RetoolPlugin): { key: string; name: string }[] {
  const keys = (Array.isArray(t(p, '_viewKeys')) ? (t(p, '_viewKeys') as unknown[]) : []).map(String)
  if (keys.length < 2) return []
  const taken = new Set<string>()
  return keys.map((key) => ({ key, name: viewName(key, taken) }))
}

function container(p: RetoolPlugin, ctx: WidgetContext): WidgetResult {
  const views = containerViews(p)
  return ok('container', {
    ...common(p),
    showBorder: t(p, 'showBorder') !== false,
    views: views.map((v) => ({ name: v.name, label: v.key })),
    // Tabs: a Retool tabs widget drove this container's views; here they're the container's own.
    showTabs: views.length > 0 && ctx.tabbed.has(p.id),
  })
}

/** Retool's tabs: driving a container, they become its tabs (and this one goes); otherwise a segmented control. */
function tabs(p: RetoolPlugin, ctx: WidgetContext): WidgetResult {
  const target = t(p, 'targetContainerId')
  if (typeof target === 'string' && ctx.byId.has(target)) {
    return { type: '', props: {}, status: 'approximated', notes: [`Became the tabs of container ${target}`] }
  }
  return ok('segmentedControl', { ...inputBase(p), options: options(p), defaultValue: t(p, 'value') }, [
    'Tabs not driving a container became a segmented control',
  ])
}
