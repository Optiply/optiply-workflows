import {
  type AppComponent,
  CUSTOM_PROPS,
  componentSpec,
  containerViews,
  type JsonValue,
  MODULE_PROPS,
  moveToParent,
  outermostOf,
  type PropSpec,
  removeComponent,
  removeComponents,
  setComponentNote,
  setEntityPage,
  setHandlers,
  setProp,
  slotOf,
  switchableTypes,
  switchComponentType,
  withDescendants,
} from '@ow/app-definition'
import {
  ChevronDown,
  Copy,
  CopyPlus,
  MoreHorizontal,
  Pencil,
  Replace,
  RotateCcw,
  Scissors,
  StickyNote,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  Checkbox,
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  Select,
  sectionLabelClass,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { tableColumns } from '../components/table-model'
import { useAppError, useAppHostContext, useAppValue } from '../runtime/react'
import { copyComponentsText } from './clipboard'
import { ColumnsEditor } from './columns'
import { CustomInstanceFields } from './custom'
import { AppCodeField, EditorField, NameField, ProblemList, problemsAt, useParsedText } from './fields'
import { HandlersEditor } from './handlers'
import { ModuleInstanceFields } from './modules'
import { NavItemsEditor } from './nav-items'
import { specOf, useAppEditor } from './store'
import { ViewsEditor } from './views'

/**
 * Several components selected (M24): how many and which (a name selects just it), and what applies to all of them:
 * delete, duplicate, move into a container (or out to the page).
 */
export function SelectionInspector({ names, onDuplicate }: { names: string[]; onDuplicate: () => void }) {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const page = useAppEditor((s) => s.url.page)
  const inside = new Set(names.flatMap((n) => [...withDescendants(definition, n)]))
  const targets = definition.components.filter((c) => componentSpec(c.type)?.container && !inside.has(c.name))
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="inspector-selection">
      <div>
        <div className="text-sm font-medium">{names.length} components selected</div>
        <div className="mt-0.5 text-xs text-muted">
          Shift- or ⌘-click adds and removes; the arrow keys move them.
        </div>
      </div>
      <ul className="flex flex-wrap gap-1">
        {names.map((n) => (
          <li key={n}>
            <button
              type="button"
              className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs hover:bg-accent-soft"
              onClick={() => select(n)}
            >
              {n}
            </button>
          </li>
        ))}
      </ul>
      <EditorField label="Move into">
        <Select
          aria-label="Move into"
          value="-"
          onChange={(e) => {
            const to = e.target.value === '' ? undefined : e.target.value
            // Only the outermost: what's inside a selected container moves with it.
            update((def) => outermostOf(def, names).reduce((d, n) => moveToParent(d, n, to, { page }), def))
          }}
        >
          <option value="-" disabled>
            Pick a place
          </option>
          <option value="">{definition.pages?.length ? `Page ${page}` : 'The page'}</option>
          {targets.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </EditorField>
      <div className="flex gap-2">
        <Button size="sm" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            update((def) => removeComponents(def, names))
            select(null)
          }}
        >
          <Trash2 className="size-3.5" /> Delete {names.length}
        </Button>
      </div>
    </div>
  )
}

