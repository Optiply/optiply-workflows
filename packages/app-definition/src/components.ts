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
    props: { value: str('Value'), align: oneOf('Alignment', ['left', 'center', 'right'], 'left') },
    state: {},
    methods: {},
    events: [],
    defaultSize: { w: 4, h: 2 },
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
  {
    type: 'table',
    label: 'Table',
    props: {
      data: { type: 'array', default: [], label: 'Data' },
      /**
       * `{ key, label?, type?, editable?, hidden?, width? }` per column, in order; empty shows every key of the
       * first rows.
       */
      columns: { type: 'array', default: [], label: 'Columns' },
      primaryKey: str('Primary key column', 'id'),
      rowSelection: oneOf('Row selection', ['none', 'single', 'multiple'], 'single'),
      emptyMessage: str('Empty message', 'No rows'),
    },
    state: {
      selectedRow: { default: null },
      selectedRows: { default: [] },
      selectedIndex: { default: null },
      /** Edited rows: the primary key plus the changed fields, for a bulk update query. */
      changesetArray: { default: [] },
    },
    methods: {
      selectRow: { params: ['index'] },
      clearSelection: { params: [] },
      clearChangeset: { params: [] },
      /** Fires `save`, then clears the changeset when every handler succeeded (the table's Save button). */
      saveChanges: { params: [] },
    },
    events: ['rowSelect', 'changeCell', 'save'],
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
    props: { title: str('Title'), showBorder: bool('Show border', true) },
    state: {},
    methods: {},
    events: [],
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

export function componentSpec(type: string): ComponentSpec | undefined {
  return Object.hasOwn(COMPONENTS, type) ? COMPONENTS[type] : undefined
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
