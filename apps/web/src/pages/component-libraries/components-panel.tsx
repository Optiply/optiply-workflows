import type {
  ComponentLibraryDefinition,
  ComponentLibraryDiagnostic,
  CustomComponentDefinition,
  CustomPropDefinition,
  JsonValue,
} from '@ow/app-definition'
import { Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Card, Checkbox, ErrorNote, Field, Input, SectionLabel, Select } from '@/components/ui'
import { cn } from '@/lib/utils'

type Edit = (next: (d: ComponentLibraryDefinition) => ComponentLibraryDefinition) => void

const PROP_TYPES = ['string', 'number', 'boolean', 'array', 'object', 'any'] as const
const DEFAULTS: Record<(typeof PROP_TYPES)[number], JsonValue> = {
  string: '',
  number: 0,
  boolean: false,
  array: [],
  object: {},
  any: null,
}

/** A name not used yet: `base`, `base2`, … */
function fresh(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`
}

/**
 * The Components panel (M25): each component's name (how apps place it), label, entry file, default size and its
 * declared interface: props the app sets (with a test value for the preview), state the app reads, events whose
 * handlers the app runs, methods the app calls. Apps see exactly this; the code reads it through the SDK.
 */
export function ComponentsCard({
  definition,
  diagnostics,
  readOnly,
  edit,
}: {
  definition: ComponentLibraryDefinition
  diagnostics: ComponentLibraryDiagnostic[]
  readOnly: boolean
  edit: Edit
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const index = Math.max(
    0,
    definition.components.findIndex((c) => c.name === selected),
  )
  const component = definition.components[index]
  const editComponent = (change: (c: CustomComponentDefinition) => CustomComponentDefinition) =>
    edit((d) => ({ ...d, components: d.components.map((c, i) => (i === index ? change(c) : c)) }))
  const problems = (sub: (string | number)[]) =>
    diagnostics
      .filter(
        (d) => d.path[0] === 'components' && d.path[1] === index && sub.every((s, i) => d.path[2 + i] === s),
      )
      .map((d) => d.message)
  const codeFiles = definition.files.filter((f) => /\.(tsx|ts|jsx|js)$/.test(f.path)).map((f) => f.path)

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="library-components">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Components</SectionLabel>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const name = fresh(
                'Component',
                definition.components.map((c) => c.name),
              )
              edit((d) => ({
                ...d,
                components: [
                  ...d.components,
                  {
                    name,
                    label: name,
                    entry: codeFiles[0] ?? `src/${name}.tsx`,
                    props: {},
                    state: {},
                    events: [],
                    methods: {},
                    defaultSize: { w: 6, h: 20 },
                  },
                ],
              }))
              setSelected(name)
            }}
          >
            <Plus className="size-3.5" /> Add
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Components">
        {definition.components.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setSelected(c.name)}
            className={cn(
              'rounded px-2 py-1 font-mono text-xs hover:bg-subtle',
              i === index && 'bg-accent-soft text-accent',
              diagnostics.some((d) => d.path[0] === 'components' && d.path[1] === i) && 'text-danger',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>
      {!component && <p className="text-sm text-muted">No components yet: add one, then pick its file.</p>}
      {component && (
        <div className="flex flex-col gap-3" key={index}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name" hint="How apps place it">
              <NameInput
                value={component.name}
                disabled={readOnly}
                label="Component name"
                onCommit={(name) => {
                  editComponent((c) => ({ ...c, name }))
                  setSelected(name)
                }}
              />
            </Field>
            <Field label="Label">
              <Input
                value={component.label}
                disabled={readOnly}
                onChange={(e) => editComponent((c) => ({ ...c, label: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="File" hint="Its default export is the component">
            <Select
              aria-label="Entry file"
              value={component.entry}
              disabled={readOnly}
              onChange={(e) => editComponent((c) => ({ ...c, entry: e.target.value }))}
            >
              {!codeFiles.includes(component.entry) && (
                <option value={component.entry}>{component.entry}</option>
              )}
              {codeFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          {[...problems(['name']), ...problems(['entry'])].map((m) => (
            <ErrorNote key={m} error={m} />
          ))}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Width (of 12)">
              <Input
                type="number"
                min={1}
                max={12}
                value={component.defaultSize.w}
                disabled={readOnly}
                onChange={(e) =>
                  editComponent((c) => ({
                    ...c,
                    defaultSize: {
                      ...c.defaultSize,
                      w: Math.min(12, Math.max(1, Number(e.target.value) || 1)),
                    },
                  }))
                }
              />
            </Field>
            <Field label="Height (rows)">
              <Input
                type="number"
                min={1}
                value={component.defaultSize.h}
                disabled={readOnly}
                onChange={(e) =>
                  editComponent((c) => ({
                    ...c,
                    defaultSize: {
                      ...c.defaultSize,
                      h: Math.min(1000, Math.max(1, Number(e.target.value) || 1)),
                    },
                  }))
                }
              />
            </Field>
          </div>
          <Checkbox
            label="Grows with its content (Height: Auto in apps)"
            checked={!!component.autoHeight}
            disabled={readOnly}
            onChange={(e) =>
              editComponent((c) => {
                const { autoHeight: _, ...rest } = c
                return e.target.checked ? { ...rest, autoHeight: true } : rest
              })
            }
          />

          <SectionLabel>Props</SectionLabel>
          {Object.entries(component.props).map(([name, prop]) => (
            <PropRow
              key={name}
              name={name}
              prop={prop}
              readOnly={readOnly}
              problems={problems(['props', name])}
              onChange={(next) => editComponent((c) => ({ ...c, props: { ...c.props, [name]: next } }))}
              onRename={(to) =>
                editComponent((c) => ({
                  ...c,
                  props: Object.fromEntries(
                    Object.entries(c.props).map(([k, v]) => [k === name ? to : k, v]),
                  ),
                }))
              }
              onRemove={() =>
                editComponent((c) => {
                  const { [name]: _, ...props } = c.props
                  return { ...c, props }
                })
              }
            />
          ))}
          {!readOnly && (
            <AddName
              label="Add prop"
              taken={Object.keys(component.props)}
              base="prop"
              onAdd={(name) =>
                editComponent((c) => ({
                  ...c,
                  props: { ...c.props, [name]: { type: 'string', default: '', label: name } },
                }))
              }
            />
          )}

          <SectionLabel>State</SectionLabel>
          {Object.entries(component.state).map(([name, state]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-28 truncate font-mono text-xs">{name}</span>
              <JsonInput
                label={`Default of ${name}`}
                value={state.default}
                disabled={readOnly}
                onCommit={(value) =>
                  editComponent((c) => ({ ...c, state: { ...c.state, [name]: { default: value ?? null } } }))
                }
              />
              {!readOnly && (
                <RemoveButton
                  what={name}
                  onRemove={() =>
                    editComponent((c) => {
                      const { [name]: _, ...state } = c.state
                      return { ...c, state }
                    })
                  }
                />
              )}
            </div>
          ))}
          {problems(['state']).map((m) => (
            <ErrorNote key={m} error={m} />
          ))}
          {!readOnly && (
            <AddName
              label="Add state"
              taken={Object.keys(component.state)}
              base="value"
              onAdd={(name) =>
                editComponent((c) => ({ ...c, state: { ...c.state, [name]: { default: null } } }))
              }
            />
          )}

          <SectionLabel>Events</SectionLabel>
          <div className="flex flex-wrap items-center gap-1">
            {component.events.map((event) => (
              <span
                key={event}
                className="flex items-center gap-1 rounded bg-subtle px-2 py-0.5 font-mono text-xs"
              >
                {event}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Remove event ${event}`}
                    onClick={() =>
                      editComponent((c) => ({ ...c, events: c.events.filter((e) => e !== event) }))
                    }
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {problems(['events']).map((m) => (
            <ErrorNote key={m} error={m} />
          ))}
          {!readOnly && (
            <AddName
              label="Add event"
              taken={component.events}
              base="change"
              onAdd={(name) => editComponent((c) => ({ ...c, events: [...c.events, name] }))}
            />
          )}

          <SectionLabel>Methods</SectionLabel>
          {Object.entries(component.methods).map(([name, method]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-28 truncate font-mono text-xs">{name}(</span>
              <Input
                aria-label={`Parameters of ${name}`}
                className="h-8 flex-1 font-mono text-xs"
                value={method.params.join(', ')}
                disabled={readOnly}
                placeholder="parameters"
                onChange={(e) =>
                  editComponent((c) => ({
                    ...c,
                    methods: {
                      ...c.methods,
                      [name]: {
                        params: e.target.value
                          .split(',')
                          .map((p) => p.trim())
                          .filter(Boolean),
                      },
                    },
                  }))
                }
              />
              <span className="font-mono text-xs">)</span>
              {!readOnly && (
                <RemoveButton
                  what={name}
                  onRemove={() =>
                    editComponent((c) => {
                      const { [name]: _, ...methods } = c.methods
                      return { ...c, methods }
                    })
                  }
                />
              )}
            </div>
          ))}
          {problems(['methods']).map((m) => (
            <ErrorNote key={m} error={m} />
          ))}
          {!readOnly && (
            <AddName
              label="Add method"
              taken={Object.keys(component.methods)}
              base="method"
              onAdd={(name) =>
                editComponent((c) => ({ ...c, methods: { ...c.methods, [name]: { params: [] } } }))
              }
            />
          )}

          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start text-danger"
              onClick={async () => {
                if (
                  !(await confirmDialog(`Remove ${component.name}? Apps placing it stop showing it.`, {
                    danger: true,
                  }))
                )
                  return
                edit((d) => ({ ...d, components: d.components.filter((_, i) => i !== index) }))
                setSelected(null)
              }}
            >
              <Trash2 className="size-3.5" /> Remove {component.name}
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}

