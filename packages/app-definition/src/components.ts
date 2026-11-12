/**
 * The component registry: what each component type exposes to the rest of the app. Pure data, shared by the
 * validator, the reactive graph and the editor; the React side (in the web app) renders them.
 *
 * - **Props** are configured in the editor; each is a template evaluated reactively, coerced to its type, and
 *   readable as `name.prop`.
 * - **State** is what the component holds at run time (what the user typed, the selected row). State with a
 *   `from` prop starts from that prop's value and starts again whenever the prop's value changes
 *   (`textInput1.value` follows `defaultValue`).
 * - **Methods** are called from scripts (`modal1.open()`) and event handlers; **events** fire handlers.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type PropType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'any'
  | { enum: readonly string[] }

export interface PropSpec {
  type: PropType
  /** The value when the prop isn't set (or its template fails). */
  default: JsonValue
  /** Shown in the inspector. */
  label: string
  /** `null` is a valid value (a number input with no default, say). */
  nullable?: boolean
}

export interface StateSpec {
  /** The prop whose value this state starts from, and is reset to whenever that value changes. */
  from?: string
  /** The starting value when there is no `from` prop. */
  default?: JsonValue
}

export interface MethodSpec {
  /** Parameter names, for completions and the event handler form. */
  params: readonly string[]
}

export interface ComponentSpec {
  type: string
  label: string
  /** Other components can be placed inside it. */
  container?: boolean
  /** A modal: opens over the page and has no position on it. */
  overlay?: boolean
  /** Has a `value` that a parent Form collects into `form.data` under `formDataKey`. */
  input?: boolean
  props: Readonly<Record<string, PropSpec>>
  state: Readonly<Record<string, StateSpec>>
  methods: Readonly<Record<string, MethodSpec>>
  events: readonly string[]
  /** Grid size when dropped on the canvas. */
  defaultSize: { w: number; h: number }
  /**
   * Takes props the spec doesn't list (a module whose inputs aren't known yet, M14): they aren't checked, and each
   * one set is a value in the graph.
   */
  openProps?: boolean
}

const str = (label: string, def = ''): PropSpec => ({ type: 'string', default: def, label })
const bool = (label: string, def = false): PropSpec => ({ type: 'boolean', default: def, label })
const num = (label: string, def: number | null = null): PropSpec => ({
  type: 'number',
  default: def,
  label,
  ...(def === null && { nullable: true }),
})
const oneOf = (label: string, values: readonly string[], def: string): PropSpec => ({
  type: { enum: values },
  default: def,
  label,
})

/** Every component has these. */
const COMMON_PROPS = { hidden: bool('Hidden') }
const COMMON_METHODS = { setHidden: { params: ['hidden'] } }

/** Shared by the inputs a Form collects. */
const inputProps = {
  label: str('Label'),
  disabled: bool('Disabled'),
  required: bool('Required'),
  formDataKey: str('Form data key'),
}
const inputMethods = { setValue: { params: ['value'] }, clearValue: { params: [] } }

