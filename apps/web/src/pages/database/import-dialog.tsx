import { useMutation } from '@tanstack/react-query'
import { FileUp, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Dialog, ErrorNote, Field, Input, Select } from '@/components/ui'
import { errorMessage, type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { type TableInfo, TYPE_LABELS } from './cells'
import { COLUMN_TYPES, type ColumnType, nameProblem } from './schema-dialogs'

type Guess = RouterOutputs['database']['previewCsv']
type Delimiter = Guess['delimiter']

/** How much of the file the preview reads; the import itself streams the whole file. */
const SAMPLE_BYTES = 256 * 1024
const DELIMITER_LABELS: Record<Delimiter, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' }

interface ImportColumn {
  include: boolean
  /** create: the new column's name; append: the existing column it goes into ('' = skip). */
  name: string
  type: ColumnType
}

interface Problem {
  line: number
  column?: string
  message: string
}

/** A file name as a table name: lowercase snake_case. */
function tableNameFrom(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (/^\d/.test(base) ? `t_${base}` : base).slice(0, 63) || 'imported'
}

/**
 * Imports a CSV: into a new table (names and types guessed from the file, all adjustable) or into an existing one
 * (file columns mapped onto table columns). The browser reads only the start of the file for the preview; the
 * import streams the whole file and either every row goes in or none does, with the lines to fix.
 */
export function ImportDialog({
  environmentId,
  tables,
  initialTable,
  onClose,
  onImported,
}: {
  environmentId: string
  tables: TableInfo[]
  /** Open on "add to this table". */
  initialTable?: TableInfo
  onClose: () => void
  onImported: (table: string) => void
}) {
  const trpc = useTRPC()
  const preview = useMutation(trpc.database.previewCsv.mutationOptions())
  const [file, setFile] = useState<File | null>(null)
  const [guess, setGuess] = useState<Guess | null>(null)
  const [mode, setMode] = useState<'create' | 'append'>(initialTable ? 'append' : 'create')
  const [tableName, setTableName] = useState('')
  const [target, setTarget] = useState(initialTable?.name ?? tables[0]?.name ?? '')
  const [header, setHeader] = useState(true)
  const [dateOrder, setDateOrder] = useState<Guess['dateOrder']>('DMY')
  const [decimalComma, setDecimalComma] = useState(false)
  const [columns, setColumns] = useState<ImportColumn[]>([])
  const [importing, setImporting] = useState(false)
  const [failure, setFailure] = useState<{ message: string; problems: Problem[] } | null>(null)
  const targetTable = tables.find((t) => t.name === target)

  /** Columns as the file has them: in append mode, mapped onto `table`'s columns by name. */
  const initColumns = (g: Guess, into = mode, table = targetTable) => {
    setColumns(
      g.names.map((name, i) => ({
        include: true,
        name:
          into === 'append' ? (table?.columns.some((c) => c.name === name && !c.identity) ? name : '') : name,
        type: g.types[i] ?? 'text',
      })),
    )
  }

  /** Reads the start of the file and guesses: again when the delimiter or the header setting changes. */
  const read = async (f: File, opts: { delimiter?: Delimiter; header?: boolean } = {}) => {
    setFailure(null)
    const sample = await f.slice(0, SAMPLE_BYTES).text()
    const g = await preview.mutateAsync({
      sample,
      complete: f.size <= SAMPLE_BYTES,
      delimiter: opts.delimiter,
      header: opts.header ?? header,
    })
    setGuess(g)
    setDateOrder(g.dateOrder)
    setDecimalComma(g.decimalComma)
    initColumns(g)
  }

  const chosen = columns.map((c, source) => ({ ...c, source })).filter((c) => c.include && c.name !== '')
  const problems: string[] = []
  if (guess) {
    if (!chosen.length) problems.push('Choose at least one column to import')
    if (new Set(chosen.map((c) => c.name)).size !== chosen.length)
      problems.push('Two columns go to the same name')
    if (mode === 'create') {
      const p = nameProblem(tableName)
      if (p) problems.push(`Table name: ${p}`)
      if (tables.some((t) => t.name === tableName))
        problems.push(`There's already a table named ${tableName}`)
      for (const c of chosen) {
        const p2 = nameProblem(c.name)
        if (p2) problems.push(`${c.name}: ${p2}`)
        if (c.name === 'id' && c.type !== 'integer' && c.type !== 'bigint') {
          problems.push('An id column holds whole numbers: make it Integer or Big integer, or rename it')
        }
      }
    } else if (!targetTable) problems.push('Choose a table to add to')
  }

  const submit = async () => {
    if (!file || !guess || problems.length) return
    setImporting(true)
    setFailure(null)
    const spec = {
      environmentId,
      mode,
      table: mode === 'create' ? tableName : target,
      delimiter: guess.delimiter,
      header,
      dateOrder,
      decimalComma,
      columns: chosen.map((c) => ({
        source: c.source,
        name: c.name,
        ...(mode === 'create' ? { type: c.type } : {}),
      })),
    }
    try {
      const res = await fetch('/api/v1/database/import', {
        method: 'POST',
        headers: { 'content-type': 'application/x-ow-csv-import' },
        // One line of JSON, then the file as it is: the browser streams it from disk.
        body: new Blob([`${JSON.stringify(spec)}\n`, file]),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setFailure({
          message: body?.error?.message ?? `The import failed (${res.status})`,
          problems: body?.error?.problems ?? [],
        })
        return
      }
      onImported(spec.table)
      onClose()
    } catch (err) {
      setFailure({ message: errorMessage(err), problems: [] })
    } finally {
      setImporting(false)
    }
  }

  const sampleRows = guess ? guess.rows.slice(0, 5) : []

  return (
    <Dialog
      title="Import CSV"
      className="max-w-5xl"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!guess || problems.length > 0}
            loading={importing}
            onClick={submit}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="File" className="min-w-72 flex-1">
            <label
              className={cn(
                'flex h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm hover:bg-canvas',
                file && 'border-solid',
              )}
            >
              <FileUp className="size-4 text-muted" />
              <span className="truncate">
                {file ? `${file.name} (${formatBytes(file.size)})` : 'Choose a .csv file…'}
              </span>
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                aria-label="CSV file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setFile(f)
                  setTableName(tableNameFrom(f.name))
                  void read(f).catch(() => setGuess(null))
                }}
              />
            </label>
          </Field>
          <Field label="Into">
            <Select
              aria-label="Import into"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as 'create' | 'append'
                setMode(next)
                if (guess) initColumns(guess, next)
              }}
            >
              <option value="create">A new table</option>
              <option value="append" disabled={!tables.length}>
                An existing table
              </option>
            </Select>
          </Field>
          {mode === 'create' ? (
            <Field label="Table name">
              <Input
                aria-label="Table name"
                value={tableName}
                onChange={(e) => setTableName(e.target.value.trim())}
              />
            </Field>
          ) : (
            <Field label="Table">
              <Select
                aria-label="Target table"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value)
                  if (guess)
                    initColumns(
                      guess,
                      mode,
                      tables.find((t) => t.name === e.target.value),
                    )
                }}
              >
                {tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {preview.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Reading the file…
          </p>
        )}
        <ErrorNote error={preview.error} />

        {guess && (
          <>
            <div className="flex flex-wrap items-center gap-4 rounded-lg bg-canvas px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                Delimiter
                <Select
                  aria-label="Delimiter"
                  className="h-8"
                  value={guess.delimiter}
                  onChange={(e) =>
                    file &&
                    void read(file, { delimiter: e.target.value as Delimiter }).catch(() => setGuess(null))
                  }
                >
                  {Object.entries(DELIMITER_LABELS).map(([d, label]) => (
                    <option key={d} value={d}>
                      {label}
                    </option>
                  ))}
                </Select>
              </span>
              <Checkbox
                label="First row holds the column names"
                checked={header}
                onChange={(e) => {
                  setHeader(e.target.checked)
                  // The types change too: the first row is data now (or no longer).
                  if (file) {
                    void read(file, { delimiter: guess.delimiter, header: e.target.checked }).catch(() =>
                      setGuess(null),
                    )
                  }
                }}
              />
              <span className="flex items-center gap-2">
                Dates
                <Select
                  aria-label="Date order"
                  className="h-8"
                  value={dateOrder}
                  onChange={(e) => setDateOrder(e.target.value as Guess['dateOrder'])}
                >
                  <option value="DMY">day-month-year</option>
                  <option value="MDY">month-day-year</option>
                  <option value="YMD">year-month-day</option>
                </Select>
              </span>
              <Checkbox
                label="Decimal comma (1.234,50)"
                checked={decimalComma}
                onChange={(e) => setDecimalComma(e.target.checked)}
              />
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="text-left text-sm" data-testid="import-preview">
                <thead className="bg-canvas">
                  <tr>
                    {columns.map((c, i) => (
                      <th
                        // biome-ignore lint/suspicious/noArrayIndexKey: file columns are identified by position
                        key={i}
                        className="min-w-44 border-b border-r border-border p-2 align-top font-normal"
                      >
                        <div className="space-y-1.5">
                          <Checkbox
                            label={<span className="text-xs text-muted">{guess.header[i]}</span>}
                            checked={c.include}
                            onChange={(e) =>
                              setColumns(
                                columns.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)),
                              )
                            }
                          />
                          {mode === 'create' ? (
                            <>
                              <Input
                                aria-label={`Name of column ${i + 1}`}
                                className="h-8"
                                disabled={!c.include}
                                value={c.name}
                                onChange={(e) =>
                                  setColumns(
                                    columns.map((x, j) =>
                                      j === i ? { ...x, name: e.target.value.trim() } : x,
                                    ),
                                  )
                                }
                              />
                              <Select
                                aria-label={`Type of column ${i + 1}`}
                                className="h-8 w-full"
                                disabled={!c.include}
                                value={c.type}
                                onChange={(e) =>
                                  setColumns(
                                    columns.map((x, j) =>
                                      j === i ? { ...x, type: e.target.value as ColumnType } : x,
                                    ),
                                  )
                                }
                              >
                                {COLUMN_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {TYPE_LABELS[t]}
                                  </option>
                                ))}
                              </Select>
                            </>
                          ) : (
                            <Select
                              aria-label={`Target of column ${i + 1}`}
                              className="h-8 w-full"
                              disabled={!c.include}
                              value={c.name}
                              onChange={(e) =>
                                setColumns(
                                  columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                                )
                              }
                            >
                              <option value="">Skip</option>
                              {targetTable?.columns
                                .filter((t) => !t.identity || t.primaryKey)
                                .map((t) => (
                                  <option key={t.name} value={t.name}>
                                    {t.name} ({t.type === 'other' ? t.sqlType : TYPE_LABELS[t.type]})
                                  </option>
                                ))}
                            </Select>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((row, r) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sample rows are identified by position
                    <tr key={r}>
                      {columns.map((c, i) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells are identified by position
                          key={i}
                          className={cn(
                            'max-w-56 truncate border-b border-r border-border px-2 py-1.5',
                            !c.include && 'text-muted/50',
                          )}
                        >
                          {row[i] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {problems.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-800">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {failure && (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            <p className="font-medium">Nothing was imported.</p>
            {failure.problems.length ? (
              <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5">
                {failure.problems.map((p) => (
                  <li key={`${p.line}:${p.column ?? ''}`}>
                    Line {p.line}
                    {p.column ? `, ${p.column}` : ''}: {p.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 whitespace-pre-wrap">{failure.message}</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
