import { useMutation, useQuery } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Checkbox, Dialog, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { errorMessage, useTRPC } from '@/lib/trpc'
import { type Column, columnLabel, type TableInfo, TYPE_LABELS } from './cells'

export type ColumnType = Exclude<Column['type'], 'other'>
export const COLUMN_TYPES = Object.keys(TYPE_LABELS).filter((t) => t !== 'other') as ColumnType[]
const EXPRESSIONS = ['now()', 'current_date', 'gen_random_uuid()'] as const
type Expression = (typeof EXPRESSIONS)[number]

/** A default as the editor sets it: none, a fixed value, or one Postgres computes. */
export type DefaultSpec =
  | { kind: 'none' }
  | { kind: 'value'; value: string }
  | { kind: 'expression'; expression: Expression }

/**
 * Retool's column presets. Most are a type (Checkbox is a boolean, Number a decimal); UUID and Created time also
 * get a default Postgres fills in; Auto-incrementing Integer ID is numbered by Postgres; Enum is text limited to a
 * list; Foreign key takes the type of the column it references; Custom is any Postgres type by name.
 */
export type Preset =
  | 'uuid'
  | 'autoId'
  | 'createdTime'
  | 'text'
  | 'boolean'
  | 'enum'
  | 'number'
  | 'integer'
  | 'bigint'
  | 'json'
  | 'date'
  | 'datetime'
  | 'foreignKey'
  | 'custom'

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'uuid', label: 'UUID' },
  { id: 'autoId', label: 'Auto-incrementing Integer ID' },
  { id: 'createdTime', label: 'Created time' },
  { id: 'text', label: 'Text' },
  { id: 'boolean', label: 'Checkbox' },
  { id: 'enum', label: 'Enum' },
  { id: 'number', label: 'Number' },
  { id: 'integer', label: 'Integer' },
  { id: 'bigint', label: 'Big integer' },
  { id: 'json', label: 'JSON' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date + Time' },
  { id: 'foreignKey', label: 'Foreign key' },
  { id: 'custom', label: 'Custom' },
]

/** The type a preset stores as (a foreign key's and a custom column's are worked out by the server). */
const PRESET_TYPES: Record<Preset, ColumnType | 'foreignKey' | 'custom'> = {
  uuid: 'uuid',
  autoId: 'integer',
  createdTime: 'datetime',
  text: 'text',
  boolean: 'boolean',
  enum: 'text',
  number: 'decimal',
  integer: 'integer',
  bigint: 'bigint',
  json: 'json',
  date: 'date',
  datetime: 'datetime',
  foreignKey: 'foreignKey',
  custom: 'custom',
}

/** The default a preset starts with. */
function presetDefault(preset: Preset): DefaultSpec {
  if (preset === 'uuid') return { kind: 'expression', expression: 'gen_random_uuid()' }
  if (preset === 'createdTime') return { kind: 'expression', expression: 'now()' }
  return { kind: 'none' }
}

export const ON_DELETE = [
  { id: 'no action', label: 'Refuse the delete' },
  { id: 'cascade', label: 'Delete these rows too' },
  { id: 'set null', label: 'Empty this column' },
] as const
export type OnDelete = 'no action' | 'restrict' | 'cascade' | 'set null'

/** What a preset needs besides the type: the enum's values, the referenced column, the custom type's name. */
export interface PresetExtras {
  enumValues: string[]
  references: { table: string; column: string; onDelete: OnDelete }
  sqlType: string
}

export interface ColumnSpec extends PresetExtras {
  name: string
  preset: Preset
  nullable: boolean
  unique: boolean
  default: DefaultSpec
}

const blankExtras = (): PresetExtras => ({
  enumValues: [],
  references: { table: '', column: '', onDelete: 'no action' },
  sqlType: '',
})