function PropRow({
  name,
  prop,
  readOnly,
  problems,
  onChange,
  onRename,
  onRemove,
}: {
  name: string
  prop: CustomPropDefinition
  readOnly: boolean
  problems: string[]
  onChange: (prop: CustomPropDefinition) => void
  onRename: (to: string) => void
  onRemove: () => void
}) {
  const typeName = typeof prop.type === 'object' ? 'enum' : prop.type
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2" data-testid={`prop-${name}`}>
      <div className="flex items-center gap-2">
        <NameInput
          value={name}
          disabled={readOnly}
          label={`Name of prop ${name}`}
          onCommit={onRename}
          small
        />
        <Select
          aria-label={`Type of ${name}`}
          className="h-8 w-28 text-xs"
          value={typeName}
          disabled={readOnly}
          onChange={(e) => {
            const t = e.target.value
            if (t === 'enum') onChange({ ...prop, type: { enum: ['a', 'b'] }, default: 'a' })
            else {
              const type = t as (typeof PROP_TYPES)[number]
              onChange({ ...prop, type, default: DEFAULTS[type] })
            }
          }}
        >
          {[...PROP_TYPES, 'enum'].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        {!readOnly && <RemoveButton what={name} onRemove={onRemove} />}
      </div>
      {typeof prop.type === 'object' && (
        <Input
          aria-label={`Values of ${name}`}
          className="h-8 font-mono text-xs"
          value={prop.type.enum.join(', ')}
          disabled={readOnly}
          onChange={(e) => {
            const values = e.target.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
            if (values.length) onChange({ ...prop, type: { enum: values } })
          }}
        />
      )}
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted">
        <span>Default</span>
        <span>Test value (preview)</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <JsonInput
          label={`Default of ${name}`}
          value={prop.default}
          disabled={readOnly}
          onCommit={(v) => onChange({ ...prop, default: v ?? null })}
        />
        <JsonInput
          label={`Test value of ${name}`}
          placeholder="test value"
          value={prop.testValue}
          disabled={readOnly}
          onCommit={(v) => {
            const { testValue: _, ...rest } = prop
            onChange(v === undefined ? rest : { ...rest, testValue: v })
          }}
        />
      </div>
      {problems.map((m) => (
        <ErrorNote key={m} error={m} />
      ))}
    </div>
  )
}

