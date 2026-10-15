import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Dialog, ErrorNote } from '@/components/ui'
import { errorMessage, useTRPC } from '@/lib/trpc'
import { type Column, parseCell, type TableInfo, TYPE_LABELS, ValueInput } from './cells'

/**
 * Adds a row: a field per column the database doesn't fill in itself. Fields left empty get the column's default
 * (or NULL); the server's refusals land on the field they name.
 */
export function AddRowDialog({
  environmentId,
  table,
  onClose,
  onAdded,
}: {
  environmentId: string
  table: TableInfo
  onClose: () => void
  onAdded: () => void
}) {
  const trpc = useTRPC()
  const columns = table.columns.filter((c) => !c.identity)
  const [values, setValues] = useState<Record<string, string>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const insert = useMutation(trpc.database.insertRow.mutationOptions())

  const submit = async () => {
    const out: Record<string, unknown> = {}
    const errors: Record<string, string> = {}
    for (const column of columns) {
      const text = values[column.name] ?? ''
      // Left empty: the default applies (for text too, unless something was typed).
      if (text === '') continue
      const parsed = parseCell(text, column)
      if (parsed.ok) out[column.name] = parsed.value
      else errors[column.name] = parsed.error
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length) return
    try {
      await insert.mutateAsync({ environmentId, table: table.name, values: out })
      onAdded()
      onClose()
    } catch (err) {
      // "price: invalid input syntax…": the message goes under that field.
      const message = errorMessage(err)
      const field = columns.find((c) => message.startsWith(`${c.name}: `))
      if (field) setFieldErrors({ [field.name]: message.slice(field.name.length + 2) })
    }
  }

  const fieldError = Object.keys(fieldErrors).length > 0
  return (
    <Dialog
      title={`Add a row to ${table.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={insert.isPending} onClick={submit}>
            Add row
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {columns.map((column) => (
          <RowField
            key={column.name}
            column={column}
            value={values[column.name] ?? ''}
            error={fieldErrors[column.name]}
            onChange={(v) => setValues({ ...values, [column.name]: v })}
          />
        ))}
        {/* Enter in a field submits. */}
        <button type="submit" hidden />
        {!fieldError && <ErrorNote error={insert.error} />}
      </form>
    </Dialog>
  )
}

function RowField({
  column,
  value,
  error,
  onChange,
}: {
  column: Column
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const id = `field-${column.name}`
  const hint =
    column.default.kind !== 'none'
      ? `Empty: the default (${column.default.kind === 'value' ? column.default.value : column.default.expression})`
      : column.nullable
        ? 'Empty: NULL'
        : 'Required'
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline justify-between text-sm font-medium">
        {column.name}
        <span className="text-xs font-normal text-muted">{TYPE_LABELS[column.type]}</span>
      </label>
      <div className="h-9 overflow-hidden rounded-md border border-border focus-within:border-accent">
        <ValueInput id={id} column={column} value={value} onChange={onChange} />
      </div>
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : (
        <span className="text-xs text-muted">{hint}</span>
      )}
    </div>
  )
}