/** Everything about the selected component: name, parent, props and event handlers. */
export function ComponentInspector({ name, onDuplicate }: { name: string; onDuplicate: () => void }) {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const page = useAppEditor((s) => s.url.page)
  const setUrl = useAppEditor((s) => s.setUrl)
  const modules = useAppEditor((s) => s.modules)
  const componentLibraries = useAppEditor((s) => s.componentLibraries)
  const index = definition.components.findIndex((c) => c.name === name)
  const component = definition.components[index]
  if (!component) return null
  const spec = specOf(component, modules, componentLibraries)
  const instance = component.type === 'module'
  const custom = component.type === 'custom'
  const base = ['components', index]

  if (!spec) {
    return (
      <div className="p-4 text-sm">
        <ProblemList path={[...base, 'type']} />
      </div>
    )
  }
  const inside = withDescendants(definition, name)
  const parents = definition.components.filter((c) => componentSpec(c.type)?.container && !inside.has(c.name))
  // The container it's in (M24): its views, header and footer to pick from.
  const holder = definition.components.find((c) => c.name === component.parent)
  const inContainer = holder?.type === 'container'
  const parentViews = containerViews(holder)

  const props = Object.entries(spec.props)
    // An instance's module and version have their own fields; the rest are the module's inputs. A custom
    // component's library, component and version likewise (M25); the rest are its declared props.
    .filter(([prop]) => !instance || !(MODULE_PROPS as readonly string[]).includes(prop))
    .filter(([prop]) => !custom || !(CUSTOM_PROPS as readonly string[]).includes(prop))
  const field = ([prop, propSpec]: [string, PropSpec]) => (
    <PropField key={prop} component={component} index={index} prop={prop} spec={propSpec} />
  )
  // Module inputs and a custom component's props are its content.
  const sectionOf = (prop: string) => (instance || custom ? 'content' : propSection(prop))
  const interaction = props.filter(([prop]) => sectionOf(prop) === 'interaction')
  const appearance = props.filter(([prop]) => sectionOf(prop) === 'appearance')

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={`inspector-${name}`}>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <NameField name={name} onRenamed={select} />
          <div className="mt-1 text-xs text-muted">{spec.label}</div>
        </div>
        <ComponentMenu name={name} type={component.type} onDuplicate={onDuplicate} />
        <Button
          size="icon"
          variant="ghost"
          title="Delete component"
          onClick={() => {
            update((def) => removeComponent(def, name))
            select(null)
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <NoteField name={name} note={component.note} />

      <InspectorSection title={instance ? 'Module instance' : custom ? 'Custom component' : 'Content'}>
        {instance && <ModuleInstanceFields component={component} index={index} />}
        {custom && <CustomInstanceFields component={component} index={index} />}
        {props.filter(([prop]) => sectionOf(prop) === 'content').map(field)}
      </InspectorSection>

      <InspectorSection title="Interaction">
        {interaction.map(field)}
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted">Event handlers</h4>
          <HandlersEditor
            handlers={component.events ?? []}
            events={spec.events}
            base={[...base, 'events']}
            onChange={(events) => update((def) => setHandlers(def, name, events))}
          />
        </div>
      </InspectorSection>

      {appearance.length > 0 && (
        <InspectorSection title="Appearance">{appearance.map(field)}</InspectorSection>
      )}

      {(!spec.overlay || (definition.pages?.length && component.parent === undefined)) && (
        <InspectorSection title="Layout">
          {!spec.overlay && (
            <EditorField label="Inside">
              <Select
                aria-label="Inside"
                value={component.parent ?? ''}
                onChange={(e) =>
                  update((def) => moveToParent(def, name, e.target.value || undefined, { page }))
                }
              >
                <option value="">{definition.pages?.length ? `Page ${page}` : 'The page'}</option>
                {parents.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </EditorField>
          )}

          {inContainer && (
            <EditorField label="Area">
              <Select
                aria-label="Area"
                value={slotOf(definition, component) ?? ''}
                onChange={(e) =>
                  update((def) =>
                    moveToParent(def, name, component.parent, { slot: e.target.value || undefined }),
                  )
                }
              >
                {parentViews.length ? (
                  parentViews.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label || v.name}
                    </option>
                  ))
                ) : (
                  <option value="">Body</option>
                )}
                <option value="header">Header</option>
                <option value="footer">Footer</option>
              </Select>
            </EditorField>
          )}

          {component.parent === undefined &&
            !spec.overlay &&
            definition.frame?.sidebar &&
            component.page === undefined && (
              <EditorField label="Area">
                <Select
                  aria-label="Area"
                  value={component.slot === 'sidebar' ? 'sidebar' : ''}
                  onChange={(e) =>
                    update((def) =>
                      moveToParent(def, name, undefined, { slot: e.target.value || undefined, page: null }),
                    )
                  }
                >
                  <option value="">{definition.frame.header ? 'Header' : 'Above the page'}</option>
                  <option value="sidebar">Sidebar</option>
                </Select>
              </EditorField>
            )}

          {definition.pages?.length && component.parent === undefined ? (
            <PageField
              value={component.page ?? null}
              onChange={(to) => {
                update((def) => setEntityPage(def, name, to))
                // Moved to another page: open it, so the component stays in view (and selected).
                if (to !== null) setUrl(to)
              }}
            />
          ) : null}
        </InspectorSection>
      )}
    </div>
  )
}