/** JSON typed as text, committed when it parses (a plain word counts as a string); empty is undefined. */
function JsonInput({
  value,
  onCommit,
  label,
  disabled,
  placeholder,
}: {
  value: JsonValue | undefined
  onCommit: (value: JsonValue | undefined) => void
  label: string
  disabled?: boolean
  placeholder?: string
}) {
  const shown = value === undefined ? '' : JSON.stringify(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    const trimmed = text.trim()
    if (!trimmed) return onCommit(undefined)
    try {
      onCommit(JSON.parse(trimmed) as JsonValue)
    } catch {
      onCommit(trimmed)
    }
  }
  return (
    <Input
      aria-label={label}
      className="h-8 flex-1 font-mono text-xs"
      value={text}
      placeholder={placeholder ?? 'default'}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

/** A name edited as text, committed on blur or Enter when it changed. */
function NameInput({
  value,
  onCommit,
  label,
  disabled,
  small,
}: {
  value: string
  onCommit: (name: string) => void
  label: string
  disabled?: boolean
  small?: boolean
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const name = text.trim()
    if (name && name !== value) onCommit(name)
    else setText(value)
  }
  return (
    <Input
      aria-label={label}
      className={cn('font-mono', small && 'h-8 flex-1 text-xs')}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

function AddName({
  label,
  base,
  taken,
  onAdd,
}: {
  label: string
  base: string
  taken: readonly string[]
  onAdd: (name: string) => void
}) {
  return (
    <Button size="sm" variant="ghost" className="self-start" onClick={() => onAdd(fresh(base, taken))}>
      <Plus className="size-3.5" /> {label}
    </Button>
  )
}

function RemoveButton({ what, onRemove }: { what: string; onRemove: () => void }) {
  return (
    <Button size="icon" variant="ghost" title={`Remove ${what}`} onClick={onRemove}>
      <X className="size-3.5" />
    </Button>
  )
}
