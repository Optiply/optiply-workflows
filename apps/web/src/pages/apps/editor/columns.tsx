import { type JsonValue, setProp } from '@ow/app-definition'
import { ChevronDown, ChevronRight, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAppError } from '../runtime/react'
import { AppCodeField, problemsAt } from './fields'
import { useAppEditor } from './store'

type Column = { [key: string]: JsonValue }

const TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'json'] as const

/** A column as stored: plain key strings read as `{ key }`; anything else isn't a column (kept as it is). */
const asColumn = (c: JsonValue): Column | null =>
  typeof c === 'string' ? { key: c } : c && typeof c === 'object' && !Array.isArray(c) ? c : null

/** A column with `field` set, or without it when `value` is undefined (fields are stored sparsely). */
function withField(column: Column, field: string, value: JsonValue | undefined): Column {
  const { [field]: _old, ...rest } = column
  return value === undefined ? rest : { ...rest, [field]: value }
}

/**
 * A table's `columns` as a list (M24): add, remove and reorder columns (drag, or the arrows), and per column its
 * key, label, type, editable, hidden, width and a computed value (a template read per row, with `currentRow`).
 */
export function ColumnsEditor({
  name,
  index,
  columns,
}: {
  name: string
  index: number
  columns: JsonValue[]
}) {
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const rowsError = useAppError(`${name}.$rows`)
  const [open, setOpen] = useState<number | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const base = ['components', index, 'props', 'columns']
  const set = (next: JsonValue[]) =>
    update((def) => setProp(def, name, 'columns', next.length ? next : undefined))
  const change = (at: number, field: string, value: JsonValue | undefined) => {
    const column = asColumn(columns[at]!)
    if (column) set(columns.map((c, i) => (i === at ? withField(column, field, value) : c)))
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) return
    const next = [...columns]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    set(next)
    setOpen((o) => (o === from ? to : o))
  }
  const fresh = () => {
    const keys = new Set(columns.map((c) => asColumn(c)?.key))
    let n = columns.length + 1
    while (keys.has(`column${n}`)) n++
    return `column${n}`
  }

  return (
    <div className="flex flex-col gap-1" data-testid={`columns-${name}`}>
      {columns.length === 0 && <p className="text-xs text-muted">Every key of the data, in its order.</p>}
      <ul className="flex flex-col gap-1">
        {columns.map((raw, i) => {
          const column = asColumn(raw)
          const key = typeof column?.key === 'string' ? column.key : ''
          const computed = typeof column?.value === 'string'
          const expanded = open === i
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are edited in place; a key can be blank or repeated while typed
              key={i}
              onDragOver={(e) => dragged !== null && e.preventDefault()}
              onDrop={() => {
                if (dragged !== null) move(dragged, i)
                setDragged(null)
              }}
              onDragEnd={() => setDragged(null)}
              className={cn('rounded-md border border-border bg-surface', dragged === i && 'opacity-50')}
              data-testid={`column-${i}`}
            >
              <div className="flex items-center gap-1 px-1 py-1">
                {/* Only the grip drags: inside a draggable element, the code field's text can't be selected. */}
                <span
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    setDragged(i)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  className="shrink-0 cursor-grab text-muted"
                  aria-hidden
                >
                  <GripVertical className="size-3.5" />
                </span>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <span className="truncate font-mono">
                    {column ? key || '(no key)' : JSON.stringify(raw)}
                  </span>
                  {computed && <span className="text-[11px] text-muted">computed</span>}
                  {column?.hidden === true && <span className="text-[11px] text-muted">hidden</span>}
                </button>
                {!readOnly && (
                  <>
                    <Button size="icon" variant="ghost" title="Move up" onClick={() => move(i, i - 1)}>
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" title="Move down" onClick={() => move(i, i + 1)}>
                      <ChevronDown className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove column"
                      onClick={() => {
                        set(columns.filter((_, j) => j !== i))
                        setOpen(null)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
              {expanded && column && (
                <fieldset
                  disabled={readOnly}
                  className="flex flex-col gap-2 border-t border-border p-2 text-xs"
                >
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is a component inside the label */}
                  <label className="flex flex-col gap-1">
                    Key
                    <Input
                      value={key}
                      aria-label="Column key"
                      onChange={(e) => change(i, 'key', e.target.value)}
                      className="h-7 font-mono text-xs"
                    />
                  </label>
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is a component inside the label */}
                  <label className="flex flex-col gap-1">
                    Label
                    <Input
                      value={typeof column.label === 'string' ? column.label : ''}
                      placeholder={key}
                      aria-label="Column label"
                      onChange={(e) => change(i, 'label', e.target.value || undefined)}
                      className="h-7 text-xs"
                    />
                  </label>
                  <div className="flex gap-2">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is a component inside the label */}
                    <label className="flex flex-1 flex-col gap-1">
                      Type
                      <Select
                        aria-label="Column type"
                        value={typeof column.type === 'string' ? column.type : ''}
                        onChange={(e) => change(i, 'type', e.target.value || undefined)}
                        className="h-7 text-xs"
                      >
                        <option value="">From the data</option>
                        {TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </Select>
                    </label>
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is a component inside the label */}
                    <label className="flex w-20 flex-col gap-1">
                      Width
                      <Input
                        type="number"
                        min={40}
                        aria-label="Column width"
                        value={typeof column.width === 'number' ? column.width : ''}
                        placeholder="auto"
                        onChange={(e) =>
                          change(
                            i,
                            'width',
                            e.target.value ? Math.max(40, Number(e.target.value)) : undefined,
                          )
                        }
                        className="h-7 text-xs"
                      />
                    </label>
                  </div>
                  <div className="flex gap-4">
                    <Checkbox
                      label="Editable"
                      disabled={computed}
                      title={computed ? 'A computed column can’t be edited' : undefined}
                      checked={column.editable === true && !computed}
                      onChange={(e) => change(i, 'editable', e.target.checked || undefined)}
                    />
                    <Checkbox
                      label="Hidden"
                      checked={column.hidden === true}
                      onChange={(e) => change(i, 'hidden', e.target.checked || undefined)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span>
                      Computed value <span className="text-muted">· per row, as </span>
                      <code className="text-muted">{'{{ currentRow.price * 2 }}'}</code>
                    </span>
                    <AppCodeField
                      path={[...base, i, 'value']}
                      // A value inside the columns' JSON: set as a whole, not a shared text.
                      bind={false}
                      language="plaintext"
                      singleLine
                      height={30}
                      value={typeof column.value === 'string' ? column.value : ''}
                      problems={problemsAt(diagnostics, [...base, i, 'value'])}
                      onChange={(text) => change(i, 'value', text === '' ? undefined : text)}
                    />
                  </div>
                </fieldset>
              )}
            </li>
          )
        })}
      </ul>
      {rowsError && <span className="text-xs text-danger">{rowsError}</span>}
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => {
            set([...columns, { key: fresh() }])
            setOpen(columns.length)
          }}
        >
          <Plus className="size-3.5" /> Add column
        </Button>
      )}
    </div>
  )
}
