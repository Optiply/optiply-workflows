import { type Block, isTrigger } from '@ow/definition'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useStore } from '@xyflow/react'
import {
  CheckCircle2,
  Copy,
  CopyPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Repeat,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Menu, MenuItem, MenuSeparator, Spinner } from '@/components/ui'
import { FINAL_RUN_STATUSES, runsApi } from '@/lib/runs-api'
import { cn } from '@/lib/utils'
import { removeFrom, setEntry } from './canvas'
import { nextName } from './catalog'
import { copyText, duplicateChosen } from './clipboard'
import { BlockSettingsForm } from './inspectors'
import { NODE_GAP, nodeHeight, positionsFor } from './layout'
import { DataTab, JsonTree } from './result-view'
import { runBlock, useRun } from './run-state'
import { graphOf, updateGraph, useEditor } from './store'
import { switchBlock, switchTarget } from './switch-block'

export type NodeTab = 'inputs' | 'data' | 'json' | 'logs' | 'settings'

/** A result panel's height until it's resized, and its bounds (the schema's for `h`). */
const PANEL_HEIGHT = 240
const PANEL_MIN = 96
const PANEL_MAX = 448
const FINAL_BLOCK = new Set(['succeeded', 'errored', 'failed', 'skipped', 'cancelled'])
/** Blocks whose own code logs: their nodes get a Logs tab. */
const LOGGING = new Set<Block['type']>(['code', 'loop', 'function', 'workflow'])

/** A block's tabs, as Retool's node footer has them. */
export function nodeTabs(block: Block): NodeTab[] {
  if (block.type === 'startTrigger') return ['data', 'json']
  if (isTrigger(block)) return ['data', 'json']
  return ['inputs', 'data', 'json', ...(LOGGING.has(block.type) ? (['logs'] as const) : []), 'settings']
}

const LABEL: Record<NodeTab, string> = {
  inputs: 'Inputs',
  data: 'Data',
  json: 'JSON',
  logs: 'Logs',
  settings: 'Settings',
}

interface BlockResultState {
  status: string
  data: unknown
  error: { code: string; message: string } | null
  loading: boolean
  /** The open run's id, when the result comes from it (not the latest finished run). */
  runId: string | null
}

/** A block's result on the canvas: from the run open in the editor, else the latest finished run's sample. */
function useBlockResult(name: string): BlockResultState | null {
  const fn = useEditor((s) => s.graph)
  const runId = useRun((s) => s.runId)
  const live = useRun((s) => (fn === null ? s.blocks[name] : undefined))
  const sample = useEditor((s) => (fn === null ? s.samples[name] : undefined))
  const fromRun = Boolean(runId && live)
  const result = useQuery({
    queryKey: ['run', runId, 'block', name, live?.status],
    queryFn: () => runsApi.block(runId!, name),
    enabled: fromRun && FINAL_BLOCK.has(live?.status ?? ''),
  })
  if (fromRun && live) {
    return {
      status: live.status,
      data: result.data?.data,
      error: result.data?.error ?? null,
      loading: result.isLoading && FINAL_BLOCK.has(live.status),
      runId,
    }
  }
  if (sample) return { status: sample.status, data: sample.data, error: null, loading: false, runId: null }
  return null
}

/**
 * A node's footer: its tabs and its last status. A tab opens its panel under the block; a run of this block opens
 * Data when it finishes.
 */
