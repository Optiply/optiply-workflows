import {
  type AppComponent,
  componentSpec,
  type JsonValue,
  MODULE_PROPS,
  moveToParent,
  type PropSpec,
  removeComponent,
  setEntityPage,
  setHandlers,
  setProp,
  withDescendants,
} from '@ow/app-definition'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Select, sectionLabelClass } from '@/components/ui'
import { tableColumns } from '../components/table-model'
import { useAppError, useAppValue } from '../runtime/react'
import { ColumnsEditor } from './columns'
import { AppCodeField, EditorField, NameField, ProblemList, problemsAt, useParsedText } from './fields'
import { HandlersEditor } from './handlers'
import { ModuleInstanceFields } from './modules'
import { specOf, useAppEditor } from './store'

/** Everything about the selected component: name, parent, props and event handlers. */
export function ComponentInspector({ name }: { name: string }) {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const page = useAppEditor((s) => s.url.page)
  const modules = useAppEditor((s) => s.modules)
  const index = definition.components.findIndex((c) => c.name === name)
  const component = definition.components[index]
  if (!component) return null
  const spec = specOf(component, modules)
  const instance = component.type === 'module'
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

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={`inspector-${name}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <NameField name={name} onRenamed={select} />
          <div className="mt-1 text-xs text-muted">{spec.label}</div>
        </div>
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

      {!spec.overlay && (
        <EditorField label="Inside">
          <Select
            aria-label="Inside"
            value={component.parent ?? ''}
            onChange={(e) => update((def) => moveToParent(def, name, e.target.value || undefined, { page }))}
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

      {definition.pages?.length && component.parent === undefined ? (
        <PageField
          value={component.page ?? null}
          onChange={(to) => update((def) => setEntityPage(def, name, to))}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className={sectionLabelClass}>{instance ? 'Module' : 'Properties'}</h3>
        {instance && <ModuleInstanceFields component={component} index={index} />}
        {Object.entries(spec.props)
          // An instance's module and version have their own fields; the rest are the module's inputs.
          .filter(([prop]) => !instance || !(MODULE_PROPS as readonly string[]).includes(prop))
          .map(([prop, propSpec]) => (
            <PropField key={prop} component={component} index={index} prop={prop} spec={propSpec} />
          ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={sectionLabelClass}>Event handlers</h3>
        <HandlersEditor
          handlers={component.events ?? []}
          events={spec.events}
          base={[...base, 'events']}
          onChange={(events) => update((def) => setHandlers(def, name, events))}
        />
      </section>
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
  // A table's columns as a list (M24), or as JSON on request; a template is always text.
  const [asJson, setAsJson] = useState(false)
  const columnsList =
    component.type === 'table' && prop === 'columns' && (value === undefined || Array.isArray(value))
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
  } else if (columnsList && !asJson) {
    control = <ColumnsEditor name={component.name} index={index} columns={(value as JsonValue[]) ?? []} />
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
      {columnsList && (
        <button
          type="button"
          className="rounded px-1 text-[11px] text-accent hover:underline"
          onClick={() => setAsJson(!asJson)}
        >
          {asJson ? 'Edit as list' : 'Edit as JSON'}
        </button>
      )}
    </span>
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
      {control}
      {runtimeError && <span className="text-xs text-danger">{runtimeError}</span>}
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