/** The preset an existing column reads as, and its extras. */
export function presetOf(column: Column): Preset {
  if (column.identity) return 'autoId'
  if (column.references) return 'foreignKey'
  if (column.enumValues) return 'enum'
  if (column.type === 'other') return 'custom'
  if (column.type === 'decimal') return 'number'
  if (
    column.type === 'datetime' &&
    column.default.kind === 'expression' &&
    column.default.expression === 'now()'
  )
    return 'createdTime'
  return column.type
}

function extrasOf(column: Column): PresetExtras {
  return {
    enumValues: column.enumValues ?? [],
    references: column.references ?? { table: '', column: '', onDelete: 'no action' },
    sqlType: column.type === 'other' ? column.sqlType : '',
  }
}

/** An enum's lines as values: trimmed, blank lines left out. */
const cleanValues = (lines: string[]) => lines.map((v) => v.trim()).filter(Boolean)

/** What's missing for the preset, or null. */
function extrasProblem(preset: Preset, extras: PresetExtras): string | null {
  const values = cleanValues(extras.enumValues)
  if (preset === 'enum' && !values.length) return 'Give the enum at least one value'
  if (preset === 'enum' && new Set(values).size !== values.length) return 'The enum has the same value twice'
  if (preset === 'foreignKey' && (!extras.references.table || !extras.references.column))
    return 'Choose the table and column the foreign key references'
  if (preset === 'custom' && !extras.sqlType.trim()) return 'Write the Postgres type, e.g. varchar(20)'
  return null
}

/** A new column as the server takes it. */
function toServerColumn(spec: ColumnSpec) {
  const type = PRESET_TYPES[spec.preset]
  return {
    name: spec.name,
    type,
    nullable: spec.nullable,
    unique: spec.unique,
    default: spec.preset === 'autoId' ? ({ kind: 'none' } as const) : spec.default,
    ...(spec.preset === 'autoId' && { identity: true }),
    ...(spec.preset === 'enum' && { enumValues: cleanValues(spec.enumValues) }),
    ...(spec.preset === 'foreignKey' && { references: spec.references }),
    ...(spec.preset === 'custom' && { sqlType: spec.sqlType.trim() }),
  }
}

/** The preset picker. Auto-incrementing IDs are made with a new column only. */
function PresetSelect({
  value,
  onChange,
  includeAutoId = true,
  className,
  disabled,
}: {
  value: Preset
  onChange: (preset: Preset) => void
  includeAutoId?: boolean
  className?: string
  disabled?: boolean
}) {
  return (
    <Select
      aria-label="Preset"
      className={className}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Preset)}
    >
      {PRESETS.filter((p) => includeAutoId || p.id !== 'autoId' || value === 'autoId').map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </Select>
  )
}