const isTemplate = (value: unknown) => typeof value === 'string' && value.includes('{{')

/** Text for a stored value in a code field: strings as typed, arrays and objects as JSON. */
function asText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** What typed text means for a prop: a template string, or (without `{{ }}`) a constant of the prop's type. */
function fromText(text: string, spec: PropSpec): JsonValue | undefined {
  if (!text.trim()) return undefined
  if (text.includes('{{')) return text
  if (spec.type === 'number' && /^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text.trim())
  if (spec.type === 'array' || spec.type === 'object' || spec.type === 'any') {
    try {
      const parsed = JSON.parse(text) as JsonValue
      if (spec.type === 'array' ? Array.isArray(parsed) : true) return parsed
    } catch {
      // Not JSON: kept as text, which the validator or the runtime points out.
    }
  }
  return text
}

function PropField({
  component,
  index,
  prop,
  spec,
}: {
  component: AppComponent
  index: number
  prop: string
  spec: PropSpec
}) {
  const update = useAppEditor((s) => s.update)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const runtimeError = useAppError(`${component.name}.${prop}`)
  const value = component.props?.[prop] as JsonValue | undefined
  const path = ['components', index, 'props', prop]
  const set = (next: JsonValue | undefined) => update((def) => setProp(def, component.name, prop, next))
  const multiLine = spec.type === 'array' || spec.type === 'object'
  // A table's columns and a Navigation's links as lists (M24), or as JSON on request; a template is always text.
  const [asJson, setAsJson] = useState(false)
  const [focused, setFocused] = useState(false)
  const listable = (value === undefined || Array.isArray(value)) && !asJson
  const columnsList =
    component.type === 'table' && prop === 'columns' && (value === undefined || Array.isArray(value))
  const itemsList =
    component.type === 'navigation' && prop === 'items' && (value === undefined || Array.isArray(value))
  const jsonToggle = (columnsList || itemsList) && (
    <button
      type="button"
      className="rounded px-1 text-[11px] text-accent hover:underline"
      onClick={() => setAsJson(!asJson)}
    >
      {asJson ? 'Edit as list' : 'Edit as JSON'}
    </button>
  )
  const fx = (
    <button
      type="button"
      title={isTemplate(value) ? 'Use a fixed value' : 'Use a {{ }} expression'}
      className="rounded px-1 font-mono text-[11px] text-muted hover:bg-canvas hover:text-ink"
      onClick={() => set(isTemplate(value) ? undefined : `{{ ${JSON.stringify(value ?? spec.default)} }}`)}
    >
      fx
    </button>
  )

  let control: React.ReactNode
  if (spec.type === 'boolean' && !isTemplate(value)) {
    control = (
      <Checkbox
        label={spec.label}
        checked={value === true || (value === undefined && spec.default === true)}
        onChange={(e) => set(e.target.checked === spec.default ? undefined : e.target.checked)}
      />
    )
  } else if (typeof spec.type === 'object' && !isTemplate(value)) {
    control = (
      <Select
        aria-label={spec.label}
        value={String(value ?? spec.default)}
        onChange={(e) => set(e.target.value === spec.default ? undefined : e.target.value)}
      >
        {spec.type.enum.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </Select>
    )
  } else if (
    component.type === 'container' &&
    prop === 'views' &&
    (value === undefined || Array.isArray(value))
  ) {
    control = <ViewsEditor name={component.name} />
  } else if (columnsList && listable) {
    control = <ColumnsEditor name={component.name} index={index} columns={(value as JsonValue[]) ?? []} />
  } else if (itemsList && listable) {
    control = <NavItemsEditor name={component.name} items={(value as JsonValue[]) ?? []} />
  } else {
    control = (
      <ParsedField
        path={path}
        multiLine={multiLine}
        value={value}
        spec={spec}
        problems={problemsAt(diagnostics, path)}
        onChange={set}
      />
    )
  }
  const fixedKind = spec.type === 'boolean' || typeof spec.type === 'object'
  const aside = fixedKind ? (
    fx
  ) : component.type === 'table' && prop === 'columns' ? (
    <span className="flex items-center gap-1">
      <ColumnsFromData name={component.name} />
      {jsonToggle}
    </span>
  ) : itemsList ? (
    jsonToggle
  ) : undefined
  return (
    <EditorField
      label={spec.type === 'boolean' && !isTemplate(value) ? '' : spec.label}
      aside={aside}
      hint={
        value === undefined && !fixedKind && spec.default !== '' && spec.default !== null
          ? `Default: ${JSON.stringify(spec.default)}`
          : undefined
      }
    >
      {/* While a {{ }} field has the focus, what it evaluates to now shows under it (session 41). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: listens for focus moving in and out of the field inside */}
      <div
        className="contents"
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setFocused(false)
        }}
      >
        {control}
      </div>
      {focused && isTemplate(value) ? (
        <EvaluatedValue entityKey={`${component.name}.${prop}`} error={runtimeError} />
      ) : (
        runtimeError && <span className="text-xs text-danger">{runtimeError}</span>
      )}
      {fixedKind && <ProblemList path={path} />}
    </EditorField>
  )
}

