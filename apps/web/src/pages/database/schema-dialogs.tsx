import { useMutation } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Dialog, ErrorNote, Field, Input, Select } from '@/components/ui'
import { errorMessage, useTRPC } from '@/lib/trpc'
import { type Column, type TableInfo, TYPE_LABELS } from './cells'

export type ColumnType = Exclude<Column['type'], 'other'>
export const COLUMN_TYPES = Object.keys(TYPE_LABELS).filter((t) => t !== 'other') as ColumnType[]
const EXPRESSIONS = ['now()', 'current_date', 'gen_random_uuid()'] as const
type Expression = (typeof EXPRESSIONS)[number]

/** A default as the editor sets it: none, a fixed value, or one Postgres computes. */
export type DefaultSpec =
  | { kind: 'none' }
  | { kind: 'value'; value: string }
  | { kind: 'expression'; expression: Expression }

export interface ColumnSpec {
  name: string
  type: ColumnType
  nullable: boolean
  unique: boolean
  default: DefaultSpec
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
  type: 'text',
  nullable: true,
  unique: false,
  default: { kind: 'none' },
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
  ].filter(Boolean)

  const submit = async () => {
    setTried(true)
    if (problems.length) return
    try {
      await create.mutateAsync({ environmentId, name, columns: used })
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
                <Select
                  aria-label="Column type"
                  value={c.type}
                  onChange={(e) => update(i, { type: e.target.value as ColumnType })}
                >
                  {COLUMN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
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
                <div className="min-w-64 flex-1">
                  <DefaultEditor value={c.default} onChange={(d) => update(i, { default: d })} />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Remove column"
                  onClick={() => setColumns(columns.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
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
  const [type, setType] = useState<Column['type']>(column?.type ?? 'text')
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

  const submit = async () => {
    const problem = name !== column?.name ? nameProblem(name) : null
    if (problem) return setError(problem)
    if (name === 'id' && name !== column?.name) return setError('Every table already has an id column')
    setError(null)
    try {
      if (!column) {
        if (type === 'other') return
        await add.mutateAsync({
          environmentId,
          table: table.name,
          column: {
            name,
            type,
            nullable,
            unique,
            default: fallback.kind === 'other' ? { kind: 'none' } : fallback,
          },
        })
      } else {
        if (name !== column.name) {
          await rename.mutateAsync({ environmentId, table: table.name, column: column.name, to: name })
        }
        const change: Record<string, unknown> = {}
        if (type !== column.type && type !== 'other') change.type = type
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
          label="Type"
          hint={
            column && type !== column.type
              ? 'Existing values are converted; if one does not fit, nothing changes.'
              : undefined
          }
        >
          <Select value={type} onChange={(e) => setType(e.target.value as Column['type'])}>
            {column?.type === 'other' && <option value="other">Other ({column.sqlType})</option>}
            {COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-6">
          <Checkbox label="Required" checked={!nullable} onChange={(e) => setNullable(!e.target.checked)} />
          <Checkbox label="Unique" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        </div>
        <Field label="Default" hint="What new rows get when they leave this column out.">
          <DefaultEditor
            value={fallback}
            onChange={setFallback}
            current={fallback.kind === 'other' ? fallback.expression : undefined}
          />
        </Field>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  )
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
                <span className="w-28 text-muted">
                  {c.type === 'other' ? c.sqlType : TYPE_LABELS[c.type]}
                </span>
                <span className="flex-1 truncate text-xs text-muted">
                  {[
                    c.primaryKey && 'key',
                    !c.nullable && !c.primaryKey && 'required',
                    c.unique && !c.primaryKey && 'unique',
                    c.default.kind === 'value' && `default ${c.default.value}`,
                    (c.default.kind === 'expression' || c.default.kind === 'other') &&
                      `default ${c.default.expression}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
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
                      onClick={() => {
                        if (confirm(`Delete the column ${c.name} and every value in it?`)) {
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
            onClick={() => {
              if (!confirm(`Delete the table ${table.name} and all its rows?`)) return
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