const specs: ComponentSpec[] = [
  {
    type: 'text',
    label: 'Text',
    props: {
      value: str('Value'),
      align: oneOf('Alignment', ['left', 'center', 'right'], 'left'),
      /** Shows the value as Markdown (M36: Retool's Text is Markdown): headings, bold, links, lists… */
      markdown: bool('Markdown'),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 4, h: 2 },
  },
  {
    type: 'navigation',
    label: 'Navigation',
    props: {
      /**
       * Per link, in order (M24): `{ page, params?, url?, label?, icon?, hidden?, items? }`: a page of the app (with
       * URL params) or an outside `url` (http, https or mailto; opens in a new tab), an icon from `NAV_ICONS`, `hidden`
       * a template, and `items`: one level of sub-links (a group). Labels, params and `hidden` may be templates. Empty
       * links every page, by title.
       */
      items: { type: 'array', default: [], label: 'Links' },
      orientation: oneOf('Orientation', ['horizontal', 'vertical'], 'horizontal'),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 12, h: 3 },
  },
  {
    type: 'button',
    label: 'Button',
    props: {
      text: str('Text', 'Button'),
      variant: oneOf('Style', ['primary', 'secondary', 'danger'], 'primary'),
      disabled: bool('Disabled'),
      loading: bool('Loading'),
    },
    state: {},
    methods: {},
    events: ['click'],
    defaultSize: { w: 2, h: 2 },
  },
  {
    type: 'textInput',
    label: 'Text input',
    input: true,
    props: { ...inputProps, placeholder: str('Placeholder'), defaultValue: str('Default value') },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change', 'submit'],
    defaultSize: { w: 4, h: 3 },
  },
  {
    type: 'numberInput',
    label: 'Number input',
    input: true,
    props: {
      ...inputProps,
      placeholder: str('Placeholder'),
      defaultValue: num('Default value'),
      min: num('Minimum'),
      max: num('Maximum'),
      step: num('Step', 1),
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change', 'submit'],
    defaultSize: { w: 4, h: 3 },
  },
  {
    type: 'dateInput',
    label: 'Date input',
    input: true,
    props: {
      ...inputProps,
      defaultValue: { type: 'string', default: null, nullable: true, label: 'Default value (YYYY-MM-DD)' },
      min: { type: 'string', default: null, nullable: true, label: 'Earliest date' },
      max: { type: 'string', default: null, nullable: true, label: 'Latest date' },
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 4, h: 3 },
  },
  {
    type: 'select',
    label: 'Select',
    input: true,
    props: {
      ...inputProps,
      placeholder: str('Placeholder', 'Select…'),
      /** Values, or `{ label, value }` objects. */
      options: { type: 'array', default: [], label: 'Options' },
      defaultValue: { type: 'any', default: null, label: 'Default value' },
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 4, h: 3 },
  },
  {
    type: 'checkbox',
    label: 'Checkbox',
    input: true,
    props: { ...inputProps, defaultValue: bool('Checked by default') },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 3, h: 2 },
  },
  // Session 41: more inputs, after Retool's palette.
  {
    type: 'textArea',
    label: 'Text area',
    input: true,
    props: {
      ...inputProps,
      placeholder: str('Placeholder'),
      defaultValue: str('Default value'),
      rows: num('Rows', 4),
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 6, h: 6 },
  },
  {
    type: 'switch',
    label: 'Switch',
    input: true,
    props: { ...inputProps, defaultValue: bool('On by default') },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 3, h: 2 },
  },
  {
    type: 'checkboxGroup',
    label: 'Checkbox group',
    input: true,
    props: {
      ...inputProps,
      /** Values, or `{ label, value }` objects; the value is the checked ones', in the options' order. */
      options: { type: 'array', default: [], label: 'Options' },
      defaultValue: { type: 'array', default: [], label: 'Default value' },
      orientation: oneOf('Orientation', ['vertical', 'horizontal'], 'vertical'),
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 4, h: 5 },
  },
  {
    type: 'radioGroup',
    label: 'Radio group',
    input: true,
    props: {
      ...inputProps,
      /** Values, or `{ label, value }` objects. */
      options: { type: 'array', default: [], label: 'Options' },
      defaultValue: { type: 'any', default: null, label: 'Default value' },
      orientation: oneOf('Orientation', ['vertical', 'horizontal'], 'vertical'),
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 4, h: 5 },
  },
  {
    type: 'segmentedControl',
    label: 'Segmented control',
    input: true,
    props: {
      ...inputProps,
      /** Values, or `{ label, value }` objects, as side-by-side buttons. */
      options: { type: 'array', default: [], label: 'Options' },
      defaultValue: { type: 'any', default: null, label: 'Default value' },
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 5, h: 3 },
  },
  {
    type: 'dateRange',
    label: 'Date range',
    input: true,
    props: {
      ...inputProps,
      /** `{ start, end }`, each YYYY-MM-DD or null. */
      defaultValue: {
        type: 'object',
        default: null,
        nullable: true,
        label: 'Default value ({ start, end })',
      },
      min: { type: 'string', default: null, nullable: true, label: 'Earliest date' },
      max: { type: 'string', default: null, nullable: true, label: 'Latest date' },
    },
    state: { value: { from: 'defaultValue' } },
    methods: inputMethods,
    events: ['change'],
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: 'fileInput',
    label: 'File input',
    input: true,
    props: {
      ...inputProps,
      /** What the file picker offers: `.csv,.xlsx`, `image/*`; any file when empty. */
      accept: str('Accepted types'),
      multiple: bool('Several files'),
    },
    // `[{ name, type, size, base64 }]`, the files picked (each at most 5 MB).
    state: { value: { default: [] } },
    methods: { clearValue: { params: [] } },
    events: ['change'],
    defaultSize: { w: 4, h: 3 },
  },
  // Session 41: presentation.
  {
    type: 'statistic',
    label: 'Statistic',
    props: {
      label: str('Label', 'Total'),
      value: { type: 'any', default: 0, label: 'Value' },
      format: oneOf('Format', ['number', 'currency', 'percent', 'plain'], 'number'),
      currency: str('Currency', 'EUR'),
      decimals: num('Decimals'),
      caption: str('Caption'),
      /** A change shown under the value: positive green with an up arrow, negative red with a down arrow. */
      trend: num('Trend'),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 3, h: 5 },
  },
  {
    type: 'image',
    label: 'Image',
    props: {
      src: str('Source URL'),
      alt: str('Alternative text'),
      fit: oneOf('Fit', ['contain', 'cover', 'fill'], 'contain'),
    },
    state: {},
    methods: {},
    events: ['click'],
    defaultSize: { w: 4, h: 8 },
  },
  {
    type: 'divider',
    label: 'Divider',
    props: { label: str('Label') },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 12, h: 1 },
  },
  {
    type: 'alert',
    label: 'Alert',
    props: {
      title: str('Title', 'Heads up'),
      description: str('Description'),
      tone: oneOf('Tone', ['info', 'success', 'warning', 'error'], 'info'),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 6, h: 4 },
  },
  {
    type: 'progressBar',
    label: 'Progress bar',
    props: {
      label: str('Label'),
      /** 0 to 100. */
      value: num('Value', 0),
      showValue: bool('Show the percentage', true),
      tone: oneOf('Tone', ['accent', 'success', 'warning', 'error'], 'accent'),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 4, h: 2 },
  },
  {
    type: 'keyValue',
    label: 'Key value',
    props: {
      /** An object: one row per key. */
      data: { type: 'any', default: {}, label: 'Data' },
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 4, h: 8 },
  },
  {
    type: 'jsonExplorer',
    label: 'JSON explorer',
    props: {
      value: { type: 'any', default: null, label: 'Value' },
      /** How many levels start open. */
      expandDepth: num('Levels open', 1),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 6, h: 10 },
  },
  {
    type: 'table',
    label: 'Table',
    props: {
      data: { type: 'array', default: [], label: 'Data' },
      /**
       * `{ key, label?, type?, editable?, hidden?, width?, value?, filterable? }` per column, in order; empty shows every key of
       * the first rows. A column's `value` (M24) computes it: a template evaluated once per row of `data`, with the
       * row as `currentRow` and its index as `i` (see `ROW_LOCALS`); such a column isn't editable.
       */
      columns: { type: 'array', default: [], label: 'Columns' },
      primaryKey: str('Primary key column', 'id'),
      rowSelection: oneOf('Row selection', ['none', 'single', 'multiple'], 'single'),
      emptyMessage: str('Empty message', 'No rows'),
      /** A search box above the rows; its text is `searchText`. */
      search: bool('Search box'),
      /** A filter per column, set from its header (M24); they're `filters`. */
      showFilters: bool('Column filters'),
      /** An Add row button (M24): rows added and not saved yet are `newRows`. */
      allowAddRow: bool('Add rows'),
      /**
       * `scroll`: every row, scrolled. `pages`: pages of `pageSize` rows. `server`: `data` is one page that a query
       * fetched with `pagination`, `sort` and `searchText` (the table neither sorts, searches nor pages it itself).
       */
      paging: oneOf('Paging', ['scroll', 'pages', 'server'], 'scroll'),
      pageSize: num('Page size', 50),
      /** With server paging: how many rows there are in all, for the page count. */
      totalRowCount: num('Total row count'),
    },
    state: {
      selectedRow: { default: null },
      selectedRows: { default: [] },
      selectedIndex: { default: null },
      /** Edited rows: the primary key plus the changed fields, for a bulk update query. */
      changesetArray: { default: [] },
      /** Rows added in the table and not saved yet (M24), for an insert query; cleared with the changeset. */
      newRows: { default: [] },
      /** The page shown, from 0. */
      page: { default: 0 },
      // `pagination` (`{ page, pageSize, offset }`) is derived from `page` and `pageSize`; see `appGraph`.
      pagination: { default: { page: 0, pageSize: 50, offset: 0 } },
      /** `{ column, desc }`, or null when unsorted. */
      sort: { default: null },
      searchText: { default: '' },
      /**
       * `[{ column, op, value?, type? }]` (M24), ANDed: the table filters its rows by them, except with `server`
       * paging, where a query reads them (`sql.where(table1.filters, [...])`). See `TABLE_FILTER_OPS`.
       */
      filters: { default: [] },
    },
    methods: {
      selectRow: { params: ['index'] },
      clearSelection: { params: [] },
      /** Drops the changeset and the new rows. */
      clearChangeset: { params: [] },
      /**
       * Fires `save`, then clears the changeset and the new rows when every handler succeeded (the table's Save
       * button).
       */
      saveChanges: { params: [] },
      /** Adds a row to `newRows` (empty, or `row`'s fields); fires `addRow`. */
      addRow: { params: ['row'] },
      /** Shows page `page` (from 0) and fires `pageChange`. */
      setPage: { params: ['page'] },
      /** Sorts by `column` (null for none), descending when `desc`; back to the first page; fires `sortChange`. */
      setSort: { params: ['column', 'desc'] },
      /** Sets `searchText`; back to the first page; fires `searchChange`. */
      setSearchText: { params: ['text'] },
      /** Sets `filters` (entries that aren't filters are dropped); back to the first page; fires `filterChange`. */
      setFilters: { params: ['filters'] },
      /** No filters; back to the first page; fires `filterChange`. */
      clearFilters: { params: [] },
    },
    events: [
      'rowSelect',
      'changeCell',
      'save',
      'pageChange',
      'sortChange',
      'searchChange',
      'filterChange',
      'addRow',
    ],
    defaultSize: { w: 12, h: 20 },
  },
  {
    type: 'form',
    label: 'Form',
    container: true,
    props: {
      title: str('Title'),
      submitText: str('Submit button text', 'Submit'),
      resetAfterSubmit: bool('Reset after submit', true),
      disabled: bool('Disabled'),
    },
    // `data` is derived from the inputs inside the form; see `appGraph`.
    state: { data: { default: {} } },
    methods: { submit: { params: [] }, reset: { params: [] } },
    events: ['submit'],
    defaultSize: { w: 6, h: 16 },
  },
  {
    type: 'container',
    label: 'Container',
    container: true,
    props: {
      title: str('Title'),
      showBorder: bool('Show border', true),
      /**
       * `{ name, label? }` per view, in order (M24): each child is in one (its `slot`), and only the shown view's
       * render. Written as a list (the names are the definition's); empty is one grid, as before.
       */
      views: { type: 'array', default: [], label: 'Views' },
      /** Tabs above the views; without them, `setView` switches. */
      showTabs: bool('Show tabs', true),
      /** The view shown first; the first view when empty. */
      defaultView: str('Default view'),
      /** A button in the header folds it to its header (M24); what's below moves up. */
      collapsible: bool('Collapsible'),
      defaultExpanded: bool('Expanded at first', true),
      /** The content scrolls inside the container's height instead of overflowing it (M24). */
      scroll: bool('Scroll the content', true),
      /** `surface`, `canvas` or `accent` (the theme's, so dark mode works), or a color (`#fef3c7`, `rgb(…)`). */
      background: str('Background'),
      padding: oneOf('Padding', ['none', 'small', 'medium', 'large'], 'medium'),
    },
    state: {
      /** The view shown (M24): `defaultView` until `setView`; read it with the first view as the fallback. */
      currentView: { from: 'defaultView' },
      /** Unfolded (M24); only a collapsible container folds. */
      expanded: { from: 'defaultExpanded' },
    },
    methods: {
      /** Shows the view named `view`; fires `viewChange`. */
      setView: { params: ['view'] },
      /** The next view, staying on the last one (for steps); fires `viewChange` when it moves. */
      nextView: { params: [] },
      /** The previous view, staying on the first one; fires `viewChange` when it moves. */
      previousView: { params: [] },
      /** Unfolds it; fires `expand`. */
      expand: { params: [] },
      /** Folds it to its header (a collapsible container); fires `collapse`. */
      collapse: { params: [] },
      /** Folds or unfolds it. */
      toggle: { params: [] },
    },
    events: ['viewChange', 'expand', 'collapse'],
    defaultSize: { w: 6, h: 12 },
  },
  {
    type: 'modal',
    label: 'Modal',
    container: true,
    overlay: true,
    props: {
      title: str('Title'),
      size: oneOf('Size', ['small', 'medium', 'large'], 'medium'),
      closeOnOutsideClick: bool('Close on outside click', true),
    },
    state: { isOpen: { default: false } },
    methods: { open: { params: [] }, close: { params: [] } },
    events: ['open', 'close'],
    defaultSize: { w: 6, h: 16 },
  },
  {
    type: 'chart',
    label: 'Chart',
    props: {
      title: str('Title'),
      chartType: oneOf('Chart type', ['bar', 'line', 'area', 'pie'], 'bar'),
      data: { type: 'array', default: [], label: 'Data' },
      xKey: str('X axis key'),
      /** `time` places line and area charts' points by their date (M24); `auto` does when every x is a date. */
      xAxis: oneOf('X axis', ['auto', 'category', 'time'], 'auto'),
      /** Keys of the numeric series to plot; empty plots every number column but the x key. */
      series: { type: 'array', default: [], label: 'Series' },
      stacked: bool('Stacked'),
      showLegend: bool('Show legend', true),
    },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 6, h: 16 },
  },
]