/** Fills a table's columns in from its current data, to then make some editable or rename them. */
function ColumnsFromData({ name }: { name: string }) {
  const update = useAppEditor((s) => s.update)
  const data = useAppValue<unknown>(`${name}.data`)
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  return (
    <button
      type="button"
      disabled={!rows.length}
      title={rows.length ? 'List the columns of the current data' : 'The table has no data yet'}
      className="rounded px-1 text-[11px] text-accent hover:underline disabled:text-muted disabled:no-underline"
      onClick={() =>
        update((def) =>
          setProp(
            def,
            name,
            'columns',
            tableColumns([], rows).map((c) => ({
              key: c.key,
              label: c.label,
              type: c.type,
              editable: false,
            })),
          ),
        )
      }
    >
      From data
    </button>
  )
}

/** A prop typed as text: templates stay strings, constants are stored as their type, and the text stays as typed. */
function ParsedField({
  path,
  multiLine,
  value,
  spec,
  problems,
  onChange,
}: {
  path: (string | number)[]
  multiLine: boolean
  value: JsonValue | undefined
  spec: PropSpec
  problems: ReturnType<typeof problemsAt>
  onChange: (value: JsonValue | undefined) => void
}) {
  const [text, setText] = useParsedText(value, asText, (t) => fromText(t, spec), onChange)
  return (
    <AppCodeField
      path={path}
      // Parsed into the prop's value (a number, JSON or a template): not bound to a shared text.
      bind={false}
      language="plaintext"
      singleLine={!multiLine}
      height={multiLine ? 96 : 30}
      value={text}
      problems={problems}
      onChange={setText}
    />
  )
}