export function NodeFooter({ block }: { block: Block }) {
  const name = block.name
  const [tab, setTab] = useState<NodeTab | null>(null)
  const result = useBlockResult(name)
  const target = useRun((s) => s.run?.targetBlocks?.[0])
  const runId = useRun((s) => s.runId)
  const status = result?.runId ? result.status : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new run of this block opens Data again
  useEffect(() => {
    if (target === name && status && FINAL_BLOCK.has(status)) setTab((t) => t ?? 'data')
  }, [target, status, name, runId])
  const tabs = nodeTabs(block)
  const saved = useEditor((s) => graphOf(s.definition, s.graph).layout?.blocks?.[name]?.h)
  const zoom = useStore((s) => s.transform[2])
  // While its bottom edge is dragged; kept afterwards as the block's layout entry `h`.
  const [dragged, setDragged] = useState<number | null>(null)
  const height = dragged ?? saved ?? PANEL_HEIGHT
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startHeight = height
    let next = startHeight
    const move = (ev: PointerEvent) => {
      // The canvas is zoomed: a screen pixel is 1/zoom of the panel's own.
      next = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startHeight + (ev.clientY - startY) / zoom)))
      setDragged(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (next !== startHeight && !useEditor.getState().readOnly) setEntry(name, { h: next })
      setDragged(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      <div className="nodrag flex h-7 shrink-0 items-center gap-3 border-t border-border px-2.5 text-xs">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            data-testid={`node-tab-${name}-${t}`}
            onClick={() => setTab((was) => (was === t ? null : t))}
            className={cn(
              'cursor-pointer border-b-2 py-1 hover:text-ink',
              tab === t ? 'border-ink text-ink' : 'border-transparent',
              (t === 'data' || t === 'json') && !result ? 'text-faint' : 'text-muted',
            )}
          >
            {LABEL[t]}
          </button>
        ))}
        <div className="flex-1" />
        <StatusIcon status={result?.status} />
      </div>
      {tab && (
        <div
          className="nodrag nowheel nokey absolute top-full right-0 left-0 mt-1.5 flex max-h-[28rem] min-h-24 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card"
          style={{ height: tab === 'settings' ? undefined : height }}
          data-testid={`node-panel-${name}`}
        >
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={() => setTab(null)}
            className="absolute top-1 right-1 z-[2] flex size-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-subtle"
          >
            <X className="size-3.5" />
          </button>
          <NodePanel block={block} tab={tab} result={result} />
          {tab !== 'settings' && (
            <div
              title="Drag to resize"
              data-testid={`node-panel-resize-${name}`}
              onPointerDown={startResize}
              className="absolute right-0 bottom-0 left-0 h-1.5 cursor-row-resize hover:bg-accent/30"
            />
          )}
        </div>
      )}
    </>
  )
}

function StatusIcon({ status }: { status: string | undefined }) {
  if (!status) return null
  if (status === 'succeeded') return <CheckCircle2 className="size-3.5 text-success" aria-label="succeeded" />
  if (status === 'failed' || status === 'errored')
    return <XCircle className="size-3.5 text-danger" aria-label={status} />
  if (status === 'running')
    return <Loader2 className="size-3.5 animate-spin text-accent" aria-label="running" />
  return <span className="text-faint">{status}</span>
}

function NodePanel({ block, tab, result }: { block: Block; tab: NodeTab; result: BlockResultState | null }) {
  const name = block.name
  if (tab === 'settings') {
    return (
      <div className="overflow-y-auto p-3 pr-8 text-sm">
        <BlockSettingsForm name={name} open />
      </div>
    )
  }
  if (tab === 'inputs') return <NodeInputs name={name} />
  if (tab === 'logs') return <NodeLogs name={name} />
  if (!result) {
    return <p className="p-3 pr-8 text-xs text-muted">No result yet: run this block (▶) or the workflow.</p>
  }
  if (result.loading) return <Spinner />
  if (result.error) {
    return (
      <p className="m-2 mr-8 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">
        <span className="font-mono">{result.error.code}</span> {result.error.message}
      </p>
    )
  }
  if (result.status !== 'succeeded') return <p className="p-3 pr-8 text-xs text-muted">{result.status}</p>
  return tab === 'data' ? (
    <DataTab value={result.data} name={name} className="min-h-0 flex-1 pr-7" />
  ) : (
    <JsonTree value={result.data} name={name} root={`${name}.data`} className="min-h-0 flex-1 pr-7" />
  )
}

/** The data of the blocks connected into this one, from the same run (or the latest run's samples). */
function NodeInputs({ name }: { name: string }) {
  const fn = useEditor((s) => s.graph)
  const edges = useEditor((s) => s.definition.edges)
  const samples = useEditor((s) => s.samples)
  const runId = useRun((s) => s.runId)
  const live = useRun((s) => s.blocks)
  const from = fn === null ? [...new Set(edges.filter((e) => e.to === name).map((e) => e.from))] : []
  const results = useQueries({
    queries: from.map((key) => ({
      queryKey: ['run', runId, 'block', key, live[key]?.status],
      queryFn: () => runsApi.block(runId!, key),
      enabled: Boolean(runId && live[key] && FINAL_BLOCK.has(live[key]!.status)),
    })),
  })
  if (!from.length) return <p className="p-3 pr-8 text-xs text-muted">Nothing connects into "{name}".</p>
  const value = Object.fromEntries(
    from.map((key, i) => [
      key,
      runId && live[key] ? (results[i]?.data?.data ?? null) : (samples[key]?.data ?? null),
    ]),
  )
  return (
    <JsonTree value={value} name={`${name}-inputs`} root="" label="inputs" className="min-h-0 flex-1 pr-7" />
  )
}