export const COMPONENTS: Readonly<Record<string, ComponentSpec>> = Object.fromEntries(
  specs.map((spec) => [
    spec.type,
    {
      ...spec,
      props: { ...spec.props, ...COMMON_PROPS },
      methods: { ...spec.methods, ...COMMON_METHODS },
    },
  ]),
)

/** The icons a Navigation link can have (M24): lucide's, by these names (the web app maps them). */
export const NAV_ICONS = [
  'home',
  'dashboard',
  'list',
  'table',
  'chart',
  'users',
  'user',
  'settings',
  'search',
  'inbox',
  'mail',
  'bell',
  'calendar',
  'clock',
  'file',
  'folder',
  'box',
  'truck',
  'cart',
  'tag',
  'star',
  'bookmark',
  'database',
  'layers',
  'map',
  'globe',
  'building',
  'briefcase',
  'phone',
  'info',
  'help',
  'alert',
  'check',
  'plus',
  'edit',
  'trash',
  'link',
  'external',
] as const
export type NavIcon = (typeof NAV_ICONS)[number]

/** An outside link a Navigation item may open (M24): web and mail only, never `javascript:` or `data:`. */
export const NAV_URL = /^(https?:\/\/|mailto:)/i

/**
 * The operators of a table's filters (M24), as `sql.where` takes them (`@ow/expressions` `FILTER_OPS`): `between`
 * takes `[from, to]`, `empty` and `notEmpty` no value.
 */