/** Which page something is on: one of the app's, or every page (null). */
export function PageSelect({
  value,
  onChange,
  className,
}: {
  value: string | null
  onChange: (page: string | null) => void
  className?: string
}) {
  const pages = useAppEditor((s) => s.definition.pages) ?? []
  const readOnly = useAppEditor((s) => s.readOnly)
  return (
    <Select
      aria-label="Page"
      disabled={readOnly}
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Every page</option>
      {pages.map((p) => (
        <option key={p.name} value={p.name}>
          {p.title ? `${p.title} (${p.name})` : p.name}
        </option>
      ))}
    </Select>
  )
}

function PageField(props: { value: string | null; onChange: (page: string | null) => void }) {
  return (
    <EditorField label="Page">
      <PageSelect {...props} />
    </EditorField>
  )
}

/** Props people set to decide what a component does, as opposed to what it shows or how it looks. */
const INTERACTION_PROPS = new Set([
  'disabled',
  'required',
  'loading',
  'formDataKey',
  'min',
  'max',
  'step',
  'rowSelection',
  'search',
  'showFilters',
  'allowAddRow',
  'paging',
  'pageSize',
  'resetAfterSubmit',
  'closeOnOutsideClick',
  'collapsible',
  'defaultExpanded',
  'accept',
  'multiple',
])
/** Props about how a component looks. */
const APPEARANCE_PROPS = new Set([
  'hidden',
  'variant',
  'orientation',
  'showBorder',
  'showTabs',
  'background',
  'padding',
  'scroll',
  'size',
  'stacked',
  'showLegend',
  'tone',
  'fit',
  'showValue',
  'expandDepth',
])

/** The inspector section a built-in component's prop goes in (session 41, after Retool's). */
export function propSection(prop: string): 'content' | 'interaction' | 'appearance' {
  if (INTERACTION_PROPS.has(prop)) return 'interaction'
  if (APPEARANCE_PROPS.has(prop)) return 'appearance'
  return 'content'
}

/** Which sections are folded, remembered per browser. */
function useFolded(title: string): [boolean, (folded: boolean) => void] {
  const key = `ow.appEditor.folded.${title}`
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  return [
    folded,
    (next) => {
      setFolded(next)
      try {
        if (next) localStorage.setItem(key, '1')
        else localStorage.removeItem(key)
      } catch {
        // Not remembered: private windows may refuse storage.
      }
    },
  ]
}

/** A foldable group of the inspector's fields. */
function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [folded, setFolded] = useFolded(title)
  return (
    <section aria-label={title} className="flex flex-col gap-3 border-t border-border pt-3">
      <h3>
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
          className={cn('flex w-full items-center gap-1 text-left', sectionLabelClass)}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', folded && '-rotate-90')} />
          {title}
        </button>
      </h3>
      {!folded && children}
    </section>
  )
}

/** A component's note for the app's editors: "Add a note", then the note. */
function NoteField({ name, note }: { name: string; note: string | undefined }) {
  const update = useAppEditor((s) => s.update)
  const [adding, setAdding] = useState(false)
  if (note === undefined && !adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-canvas hover:text-ink"
      >
        <StickyNote className="size-3.5" /> Add a note
      </button>
    )
  return (
    <Textarea
      aria-label="Note"
      placeholder="A note for the app's editors; people using the app don't see it"
      // biome-ignore lint/a11y/noAutofocus: opened by "Add a note", to type in it straight away
      autoFocus={adding}
      rows={2}
      className="min-h-0 bg-warning-soft/40 text-xs"
      value={note ?? ''}
      onChange={(e) => update((def) => setComponentNote(def, name, e.target.value))}
      // Open while it has the focus: an emptied note (removed from the definition) mustn't take the field away.
      onFocus={() => setAdding(true)}
      onBlur={() => setAdding(false)}
    />
  )
}

