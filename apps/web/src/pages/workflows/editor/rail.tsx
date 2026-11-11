import type { BlockType, Diagnostic } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { useReactFlow } from '@xyflow/react'
import {
  AlertCircle,
  CheckCircle2,
  ListTree,
  type LucideIcon,
  Plus,
  Rocket,
  Search,
  Settings,
  SquareFunction,
  X,
  Zap,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { Button, Input } from '@/components/ui'
import type { RouterOutputs } from '@/lib/trpc'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { addableIn, BLOCK_KINDS, kindOf, newBlock, nextName, PYTHON_KIND } from './catalog'
import { FunctionsTab } from './functions'
import { blockWidth, NODE_GAP, NODE_WIDTH, positionsFor } from './layout'
import { ReleasesTab } from './releases'
import { type GraphPart, graphOf, type RailPanel, updateGraph, useEditor } from './store'
import { TriggersForm } from './triggers'
import { WorkflowSettingsTab } from './workflow-settings'

type Workflow = RouterOutputs['workflows']['get']
type AddableType = Exclude<BlockType, 'startTrigger'>

const PANELS: { id: RailPanel; label: string; icon: LucideIcon }[] = [
  { id: 'blocks', label: 'Blocks', icon: Plus },
  { id: 'outline', label: 'Outline', icon: ListTree },
  { id: 'functions', label: 'Functions', icon: SquareFunction },
  { id: 'triggers', label: 'Triggers', icon: Zap },
  { id: 'search', label: 'Code search', icon: Search },
  { id: 'releases', label: 'Releases', icon: Rocket },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/**
 * A connection dropped on empty canvas (M28): the Blocks panel opens, and the block added next goes there,
 * connected from that port.
 */
export const usePendingAdd = create<{
  pending: { from: string; port: string; at: { x: number; y: number } } | null
}>()(() => ({ pending: null }))

// It's for that moment only: closing the Blocks panel, opening another graph or another draft drops it.
useEditor.subscribe((s, was) => {
  if (!usePendingAdd.getState().pending) return
  if (s.railPanel !== 'blocks' || s.graph !== was.graph || s.shared !== was.shared) {
    usePendingAdd.setState({ pending: null })
  }
})

/** The left icon rail: one click opens a panel, another closes it. */
export function Rail() {
  const open = useEditor((s) => s.railPanel)
  const errors = useEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)
  const warnings = useEditor((s) => s.diagnostics.length) - errors
  const item = (id: RailPanel, label: string, Icon: LucideIcon, badge?: number, tone?: string) => (
    <button
      key={id}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={open === id}
      data-testid={`rail-${id}`}
      onClick={() => useEditor.getState().toggleRail(id)}
      className={cn(
        'relative flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover/60 hover:text-ink',
        open === id && 'bg-accent-soft text-accent',
      )}
    >
      <Icon className="size-4" />
      {badge ? (
        <span
          className={cn(
            'absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold text-white',
            tone,
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  )
  return (
    <nav
      className="flex w-11 shrink-0 flex-col items-center gap-1 rounded-xl border border-border/70 bg-surface shadow-card py-2"
      aria-label="Workflow panels"
    >
      {PANELS.map((p) => item(p.id, p.label, p.icon))}
      <div className="flex-1" />
      {item('problems', 'Problems', AlertCircle, errors || warnings, errors ? 'bg-danger' : 'bg-warning')}
    </nav>
  )
}

/** The rail's open panel, resized from its right edge (kept per browser). */
export function RailPanelView({
  workflow,
  canEdit,
  hasEdit,
}: {
  workflow: Workflow
  canEdit: boolean
  hasEdit: boolean
}) {
  const open = useEditor((s) => s.railPanel)
  const [widths, setWidths] = useState<Partial<Record<RailPanel, number>>>({})
  const panel = useRef<HTMLElement>(null)
  if (!open) return null
  const width = widths[open] ?? storedWidth(open)
  const setWidth = (w: number) => setWidths((was) => ({ ...was, [open]: w }))
  const label = open === 'problems' ? 'Problems' : PANELS.find((p) => p.id === open)?.label

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panel.current?.offsetWidth ?? width
    let next = startWidth
    const move = (ev: PointerEvent) => {
      next = Math.min(640, Math.max(220, startWidth + ev.clientX - startX))
      setWidth(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(`${WIDTH_KEY}.${open}`, String(Math.round(next)))
      } catch {
        // Storage blocked: the width lasts until the page reloads.
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside
      ref={panel}
      style={{ width }}
      className="nokey relative flex shrink-0 flex-col rounded-xl border border-border/70 bg-surface shadow-card"
      data-testid="rail-panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <span className="flex-1 text-sm font-semibold">{label}</span>
        <Button
          size="icon"
          variant="ghost"
          title="Close the panel"
          aria-label="Close the panel"
          onClick={() => useEditor.getState().toggleRail(null)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {open === 'blocks' && <BlocksPalette canEdit={canEdit} />}
        {open === 'outline' && <Outline />}
        {open === 'functions' && <FunctionsTab canEdit={canEdit} />}
        {open === 'triggers' && <TriggersPanel />}
        {open === 'search' && <CodeSearch />}
        {open === 'releases' && <ReleasesTab workflow={workflow} canEdit={hasEdit} />}
        {open === 'settings' && (
          <WorkflowSettingsTab workflow={workflow} canEdit={canEdit} hasEdit={hasEdit} />
        )}
        {open === 'problems' && <Problems />}
      </div>
      <div
        className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-accent/30"
        onPointerDown={startResize}
      />
    </aside>
  )
}

const WIDTH_KEY = 'ow.railWidth'

/** Forms (triggers, settings, releases) get more room than lists; each panel's width is kept per browser. */
const WIDE: ReadonlySet<RailPanel> = new Set(['triggers', 'settings', 'releases', 'functions'])

function storedWidth(panel: RailPanel): number {
  const fallback = WIDE.has(panel) ? 440 : 280
  try {
    const n = Number(localStorage.getItem(`${WIDTH_KEY}.${panel}`))
    return Number.isFinite(n) && n >= 220 ? n : fallback
  } catch {
    return fallback
  }
}

/**
 * Adds a block: at `at` (a drop on the canvas), connected from a dropped connection, or to the right of the selected
 * block (connected to it, unless it's a branch) or of the rightmost one.
 */
export function useAddBlock() {
  const trpc = useTRPC()
  const { data: resources } = useQuery(trpc.resources.list.queryOptions())
  const queryable = resources?.resources ?? []
  const { fitView } = useReactFlow()
  const fn = useEditor((s) => s.graph)
  const definition = useEditor((s) => s.definition)
  const types = addableIn(fn !== null, graphOf(definition, fn).blocks)

  const add = (type: AddableType, python = false, at?: { x: number; y: number }) => {
    const { selected, select } = useEditor.getState()
    const pending = usePendingAdd.getState().pending
    usePendingAdd.setState({ pending: null })
    let added = ''
    // The block the new one is placed after (and shown with).
    const follows = pending?.from ?? (!at ? selected : null)
    const functions = (useEditor.getState().definition.functions ?? []).map((f) => f.name)
    updateGraph((def) => {
      // Block names can't be function names either (code calls functions by name).
      const taken = [...def.blocks.map((b) => b.name), ...functions]
      added = python ? nextName(type, taken, PYTHON_KIND) : nextName(type, taken)
      const block = newBlock(type, added, queryable[0], { functions, inFunction: fn !== null, python })
      const positions = positionsFor(def)
      const widthOf = (name: string) => {
        const b = def.blocks.find((x) => x.name === name)
        return b ? blockWidth(b, positions[name]) : NODE_WIDTH
      }
      const from = pending ? { block: pending.from, port: pending.port } : null
      const anchor = !at && !pending && selected ? positions[selected] : undefined
      const place =
        at ??
        pending?.at ??
        (anchor && selected
          ? { x: anchor.x + widthOf(selected) + NODE_GAP, y: anchor.y }
          : {
              x: Math.max(0, ...Object.entries(positions).map(([n, p]) => p.x + widthOf(n))) + NODE_GAP,
              y: 0,
            })
      const connect =
        from ??
        (!at && selected && def.blocks.some((b) => b.name === selected && b.type !== 'branch')
          ? { block: selected, port: 'out' }
          : null)
      const edges =
        type !== 'errorTrigger' && connect
          ? [...def.edges, { from: connect.block, port: connect.port, to: added }]
          : def.edges
      return {
        ...def,
        blocks: [...def.blocks, block],
        edges,
        layout: {
          ...def.layout,
          blocks: { ...positions, [added]: { x: Math.round(place.x), y: Math.round(place.y) } },
        },
      }
    })
    select(added)
    // Bring the new block into view once React Flow has measured it.
    const shown = [{ id: added }, ...(follows ? [{ id: follows }] : [])]
    setTimeout(() => fitView({ nodes: shown, padding: 0.3, maxZoom: 1, duration: 200 }), 150)
  }
  return { types, queryable, add }
}

/** The data a palette item carries when dragged onto the canvas. */
export const BLOCK_DRAG_TYPE = 'application/x-ow-block'

function BlocksPalette({ canEdit }: { canEdit: boolean }) {
  const { types, queryable, add } = useAddBlock()
  const pending = usePendingAdd((s) => s.pending)
  if (!canEdit) return <p className="text-sm text-muted">This draft is read-only.</p>
  const items = types.flatMap((type): { type: AddableType; python?: boolean }[] =>
    type === 'code' ? [{ type }, { type, python: true }] : [{ type }],
  )
  return (
    <div className="flex flex-col gap-2">
      {pending && (
        <p className="rounded-md bg-accent-soft px-2 py-1.5 text-xs text-accent">
          Pick a block to add after <span className="font-mono">{pending.from}</span>.
        </p>
      )}
      <p className="text-xs text-muted">Click to add after the selected block, or drag onto the canvas.</p>
      <div className="grid grid-cols-2 gap-2">
        {items.map(({ type, python }) => {
          const kind = python ? PYTHON_KIND : BLOCK_KINDS[type]
          const Icon = kind.icon
          const disabled = type === 'resourceQuery' && queryable.length === 0
          const label = python ? 'Add a Python code block' : `Add a ${kind.label.toLowerCase()} block`
          return (
            <button
              key={python ? 'python' : type}
              type="button"
              disabled={disabled}
              title={disabled ? 'Add a resource first' : label}
              aria-label={label}
              draggable={!disabled}
              onDragStart={(e) => {
                e.dataTransfer.setData(BLOCK_DRAG_TYPE, JSON.stringify({ type, python: !!python }))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => add(type, python)}
              className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg p-2 text-xs text-ink hover:bg-canvas disabled:cursor-default disabled:opacity-50"
            >
              <span className={cn('rounded-md p-2', kind.tone)}>
                <Icon className="size-4" />
              </span>
              {python ? 'Python' : kind.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Every block of the open graph; a click shows and selects it. */
function Outline() {
  const definition = useEditor((s) => s.definition)
  const fn = useEditor((s) => s.graph)
  const selected = useEditor((s) => s.selected)
  const [filter, setFilter] = useState('')
  const { getNode, setCenter, getZoom } = useReactFlow()
  const blocks = graphOf(definition, fn).blocks.filter((b) =>
    b.name.toLowerCase().includes(filter.trim().toLowerCase()),
  )
  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label="Filter blocks"
        placeholder="Filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-8 text-sm"
      />
      <ul data-testid="outline">
        {blocks.map((b) => {
          const kind = kindOf(b)
          const Icon = kind.icon
          return (
            <li key={b.name}>
              <button
                type="button"
                onClick={() => {
                  useEditor.getState().select(b.name)
                  const node = getNode(b.name)
                  if (node) {
                    const w = node.measured?.width ?? NODE_WIDTH
                    const h = node.measured?.height ?? 100
                    // A tall block (a form) is shown from its header down, not by its middle.
                    void setCenter(node.position.x + w / 2, node.position.y + Math.min(h / 2, 160), {
                      zoom: Math.max(getZoom(), 0.8),
                      duration: 250,
                    })
                  }
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-canvas',
                  selected === b.name && 'bg-subtle',
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 truncate font-mono">{b.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TriggersPanel() {
  const testInput = useEditor((s) => {
    const trigger = s.definition.blocks.find((b) => b.type === 'startTrigger')
    return trigger?.type === 'startTrigger' ? trigger.config?.testInput : undefined
  })
  return <TriggersForm testInput={testInput} />
}

interface SearchHit {
  /** Unique among the hits: where the line is. */
  id: string
  fn: string | null
  block: string
  field: string
  line: string
}

/** Searches every block's text (code, SQL, templates), in the workflow and its functions. */
function CodeSearch() {
  const definition = useEditor((s) => s.definition)
  const [text, setText] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [word, setWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const { pattern, error } = useMemo(() => {
    if (!text) return { pattern: null, error: null }
    try {
      const source = regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return {
        pattern: new RegExp(word ? `\\b(?:${source})\\b` : source, caseSensitive ? '' : 'i'),
        error: null,
      }
    } catch (err) {
      return { pattern: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [text, caseSensitive, word, regex])
  const hits = useMemo(() => {
    if (!pattern) return []
    const out: SearchHit[] = []
    const graphs: [string | null, GraphPart][] = [
      [null, definition],
      ...(definition.functions ?? []).map((f) => [f.name, f] as [string, GraphPart]),
    ]
    for (const [fn, graph] of graphs) {
      for (const block of graph.blocks) {
        walkStrings('config' in block ? block.config : undefined, '', (field, value) => {
          for (const [n, line] of value.split('\n').entries()) {
            if (pattern.test(line)) {
              out.push({ id: `${fn}/${block.name}/${field}:${n}`, fn, block: block.name, field, line })
            }
          }
        })
      }
    }
    return out.slice(0, 200)
  }, [pattern, definition])
  const toggle = (label: string, title: string, on: boolean, set: (v: boolean) => void) => (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={() => set(!on)}
      className={cn(
        'cursor-pointer rounded px-1.5 font-mono text-xs text-muted hover:bg-subtle',
        on && 'bg-accent-soft text-accent',
      )}
    >
      {label}
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-md border border-border pr-1">
        <Input
          aria-label="Search code"
          placeholder="Search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-8 border-0 text-sm shadow-none"
        />
        {toggle('Aa', 'Match case', caseSensitive, setCase)}
        {toggle('ab', 'Match whole word', word, setWord)}
        {toggle('.*', 'Use regular expression', regex, setRegex)}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {text && !error && (
        <p className="text-xs text-muted">
          {hits.length} result{hits.length === 1 ? '' : 's'}
        </p>
      )}
      <ul data-testid="code-search-results">
        {hits.map((hit) => (
          <li key={hit.id}>
            <button
              type="button"
              onClick={() => useEditor.getState().openGraph(hit.fn, hit.block)}
              className="flex w-full cursor-pointer flex-col rounded-md px-2 py-1 text-left hover:bg-canvas"
            >
              <span className="font-mono text-xs text-muted">
                {[hit.fn, hit.block].filter(Boolean).join('.')} · {hit.field}
              </span>
              <span className="truncate font-mono text-xs">{hit.line.trim()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function walkStrings(value: unknown, path: string, visit: (field: string, value: string) => void) {
  if (typeof value === 'string') visit(path || 'value', value)
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walkStrings(v, `${path}[${i}]`, visit)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit)
  }
}

function Problems() {
  const diagnostics = useEditor((s) => s.diagnostics)
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  return (
    <div className="flex min-h-0 flex-col">
      <p className="mb-3 text-xs text-muted">
        {errors ? `${errors} error${errors === 1 ? '' : 's'} to fix before this workflow can run.` : ''}
      </p>
      <ProblemList diagnostics={diagnostics} empty="No problems found." />
    </div>
  )
}

function ProblemList({ diagnostics, empty }: { diagnostics: Diagnostic[]; empty: string }) {
  const openGraph = useEditor((s) => s.openGraph)
  if (!diagnostics.length) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted">
        <CheckCircle2 className="size-4 text-success" /> {empty}
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 overflow-y-auto" data-testid="problems">
      {diagnostics.map((d) => (
        <li key={`${d.code}:${d.path.join('.')}:${d.start ?? ''}`}>
          <button
            type="button"
            onClick={() =>
              d.block ? openGraph(d.function ?? null, d.block) : d.function && openGraph(d.function)
            }
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-canvas"
          >
            <AlertCircle
              className={cn(
                'mt-0.5 size-4 shrink-0',
                d.severity === 'error' ? 'text-danger' : 'text-warning-strong',
              )}
            />
            <span className="min-w-0">
              {(d.function || d.block) && (
                <span className="font-mono text-xs text-muted">
                  {[d.function, d.block].filter(Boolean).join('.')} ·{' '}
                </span>
              )}
              {d.message}
              {d.hint && <span className="block text-xs text-muted">{d.hint}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