export const TABLE_FILTER_OPS = [
  'contains',
  'equals',
  'notEquals',
  'empty',
  'notEmpty',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
] as const
export type TableFilterOp = (typeof TABLE_FILTER_OPS)[number]

export interface TableFilter {
  column: string
  op: TableFilterOp
  value?: JsonValue
  /** The column's type when it was set (`number`, `date`…), for comparing and for `sql.where`'s binding. */
  type?: string
}

/** Filters as `setFilters` keeps them: entries with a column and a known operator; anything else dropped. */
export function tableFilters(value: unknown): TableFilter[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return []
    const { column, op, value: v, type } = f as Record<string, unknown>
    if (typeof column !== 'string' || !column) return []
    if (typeof op !== 'string' || !(TABLE_FILTER_OPS as readonly string[]).includes(op)) return []
    return [
      {
        column,
        op: op as TableFilterOp,
        ...(v !== undefined && { value: v as JsonValue }),
        ...(typeof type === 'string' && { type }),
      },
    ]
  })
}

/** A table's page size as the table and its `pagination` both use it: a whole number of rows, 50 when it isn't one. */
export function pageSizeOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 50
}

export function componentSpec(type: string): ComponentSpec | undefined {
  return Object.hasOwn(COMPONENTS, type) ? COMPONENTS[type] : undefined
}