/** The inspector's ··· menu: copy, cut, duplicate, rename, switch type, reset state, delete. */
function ComponentMenu({ name, type, onDuplicate }: { name: string; type: string; onDuplicate: () => void }) {
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const readOnly = useAppEditor((s) => s.readOnly)
  const host = useAppHostContext()
  const switchable = switchableTypes(type)
  // The inspected component (with the others selected with it), whatever was chosen last: the open code item
  // mustn't be what's copied while the component is what's cut (review).
  const targets = () => {
    const { selection } = useAppEditor.getState()
    return selection.includes(name) ? selection : [name]
  }
  const copy = () => {
    const text = copyComponentsText(targets())
    if (text) void navigator.clipboard?.writeText(text).catch(() => {})
    return text
  }
  return (
    <Menu
      label={`${name} actions`}
      trigger={(props) => (
        <Button {...props} size="icon" variant="ghost" title="More actions">
          <MoreHorizontal className="size-4" />
        </Button>
      )}
    >
      <MenuItem icon={<Copy />} onClick={copy}>
        Copy <Kbd>⌘C</Kbd>
      </MenuItem>
      {!readOnly && (
        <>
          <MenuItem
            icon={<Scissors />}
            onClick={() => {
              const names = targets()
              if (!copy()) return
              update((def) => removeComponents(def, names))
              select(null)
            }}
          >
            Cut <Kbd>⌘X</Kbd>
          </MenuItem>
          <MenuItem icon={<CopyPlus />} onClick={onDuplicate}>
            Duplicate <Kbd>⌘D</Kbd>
          </MenuItem>
          <MenuItem
            icon={<Pencil />}
            onClick={() => {
              const field = document.querySelector<HTMLInputElement>(
                `[data-testid="inspector-${CSS.escape(name)}"] input[aria-label="Name"]`,
              )
              field?.focus()
              field?.select()
            }}
          >
            Rename
          </MenuItem>
          {switchable.length > 0 && (
            <>
              <MenuSeparator />
              <MenuGroup label="Switch to">
                {switchable.map((to) => (
                  <MenuItem
                    key={to}
                    icon={<Replace />}
                    onClick={() => update((def) => switchComponentType(def, name, to))}
                  >
                    {componentSpec(to)?.label ?? to}
                  </MenuItem>
                ))}
              </MenuGroup>
            </>
          )}
        </>
      )}
      <MenuSeparator />
      <MenuItem icon={<RotateCcw />} onClick={() => host.resetState([name])}>
        Reset state
      </MenuItem>
      {!readOnly && (
        <MenuItem
          danger
          icon={<Trash2 />}
          onClick={() => {
            update((def) => removeComponent(def, name))
            select(null)
          }}
        >
          Delete <Kbd>⌫</Kbd>
        </MenuItem>
      )}
    </Menu>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="float-right font-mono text-[11px] leading-5 text-muted">
      {children}
    </span>
  )
}

/** What a value is, as the live preview names it. */
export function valueKind(value: unknown): string {
  if (value === null) return 'Null'
  if (value === undefined) return 'Undefined'
  if (Array.isArray(value)) return `Array (${value.length})`
  if (typeof value === 'object') return 'Object'
  return typeof value === 'string' ? 'String' : typeof value === 'number' ? 'Number' : 'Boolean'
}

/** A value on one or a few lines for the live preview: strings as they are, the rest as JSON, cut short. */
export function previewText(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Under a focused {{ }} field: what it evaluates to now, and its kind (Retool's live preview). */
function EvaluatedValue({ entityKey, error }: { entityKey: string; error: string | undefined }) {
  const value = useAppValue<unknown>(entityKey)
  return (
    <div
      data-testid="evaluated-value"
      className={cn(
        'rounded-md border px-2 py-1.5 font-mono text-[11px]',
        error ? 'border-danger/40 bg-danger-soft/40' : 'border-border bg-canvas',
      )}
    >
      <div className="mb-0.5 font-sans text-[10px] font-medium text-muted uppercase">
        {error ? 'Error' : valueKind(value)}
      </div>
      <div className="max-h-24 overflow-auto break-all whitespace-pre-wrap">
        {error ?? previewText(value)}
      </div>
    </div>
  )
}
