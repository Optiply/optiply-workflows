import {
  type AppComponent,
  componentSpec,
  type JsonValue,
  moveToParent,
  type PropSpec,
  removeComponent,
  setHandlers,
  setProp,
  withDescendants,
} from '@ow/app-definition'
import { Trash2 } from 'lucide-react'
import { Button, Checkbox, Select } from '@/components/ui'
import { tableColumns } from '../components/table-model'
import { useAppError, useAppValue } from '../runtime/react'
import { AppCodeField, EditorField, NameField, ProblemList, problemsAt } from './fields'
import { HandlersEditor } from './handlers'
import { useAppEditor } from './store'

/** Everything about the selected component: name, parent, props and event handlers. */
export function ComponentInspector({ name }: { name: string }) {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const index = definition.components.findIndex((c) => c.name === name)
  const component = definition.components[index]
  if (!component) return null
  const spec = componentSpec(component.type)
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
            onChange={(e) => update((def) => moveToParent(def, name, e.target.value || undefined))}
          >
            <option value="">The page</option>
            {parents.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </Select>
        </EditorField>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Properties</h3>
        {Object.entries(spec.props).map(([prop, propSpec]) => (
          <PropField key={prop} component={component} index={index} prop={prop} spec={propSpec} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Event handlers</h3>
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
  } else {
    control = (
      <AppCodeField
        path={path}
        language="plaintext"
        singleLine={!multiLine}
        height={multiLine ? 96 : 30}
        value={asText(value)}
        problems={problemsAt(diagnostics, path)}
        onChange={(text) => set(fromText(text, spec))}
      />
    )
  }
  const fixedKind = spec.type === 'boolean' || typeof spec.type === 'object'
  const aside = fixedKind ? (
    fx
  ) : component.type === 'table' && prop === 'columns' ? (
    <ColumnsFromData name={component.name} />
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