/** What an app sees of one module release (M14): its inputs (props), outputs (state) and events. */
export interface ModuleInterface {
  inputs: readonly string[]
  outputs: readonly string[]
  events: readonly string[]
}

/** Props every module instance has: which module (slug) and which release (`latest` or a version). */
export const MODULE_PROPS = ['module', 'version'] as const

const moduleBase = {
  type: 'module',
  label: 'Module',
  methods: COMMON_METHODS,
  defaultSize: { w: 6, h: 12 },
} as const

/**
 * A module instance's spec: from its release's interface when known (inputs as props, outputs as state, its
 * events), otherwise open (any prop, no state or events) until it is.
 */
export function moduleComponentSpec(iface: ModuleInterface | null): ComponentSpec {
  const props: Record<string, PropSpec> = {
    module: { type: 'string', default: '', label: 'Module' },
    version: { type: 'string', default: 'latest', label: 'Version' },
    ...COMMON_PROPS,
  }
  if (!iface) return { ...moduleBase, props, state: {}, events: [], openProps: true }
  for (const input of iface.inputs) props[input] = { type: 'any', default: null, label: input }
  return {
    ...moduleBase,
    props,
    state: Object.fromEntries(iface.outputs.map((o) => [o, { default: null }])),
    events: [...iface.events],
  }
}

