import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button, CopyButton } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  cellText,
  childSummary,
  expandablePaths,
  pathExpression,
  pathKey,
  shapeOf,
  typeLabel,
} from './result-model'

/** A JSON file of `value`, downloaded as `name`. */
export function downloadJson(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value ?? null, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

const ROW_HEIGHT = 24
/** A node's children are shown this many at a time. */
const CHILDREN_PAGE = 100

function Actions({ value, name, children }: { value: unknown; name: string; children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {children}
      <CopyButton
        text={JSON.stringify(value ?? null, null, 2)}
        label="Copy as JSON"
        className="size-6 [&_svg]:size-3.5"
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-6 [&_svg]:size-3.5"
        title="Download as JSON"
        aria-label="Download as JSON"
        onClick={() => downloadJson(value, `${name}.json`)}
      >
        <Download />
      </Button>
    </div>
  )
}

/**
 * A result as Retool's Data tab shows it: a table for an array of objects (rows virtualized), a list for other
 * arrays, key/value rows for an object, and a single value as it is.
 */
export function DataTab({ value, name, className }: { value: unknown; name: string; className?: string }) {
  const shape = useMemo(() => shapeOf(value), [value])
  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="data-view">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2">
        <span className="font-mono text-xs text-success" data-testid="data-type">
          {typeLabel(value)}
        </span>
        <div className="flex-1" />
        <Actions value={value} name={name} />
      </div>
      {shape.kind === 'table' ? (
        <DataTable columns={shape.columns} rows={shape.rows} />
      ) : shape.kind === 'list' ? (
        <div className="min-h-0 overflow-auto px-2 pb-2 font-mono text-xs">
          {shape.items.length === 0 ? (
            <span className="text-muted">Empty</span>
          ) : (
            <span className="break-all">[{shape.items.map((item) => JSON.stringify(item)).join(',')}]</span>
          )}
        </div>
      ) : shape.kind === 'object' ? (
        <table className="w-full font-mono text-xs">
          <tbody>
            {shape.entries.map(([key, item]) => (
              <tr key={key} className="align-top">
                <td className="w-1/3 py-0.5 pr-3 pl-2 font-medium text-ink">{key}</td>
                <td className="py-0.5 pr-2 break-all text-muted">{cellText(item, 2000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="px-2 pb-2 font-mono text-xs break-all whitespace-pre-wrap" data-testid="json">
          {JSON.stringify(shape.value) ?? String(shape.value)}
        </pre>
      )}
    </div>
  )
}

function DataTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const width = columns.length * 144
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-testid="data-table">
      <div style={{ width, minWidth: '100%' }} className="font-mono text-xs">
        <div className="sticky top-0 z-[1] flex bg-surface font-medium text-ink">
          {columns.map((c) => (
            <div key={c} className="w-36 shrink-0 truncate px-2 py-1" title={c}>
              {c}
            </div>
          ))}
        </div>
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]!
            return (
              <div
                key={item.key}
                className="absolute left-0 flex w-full hover:bg-canvas"
                style={{ top: item.start, height: ROW_HEIGHT }}
              >
                {columns.map((c) => (
                  <div
                    key={c}
                    className="w-36 shrink-0 truncate px-2 leading-6"
                    title={cellText(row[c], 2000)}
                  >
                    {cellText(row[c])}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * A result as a tree, as Retool's JSON tab shows it: arrays and objects with their counts, opened one at a time or
 * all at once; each node's expression can be copied (`query1.data[0].name`).
 */
export function JsonTree({
  value,
  name,
  root,
  label = 'data',
  className,
}: {
  value: unknown
  /** For the downloaded file's name. */
  name: string
  /** The expression the value is read with, for copying a node's path (`query1.data`). */
  root?: string
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([pathKey([])]))
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="json-tree">
      <div className="flex h-7 shrink-0 items-center justify-end px-1">
        <Actions value={value} name={name}>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 [&_svg]:size-3.5"
            title="Expand all"
            aria-label="Expand all"
            onClick={() => setOpen(new Set(expandablePaths(value)))}
          >
            <ChevronsUpDown />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 [&_svg]:size-3.5"
            title="Collapse all"
            aria-label="Collapse all"
            onClick={() => setOpen(new Set())}
          >
            <ChevronsDownUp />
          </Button>
        </Actions>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 font-mono text-xs">
        <TreeNode label={label} value={value} path={[]} root={root ?? label} open={open} toggle={toggle} />
      </div>
    </div>
  )
}

function TreeNode({
  label,
  value,
  path,
  root,
  open,
  toggle,
}: {
  label: string
  value: unknown
  path: (string | number)[]
  root: string
  open: Set<string>
  toggle: (key: string) => void
}) {
  const key = pathKey(path)
  const summary = childSummary(value)
  const expanded = summary !== null && open.has(key)
  const [shown, setShown] = useState(CHILDREN_PAGE)
  const children: [string | number, unknown][] = expanded
    ? Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>)
    : []

  return (
    <div>
      <div className="group flex items-center gap-1 leading-5" data-testid="json-node">
        {summary !== null ? (
          <button
            type="button"
            className="flex size-4 cursor-pointer items-center justify-center text-accent"
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            aria-expanded={expanded}
            onClick={() => toggle(key)}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="size-4" />
        )}
        <span className={cn('whitespace-nowrap', path.length === 0 ? 'font-semibold text-ink' : 'text-ink')}>
          {label}
        </span>
        <CopyButton
          text={pathExpression(root, path)}
          label={`Copy ${pathExpression(root, path)}`}
          className="size-4 opacity-0 group-hover:opacity-100 [&_svg]:size-3"
        />
        {summary !== null ? <span className="text-success">{summary}</span> : <Scalar value={value} />}
      </div>
      {expanded && (
        <div className="ml-4">
          {children.slice(0, shown).map(([k, v]) => (
            <TreeNode
              key={String(k)}
              label={String(k)}
              value={v}
              path={[...path, k]}
              root={root}
              open={open}
              toggle={toggle}
            />
          ))}
          {children.length > shown && (
            <button
              type="button"
              className="ml-5 cursor-pointer text-accent hover:underline"
              onClick={() => setShown((n) => n + CHILDREN_PAGE)}
            >
              Show {Math.min(CHILDREN_PAGE, children.length - shown)} more of {children.length - shown}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Scalar({ value }: { value: unknown }) {
  const tone =
    typeof value === 'string'
      ? 'text-success'
      : typeof value === 'number'
        ? 'text-warning-strong'
        : typeof value === 'boolean'
          ? 'text-accent'
          : 'text-muted'
  const text = typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value)
  return <span className={cn('min-w-0 break-all', tone)}>{text}</span>
}

/** Data and JSON views of one value, switched by two tabs. */
export function ResultTabs({
  value,
  name,
  root,
  className,
}: {
  value: unknown
  name: string
  root: string
  className?: string
}) {
  const [tab, setTab] = useState<'data' | 'json'>('data')
  return (
    <div className={cn('flex min-h-0 flex-col rounded-md border border-border', className)}>
      <div className="flex shrink-0 gap-3 border-b border-border px-2 text-xs">
        {(['data', 'json'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'cursor-pointer border-b-2 py-1 text-muted hover:text-ink',
              tab === t ? 'border-ink text-ink' : 'border-transparent',
            )}
          >
            {t === 'data' ? 'Data' : 'JSON'}
          </button>
        ))}
      </div>
      {tab === 'data' ? (
        <DataTab value={value} name={name} className="min-h-0 flex-1" />
      ) : (
        <JsonTree value={value} name={name} root={root} className="min-h-0 flex-1" />
      )}
    </div>
  )
}