/** This block's log lines in the open run. */
function NodeLogs({ name }: { name: string }) {
  const runId = useRun((s) => s.runId)
  const runStatus = useRun((s) => s.run?.status)
  const logs = useQuery({
    queryKey: ['run', runId, 'logs'],
    queryFn: () => runsApi.logs(runId!).then((r) => r.logs),
    enabled: Boolean(runId),
    refetchInterval: runStatus && FINAL_RUN_STATUSES.has(runStatus) ? false : 1000,
  })
  if (!runId) return <p className="p-3 pr-8 text-xs text-muted">Run the block to see its logs.</p>
  const mine = (logs.data ?? []).filter((l) => l.blockKey === name || l.blockKey?.startsWith(`${name}[`))
  if (!mine.length) return <p className="p-3 pr-8 text-xs text-muted">No logs from "{name}" in this run.</p>
  return (
    <ol
      className="min-h-0 flex-1 overflow-y-auto p-2 pr-8 font-mono text-xs"
      data-testid={`node-logs-${name}`}
    >
      {mine.map((l) => (
        <li
          key={l.id}
          className={cn(
            'py-0.5 break-all whitespace-pre-wrap',
            l.level === 'error' && 'text-danger',
            l.level === 'warn' && 'text-warning-strong',
          )}
        >
          [{l.level}] {l.message}
        </li>
      ))}
    </ol>
  )
}

/** Replaces a block by its switched type (`switch-block.ts`); its connections and place stay. */
function switchType(name: string) {
  updateGraph((g) => ({
    ...g,
    blocks: g.blocks.map((b) => (b.name === name ? (switchBlock(b) ?? b) : b)),
  }))
}

/** Adds the workflow's error handler (one at most) under the start trigger, and selects it. */
function addErrorHandler() {
  let added = ''
  updateGraph((g) => {
    const positions = positionsFor(g)
    added = nextName(
      'errorTrigger',
      g.blocks.map((b) => b.name),
    )
    const start = g.blocks.find((b) => b.type === 'startTrigger')
    const below = start && positions[start.name]
    const at = below
      ? { x: below.x, y: below.y + nodeHeight(start, below) + NODE_GAP }
      : { x: 0, y: Math.max(0, ...Object.values(positions).map((p) => p.y)) + 300 }
    return {
      ...g,
      blocks: [...g.blocks, { name: added, type: 'errorTrigger' }],
      layout: { ...g.layout, blocks: { ...positions, [added]: at } },
    }
  })
  useEditor.getState().select(added)
}

/**
 * The node's ⋯ menu: run with the blocks before it, rename, duplicate, copy, switch its type where the config carries
 * over, add the workflow's error handler, delete.
 */
export function BlockMenu({ block, onRename }: { block: Block; onRename: () => void }) {
  const name = block.name
  const fn = useEditor((s) => s.graph)
  const editable = !useEditor((s) => s.readOnly)
  const hasHandler = useEditor((s) => s.definition.blocks.some((b) => b.type === 'errorTrigger'))
  const target = switchTarget(block)
  const select = () => useEditor.getState().select(name)
  return (
    <Menu
      label={`${name} actions`}
      trigger={(props) => (
        <button
          type="button"
          title="More actions"
          aria-label={`More actions for ${name}`}
          className="flex size-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-subtle hover:text-ink"
          {...props}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      )}
    >
      {fn === null && !isTrigger(block) && (
        <MenuItem icon={<Play />} onClick={() => runBlock(name, { fresh: true })}>
          Run with previous blocks
        </MenuItem>
      )}
      {editable && (
        <MenuItem icon={<Pencil />} onClick={onRename}>
          Rename
        </MenuItem>
      )}
      {editable && block.type !== 'startTrigger' && (
        <MenuItem
          icon={<CopyPlus />}
          onClick={() => {
            select()
            duplicateChosen()
          }}
        >
          Duplicate
        </MenuItem>
      )}
      <MenuItem
        icon={<Copy />}
        onClick={() => {
          select()
          const text = copyText()
          if (text) void navigator.clipboard?.writeText(text)
        }}
      >
        Copy
      </MenuItem>
      {editable && target && (
        <MenuItem icon={<Repeat />} onClick={() => switchType(name)}>
          {target.label}
        </MenuItem>
      )}
      {editable && fn === null && !hasHandler && (
        <MenuItem icon={<TriangleAlert />} onClick={addErrorHandler}>
          Add global error handler
        </MenuItem>
      )}
      {editable && block.type !== 'startTrigger' && (
        <>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 />}
            onClick={() => {
              updateGraph((g) => removeFrom(g, new Set([name])))
              useEditor.getState().select(null)
            }}
          >
            Delete
          </MenuItem>
        </>
      )}
    </Menu>
  )
}