/** What scripts and templates can read off a query, and call on it. */
export const QUERY_STATE = ['data', 'error', 'isFetching', 'lastRunAt'] as const
export const QUERY_METHODS: Readonly<Record<string, MethodSpec>> = {
  trigger: { params: ['options'] },
  reset: { params: [] },
}
export const QUERY_EVENTS = ['success', 'failure'] as const

export const TRANSFORMER_STATE = ['value'] as const

export const VARIABLE_STATE = ['value'] as const

/** `url.page` (the page shown, null in an app without pages) and `url.params` (its query parameters). */
export const URL_STATE = ['page', 'params'] as const

/** `localStorage.values` (session 41): what the app keeps in this browser, by key (Set local storage). */
export const STORAGE_STATE = ['values'] as const
export const VARIABLE_METHODS: Readonly<Record<string, MethodSpec>> = {
  setValue: { params: ['value'] },
  setIn: { params: ['path', 'value'] },
}

/**
 * Converts an evaluated prop value to its type: numeric strings to numbers, `"true"`/`"false"` to booleans (a
 * template like `"{{ x }} items"` is always a string). Returns `{ error }` when the value doesn't fit.
 */
export function coerceProp(spec: PropSpec, value: unknown): { value: unknown } | { error: string } {
  if (value === undefined) return { value: spec.default }
  if (value === null) return spec.nullable || spec.type === 'any' ? { value: null } : { value: spec.default }
  const type = spec.type
  if (typeof type === 'object') {
    return typeof value === 'string' && type.enum.includes(value)
      ? { value }
      : { error: `Expected one of ${type.enum.join(', ')}` }
  }
  switch (type) {
    case 'any':
      return { value }
    case 'string':
      if (typeof value === 'string') return { value }
      if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) }
      return { error: 'Expected text' }
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return { value }
      if (typeof value === 'string') {
        if (!value.trim()) return { value: spec.default }
        const n = Number(value)
        if (Number.isFinite(n)) return { value: n }
      }
      return { error: 'Expected a number' }
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      if (value === 'true' || value === 'false') return { value: value === 'true' }
      if (value === '') return { value: spec.default }
      return { error: 'Expected true or false' }
    case 'array':
      return Array.isArray(value) ? { value } : { error: 'Expected an array' }
    case 'object':
      return typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'Expected an object' }
  }
}

/** The JSON type a stored constant must have for a prop (templates are checked when evaluated). */
export function constantFits(spec: PropSpec, value: unknown): boolean {
  if (typeof value === 'string') return true
  if (value === null) return true
  const type = spec.type
  if (typeof type === 'object') return false
  switch (type) {
    case 'any':
      return true
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
    case 'string':
      return false
  }
}