/** The preset's own fields: the enum's values, the referenced table and column, or the custom type. */
function PresetFields({
  environmentId,
  preset,
  value,
  onChange,
  ownTable,
}: {
  environmentId: string
  preset: Preset
  value: PresetExtras
  onChange: (patch: Partial<PresetExtras>) => void
  /** The table being edited, which can't be referenced from its own dialog before it exists. */
  ownTable?: string
}) {
  const trpc = useTRPC()
  const tables = useQuery({
    ...trpc.database.tables.queryOptions({ environmentId }),
    enabled: preset === 'foreignKey',
  })
  if (preset === 'enum') {
    return (
      <Field
        label="Values"
        hint="One per line. The column only takes these (or empty, unless it's required)."
      >
        <Textarea
          aria-label="Enum values"
          rows={4}
          value={value.enumValues.join('\n')}
          placeholder={'open\nin progress\ndone'}
          onChange={(e) => onChange({ enumValues: e.target.value.split('\n') })}
          onBlur={() => onChange({ enumValues: cleanValues(value.enumValues) })}
        />
      </Field>
    )
  }
  if (preset === 'foreignKey') {
    const target = tables.data?.find((t) => t.name === value.references.table)
    // Postgres only lets a key or unique column be referenced.
    const keys = target?.columns.filter((c) => c.unique) ?? []
    return (
      <div className="flex flex-wrap gap-3">
        <Field label="References table" className="min-w-40 flex-1">
          <Select
            aria-label="Referenced table"
            value={value.references.table}
            onChange={(e) => {
              const table = tables.data?.find((t) => t.name === e.target.value)
              const key = table?.columns.find((c) => c.primaryKey) ?? table?.columns.find((c) => c.unique)
              onChange({
                references: { ...value.references, table: e.target.value, column: key?.name ?? '' },
              })
            }}
          >
            <option value="">Choose a table…</option>
            {tables.data
              ?.filter((t) => t.name !== ownTable)
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field
          label="Column"
          className="min-w-32 flex-1"
          hint={target && !keys.length ? 'No key or unique column' : undefined}
        >
          <Select
            aria-label="Referenced column"
            value={value.references.column}
            disabled={!target}
            onChange={(e) => onChange({ references: { ...value.references, column: e.target.value } })}
          >
            {!value.references.column && <option value="">Choose…</option>}
            {keys.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="When that row is deleted" className="min-w-44 flex-1">
          <Select
            aria-label="On delete"
            value={value.references.onDelete === 'restrict' ? 'no action' : value.references.onDelete}
            onChange={(e) =>
              onChange({ references: { ...value.references, onDelete: e.target.value as OnDelete } })
            }
          >
            {ON_DELETE.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    )
  }
  if (preset === 'custom') {
    return (
      <Field label="Postgres type" hint="Any type Postgres knows, e.g. varchar(20), smallint, inet, text[]">
        <Input
          aria-label="Postgres type"
          className="font-mono"
          value={value.sqlType}
          placeholder="varchar(20)"
          onChange={(e) => onChange({ sqlType: e.target.value })}
        />
      </Field>
    )
  }
  return null
}

/** What new names may be (the server checks the same). */
export function nameProblem(name: string): string | null {
  if (!name) return 'Give it a name'
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    return 'Lowercase letters, digits and underscores; not starting with a digit'
  if (name.startsWith('pg_')) return 'Names starting with pg_ are reserved'
  return null
}

const blankColumn = (): ColumnSpec => ({
  name: '',
  preset: 'text',
  nullable: true,
  unique: false,
  default: { kind: 'none' },
  ...blankExtras(),
})

/** The default, chosen from a list (no default, a value, now(), …), with a value box when it's a value. */
function DefaultEditor({
  value,
  onChange,
  current,
}: {
  value: DefaultSpec | { kind: 'other'; expression: string }
  onChange: (value: DefaultSpec) => void
  /** A default made in SQL that the editor can't express: kept unless replaced. */
  current?: string
}) {
  const choice = value.kind === 'expression' ? value.expression : value.kind
  return (
    <div className="flex gap-2">
      <Select
        aria-label="Default"
        className="w-44"
        value={choice}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'none' || v === 'other') onChange({ kind: 'none' })
          else if (v === 'value') onChange({ kind: 'value', value: '' })
          else onChange({ kind: 'expression', expression: v as Expression })
        }}
      >
        <option value="none">No default</option>
        <option value="value">A value…</option>
        {EXPRESSIONS.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
        {value.kind === 'other' && <option value="other">Set in SQL: {current}</option>}
      </Select>
      {value.kind === 'value' && (
        <Input
          aria-label="Default value"
          className="flex-1"
          value={value.value}
          onChange={(e) => onChange({ kind: 'value', value: e.target.value })}
        />
      )}
    </div>
  )
}

/** Creates a table: a name and its columns (an id key is always added). */
export function NewTableDialog({
  environmentId,
  onClose,
  onCreated,
}: {
  environmentId: string
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const trpc = useTRPC()
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<ColumnSpec[]>([blankColumn()])
  const [tried, setTried] = useState(false)
  const create = useMutation(trpc.database.createTable.mutationOptions())
  const update = (i: number, patch: Partial<ColumnSpec>) =>
    setColumns(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const used = columns.filter((c) => c.name !== '')
  const problems = [
    nameProblem(name) && `Table: ${nameProblem(name)}`,
    ...used.map((c) => (nameProblem(c.name) ? `${c.name}: ${nameProblem(c.name)}` : null)),
    used.some((c) => c.name === 'id') && 'Every table already has an id column',
    new Set(used.map((c) => c.name)).size !== used.length && 'Two columns have the same name',
    ...used.map((c) => {
      const problem = extrasProblem(c.preset, c)
      return problem && `${c.name}: ${problem}`
    }),
  ].filter(Boolean)

  const submit = async () => {
    setTried(true)
    if (problems.length) return
    try {
      await create.mutateAsync({ environmentId, name, columns: used.map(toServerColumn) })
      onCreated(name)
      onClose()
    } catch {
      // Shown below.
    }
  }

  return (
    <Dialog
      title="New table"
      className="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create table
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Lowercase letters, digits and underscores, e.g. purchase_orders">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-medium">Columns</div>
          <p className="mb-2 text-xs text-muted">
            An <code>id</code> column, numbered automatically, is the first column of every table.
          </p>
          <div className="space-y-2">
            {columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns being typed have no identity but their place
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
                <Input
                  aria-label="Column name"
                  placeholder="column_name"
                  className="w-44"
                  value={c.name}
                  onChange={(e) => update(i, { name: e.target.value.trim() })}
                />
                <PresetSelect
                  className="w-56"
                  value={c.preset}
                  onChange={(preset) => update(i, { preset, default: presetDefault(preset) })}
                />
                <Checkbox
                  label="Required"
                  checked={!c.nullable}
                  onChange={(e) => update(i, { nullable: !e.target.checked })}
                />
                <Checkbox
                  label="Unique"
                  checked={c.unique}
                  onChange={(e) => update(i, { unique: e.target.checked })}
                />
                {c.preset !== 'autoId' && (
                  <div className="min-w-64 flex-1">
                    <DefaultEditor value={c.default} onChange={(d) => update(i, { default: d })} />
                  </div>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  title="Remove column"
                  onClick={() => setColumns(columns.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
                {(c.preset === 'enum' || c.preset === 'foreignKey' || c.preset === 'custom') && (
                  <div className="w-full">
                    <PresetFields
                      environmentId={environmentId}
                      preset={c.preset}
                      value={c}
                      onChange={(patch) => update(i, patch)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => setColumns([...columns, blankColumn()])}
          >
            <Plus className="size-4" /> Add column
          </Button>
        </div>
        {tried && problems.length > 0 && <ErrorNote error={problems.join('\n')} />}
        <ErrorNote error={create.error} />
      </div>
    </Dialog>
  )
}

/**
 * Adds a column, or changes one: its name, type (existing values are converted; one that doesn't convert stops
 * the change), whether it's required or unique, and its default.
 */
export function ColumnDialog({
  environmentId,
  table,
  column,
  onClose,
  onChanged,
}: {
  environmentId: string
  table: TableInfo
  /** The column to change; none to add one. */
  column?: Column
  onClose: () => void
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const [name, setName] = useState(column?.name ?? '')
  const [preset, setPreset] = useState<Preset>(column ? presetOf(column) : 'text')
  const [extras, setExtras] = useState<PresetExtras>(column ? extrasOf(column) : blankExtras())
  const [nullable, setNullable] = useState(column?.nullable ?? true)
  const [unique, setUnique] = useState(column?.unique ?? false)
  const [fallback, setFallback] = useState<DefaultSpec | { kind: 'other'; expression: string }>(
    column?.default ?? { kind: 'none' },
  )
  const [error, setError] = useState<string | null>(null)
  const add = useMutation(trpc.database.addColumn.mutationOptions())
  const rename = useMutation(trpc.database.renameColumn.mutationOptions())
  const alter = useMutation(trpc.database.alterColumn.mutationOptions())
  const busy = add.isPending || rename.isPending || alter.isPending
  const original = column ? presetOf(column) : undefined

  const choosePreset = (next: Preset) => {
    setPreset(next)
    // UUID and Created time bring their default; leaving them drops it.
    if (next === 'uuid' || next === 'createdTime') setFallback(presetDefault(next))
    else if (preset === 'uuid' || preset === 'createdTime') setFallback({ kind: 'none' })
  }

  const submit = async () => {
    const problem = (name !== column?.name ? nameProblem(name) : null) ?? extrasProblem(preset, extras)
    if (problem) return setError(problem)
    if (name === 'id' && name !== column?.name) return setError('Every table already has an id column')
    setError(null)
    try {
      if (!column) {
        await add.mutateAsync({
          environmentId,
          table: table.name,
          column: toServerColumn({
            name,
            preset,
            nullable,
            unique,
            default: fallback.kind === 'other' ? { kind: 'none' } : fallback,
            ...extras,
          }),
        })
      } else {
        if (name !== column.name) {
          await rename.mutateAsync({ environmentId, table: table.name, column: column.name, to: name })
        }
        const change: Record<string, unknown> = { ...presetChange(column, original!, preset, extras) }
        if (nullable !== column.nullable) change.nullable = nullable
        if (unique !== column.unique) change.unique = unique
        if (fallback.kind !== 'other' && JSON.stringify(fallback) !== JSON.stringify(column.default)) {
          change.default = fallback
        }
        if (Object.keys(change).length) {
          await alter.mutateAsync({ environmentId, table: table.name, column: name, change })
        }
      }
      onChanged()
      onClose()
    } catch (err) {
      // A rename that went through before a refused change still counts: refresh either way.
      onChanged()
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog
      title={column ? `Edit ${column.name}` : `Add a column to ${table.name}`}
      className="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {column ? 'Save' : 'Add column'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
        </Field>
        <Field
          label="Preset"
          hint={
            column?.identity
              ? 'Numbered by Postgres; its type stays.'
              : column && (preset !== original || JSON.stringify(extras) !== JSON.stringify(extrasOf(column)))
                ? 'Existing values are converted; if one does not fit, nothing changes.'
                : undefined
          }
        >
          <PresetSelect
            value={preset}
            onChange={choosePreset}
            includeAutoId={!column}
            disabled={column?.identity}
          />
        </Field>
        <PresetFields
          environmentId={environmentId}
          preset={preset}
          value={extras}
          onChange={(patch) => setExtras({ ...extras, ...patch })}
          ownTable={table.name}
        />
        <div className="flex gap-6">
          <Checkbox label="Required" checked={!nullable} onChange={(e) => setNullable(!e.target.checked)} />
          <Checkbox label="Unique" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        </div>
        {preset !== 'autoId' && (
          <Field label="Default" hint="What new rows get when they leave this column out.">
            <DefaultEditor
              value={fallback}
              onChange={setFallback}
              current={fallback.kind === 'other' ? fallback.expression : undefined}
            />
          </Field>
        )}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  )
}

/**
 * The type part of a change to an existing column, from the preset it had to the one chosen: a new type, an
 * enum's values (null: plain text again), a foreign key's target, or a custom type's name.
 */
function presetChange(
  column: Column,
  from: Preset,
  to: Preset,
  extras: PresetExtras,
): Record<string, unknown> {
  if (column.identity) return {}
  const was = extrasOf(column)
  if (to === 'custom') {
    return from !== 'custom' || extras.sqlType.trim() !== was.sqlType
      ? { type: 'custom', sqlType: extras.sqlType.trim() }
      : {}
  }
  if (to === 'foreignKey') {
    if (from !== 'foreignKey') return { type: 'foreignKey', references: extras.references }
    return JSON.stringify(extras.references) !== JSON.stringify(was.references)
      ? { references: extras.references }
      : {}
  }
  const type = PRESET_TYPES[to] as ColumnType
  const change: Record<string, unknown> = {}
  // Leaving a foreign key (even for the same type) takes the key off.
  if (type !== column.type || from === 'foreignKey') change.type = type
  if (to === 'enum') {
    const values = cleanValues(extras.enumValues)
    if (JSON.stringify(values) !== JSON.stringify(column.enumValues)) change.enumValues = values
  } else if (column.enumValues) {
    change.enumValues = null
  }
  return change
}

/** A table's shape: rename or delete it, and add, change or delete its columns. */
export function SchemaDialog({
  environmentId,
  table,
  onClose,
  onChanged,
  onRenamed,
  onDropped,
}: {
  environmentId: string
  table: TableInfo
  onClose: () => void
  onChanged: () => void
  onRenamed: (name: string) => void
  onDropped: () => void
}) {
  const trpc = useTRPC()
  const [name, setName] = useState(table.name)
  const [editing, setEditing] = useState<Column | 'new' | null>(null)
  const rename = useMutation(trpc.database.renameTable.mutationOptions())
  const drop = useMutation(trpc.database.dropTable.mutationOptions())
  const dropColumn = useMutation(trpc.database.dropColumn.mutationOptions({ onSuccess: onChanged }))
  const problem = name !== table.name ? nameProblem(name) : null

  if (editing) {
    return (
      <ColumnDialog
        environmentId={environmentId}
        table={table}
        column={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    )
  }
  return (
    <Dialog title={`Table ${table.name}`} className="max-w-2xl" onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-end gap-2">
          <Field label="Name" className="flex-1" hint={problem ?? undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          <Button
            disabled={name === table.name || Boolean(problem)}
            loading={rename.isPending}
            onClick={() =>
              rename.mutate(
                { environmentId, table: table.name, to: name },
                { onSuccess: () => onRenamed(name) },
              )
            }
          >
            Rename
          </Button>
        </div>
        <ErrorNote error={rename.error} />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Columns</span>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add column
            </Button>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {table.columns.map((c) => (
              <li
                key={c.name}
                className="flex items-center gap-3 px-3 py-2 text-sm"
                data-testid={`schema-column-${c.name}`}
              >
                <span className="w-40 truncate font-medium">{c.name}</span>
                <span className="w-36 truncate text-muted" title={c.sqlType}>
                  {columnLabel(c)}
                </span>
                {(() => {
                  const details = [
                    c.primaryKey && 'key',
                    !c.nullable && !c.primaryKey && 'required',
                    c.unique && !c.primaryKey && 'unique',
                    c.default.kind === 'value' && `default ${c.default.value}`,
                    (c.default.kind === 'expression' || c.default.kind === 'other') &&
                      `default ${c.default.expression}`,
                    c.enumValues?.join(', '),
                    c.references &&
                      `${c.references.table}.${c.references.column}, on delete ${c.references.onDelete}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <span className="flex-1 truncate text-xs text-muted" title={details}>
                      {details}
                    </span>
                  )
                })()}
                {!c.primaryKey && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={`Edit ${c.name}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={`Delete ${c.name}`}
                      onClick={async () => {
                        if (
                          await confirmDialog(`Delete the column ${c.name} and every value in it?`, {
                            danger: true,
                            confirm: 'Delete',
                          })
                        ) {
                          dropColumn.mutate({ environmentId, table: table.name, column: c.name })
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <ErrorNote error={dropColumn.error} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5">
          <span className="text-sm">Delete the table and all its rows. This can't be undone.</span>
          <Button
            variant="danger"
            loading={drop.isPending}
            onClick={async () => {
              if (
                !(await confirmDialog(`Delete the table ${table.name} and all its rows?`, {
                  danger: true,
                  confirm: 'Delete',
                }))
              )
                return
              drop.mutate({ environmentId, table: table.name }, { onSuccess: onDropped })
            }}
          >
            <Trash2 className="size-4" /> Delete table
          </Button>
        </div>
        <ErrorNote error={drop.error} />
      </div>
    </Dialog>
  )
}
