import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  Maximize2,
  Minimize2,
  Square,
  X,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Button, Checkbox, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import {
  type BlockView,
  duration,
  FINAL_RUN_STATUSES,
  type IterationView,
  queueMessageLine,
  type RunView,
  runsApi,
} from '@/lib/runs-api'
import { cn } from '@/lib/utils'
import { kindOf } from './catalog'
import { DataTab, downloadJson, JsonTree } from './result-view'
import { countKinds, filterLines, type LevelFilter, logLines } from './run-logs'
import { cancelOpenRun, isFinal, useRun } from './run-state'
import { useEditor } from './store'

/** The run history panel's height, per browser. */
const HEIGHT_KEY = 'ow.runPanelHeight'
const MIN_HEIGHT = 160
const DEFAULT_HEIGHT = 320

function storedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

/** The whole run, in the blocks column: its input, its response and every log line. */
const GLOBAL = '\u0000global'

type DetailTab = 'inputs' | 'data' | 'json' | 'logs' | 'output'
const DETAIL_TABS: DetailTab[] = ['inputs', 'data', 'json', 'logs', 'output']

/**
 * The run history panel, under the canvas: runs, the chosen run's blocks (and the run as a whole), and the chosen
 * one's inputs, data, JSON and logs. Dragging its top edge resizes it; it can take the canvas' whole height.
 */
export function RunPanel() {
  const runId = useRun((s) => s.runId)
  const run = useRun((s) => s.run)
  const [height, setHeight] = useState(storedHeight)
  const [maximized, setMaximized] = useState(false)
  const [tab, setTab] = useState<DetailTab>('data')
  const panel = useRef<HTMLElement>(null)

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = panel.current?.offsetHeight ?? height
    const max = (panel.current?.parentElement?.offsetHeight ?? window.innerHeight) - 48
    let next = startHeight
    const move = (ev: PointerEvent) => {
      next = Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - ev.clientY))
      setHeight(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMaximized(false)
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(next)))
      } catch {
        // Storage blocked: the height lasts until the page reloads.
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <section
      ref={panel}
      className={cn(
        'nokey flex shrink-0 flex-col border-t border-border bg-surface',
        maximized && 'absolute inset-0 z-20 border-t-0',
      )}
      style={maximized ? undefined : { height }}
      data-testid="run-panel"
      data-run-id={runId ?? ''}
    >
      <div
        className="h-1.5 shrink-0 cursor-row-resize hover:bg-accent/30"
        title="Drag to resize"
        data-testid="run-panel-resize"
        onPointerDown={startResize}
      />
      <div className="flex min-h-0 flex-1">
        <RunsColumn />
        {!runId ? (
          <p className="p-4 text-sm text-muted">
            Run the workflow, or pick an earlier run, to see its results here.
          </p>
        ) : !run ? (
          <div className="flex-1">
            <Spinner />
          </div>
        ) : (
          <RunDetail key={run.id} run={run} tab={tab} setTab={setTab} />
        )}
        <div className="flex shrink-0 flex-col gap-1 border-l border-border p-1">
          <Button
            size="icon"
            variant="ghost"
            title={maximized ? 'Restore the panel' : 'Maximize the panel'}
            aria-label={maximized ? 'Restore the panel' : 'Maximize the panel'}
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Close run panel"
            aria-label="Close run panel"
            onClick={() => useRun.getState().togglePanel(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </section>
  )
}

/** The workflow's recent runs; the open one is highlighted. */
function RunsColumn() {
  const slug = useRun((s) => s.slug)
  const runId = useRun((s) => s.runId)
  const status = useRun((s) => s.run?.status)
  const recent = useQuery({
    queryKey: ['workflow-runs', slug, runId, status],
    queryFn: () => runsApi.ofWorkflow(slug, 20),
  })
  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-border" aria-label="Runs">
      <div className="flex h-8 shrink-0 items-center px-3 text-xs font-semibold">Runs</div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-1" data-testid="run-list">
        {!recent.data?.length && <li className="px-2 text-xs text-muted">No runs yet</li>}
        {recent.data?.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              aria-current={r.id === runId ? 'true' : undefined}
              onClick={() => useRun.getState().open(r.id)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-canvas',
                r.id === runId && 'bg-subtle',
              )}
            >
              <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[r.status] ?? 'bg-muted/50')} />
              <span className="min-w-0 flex-1 truncate font-mono">
                {new Date(r.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
              <span className="truncate text-muted">
                {r.targetBlocks ? r.targetBlocks.join(', ') : r.environment}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

const STATUS_DOT: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-danger',
  running: 'animate-pulse bg-accent',
  queued: 'bg-muted/50',
  waiting: 'bg-warning',
  cancelled: 'bg-muted/50',
}

function RunDetail({ run, tab, setTab }: { run: RunView; tab: DetailTab; setTab: (tab: DetailTab) => void }) {
  // A block run opens on its block; otherwise on the run as a whole.
  const [chosen, setChosen] = useState<string>(run.targetBlocks?.[0] ?? GLOBAL)
  const live = useRun((s) => s.blocks)
  const progress = useRun((s) => s.iterations)
  // Select the definition itself: a selector returning a new array each time would re-render forever.
  const definition = useEditor((s) => s.definition)
  const blocks = useQuery({
    queryKey: ['run', run.id, 'blocks', run.status, Object.keys(live).length],
    queryFn: () => runsApi.blocks(run.id),
  })
  const byKey = new Map((blocks.data ?? []).map((b) => [b.key, b]))
  const order = definition.blocks.map((b) => b.name)
  const keys = [...new Set([...order.filter((k) => live[k] || byKey.has(k)), ...byKey.keys()])]
  const current = chosen !== GLOBAL && keys.includes(chosen) ? chosen : GLOBAL

  return (
    <>
      <div className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex h-8 shrink-0 items-center gap-2 px-3">
          <span className="text-xs font-semibold">Blocks</span>
          <StatusBadge status={run.status} />
          {!isFinal(run.status) && <CancelButton />}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-1" data-testid="run-blocks">
          <li>
            <button
              type="button"
              onClick={() => setChosen(GLOBAL)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-canvas',
                current === GLOBAL && 'bg-accent-soft',
              )}
            >
              <Globe className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">Global (all blocks)</span>
              <span className="text-muted">{duration(run.startedAt, run.finishedAt)}</span>
            </button>
          </li>
          {keys.map((key) => {
            const view = byKey.get(key)
            const status = live[key]?.status ?? view?.status ?? 'pending'
            const block = definition.blocks.find((b) => b.name === key)
            const Icon = block ? kindOf(block).icon : null
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => {
                    setChosen(key)
                    if (tab === 'output') setTab('data')
                    useEditor.getState().select(key)
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-canvas',
                    key === current && 'bg-accent-soft',
                    status === 'skipped' && 'text-muted',
                    (status === 'failed' || status === 'errored') && 'text-danger',
                  )}
                >
                  {Icon ? <Icon className="size-3.5 shrink-0 text-muted" /> : <span className="size-3.5" />}
                  <span className="min-w-0 flex-1 truncate font-mono">{key}</span>
                  {view?.metadata?.cachedFrom ? <span className="text-muted">cached</span> : null}
                  {progress[key] && status === 'running' ? (
                    <span className="text-muted">{progress[key]} done</span>
                  ) : null}
                  <span className="text-muted">{view ? duration(view.startedAt, view.finishedAt) : ''}</span>
                  <span
                    title={status}
                    className={cn('size-2 shrink-0 rounded-full', BLOCK_DOT[status] ?? 'bg-muted/40')}
                  />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-4 border-b border-border px-3 text-xs">
          {DETAIL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'cursor-pointer border-b-2 py-1.5 capitalize text-muted hover:text-ink',
                tab === t ? 'border-ink text-ink' : 'border-transparent',
              )}
            >
              {t === 'json' ? 'JSON' : t}
            </button>
          ))}
          <div className="flex-1" />
          <span className="truncate text-muted">
            {run.environment} · {run.targetBlocks ? `block ${run.targetBlocks.join(', ')}` : run.version}
            {queueMessageLine(run) && (
              <span data-testid={run.triggerType === 'pubsub' ? 'run-pubsub' : 'run-queue'}>
                {' '}
                · {queueMessageLine(run)}
              </span>
            )}
            {run.parentRunId && (
              <>
                {' '}
                · started by <RunLink runId={run.parentRunId} />
              </>
            )}
          </span>
          {isFinal(run.status) && <ExportButton run={run} />}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'logs' ? (
            <LogsTab run={run} views={blocks.data ?? []} block={current === GLOBAL ? undefined : current} />
          ) : tab === 'output' ? (
            <OutputTab run={run} />
          ) : current === GLOBAL ? (
            <GlobalResult run={run} tab={tab} />
          ) : (
            <BlockResult
              runId={run.id}
              view={byKey.get(current)}
              name={current}
              runStatus={run.status}
              tab={tab}
              views={byKey}
              isLoop={definition.blocks.some((b) => b.name === current && b.type === 'loop')}
            />
          )}
        </div>
      </div>
    </>
  )
}

const BLOCK_DOT: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-danger',
  errored: 'bg-danger',
  running: 'animate-pulse bg-accent',
  waiting: 'bg-warning',
}

/** The run as a whole: its input, and its response (or error). */
function GlobalResult({ run, tab }: { run: RunView; tab: 'inputs' | 'data' | 'json' }) {
  const name = `run-${run.id}`
  if (tab === 'inputs')
    return (
      <JsonTree
        value={run.input.data ?? null}
        name={`${name}-input`}
        root="startTrigger.data"
        className="h-full"
      />
    )
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {run.error && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {run.error.block && <span className="font-mono">{run.error.block}: </span>}
          {run.error.message}
        </p>
      )}
      {!run.response && !run.error && isFinal(run.status) ? (
        <p className="p-2 text-sm text-muted">
          No response: the workflow has no Response block. Pick a block to see its data.
        </p>
      ) : tab === 'data' ? (
        <DataTab value={run.response?.body ?? null} name={name} className="min-h-0 flex-1" />
      ) : (
        <JsonTree value={run.response?.body ?? null} name={name} root="response" className="min-h-0 flex-1" />
      )}
    </div>
  )
}

function BlockResult({
  runId,
  name,
  view,
  runStatus,
  tab,
  views,
  isLoop,
}: {
  runId: string
  name: string
  view: BlockView | undefined
  runStatus: string
  tab: 'inputs' | 'data' | 'json'
  views: Map<string, BlockView>
  isLoop: boolean
}) {
  const result = useQuery({
    queryKey: ['run', runId, 'block', name, view?.status, runStatus],
    queryFn: () => runsApi.block(runId, name),
    enabled: !!view,
  })
  if (tab === 'inputs') return <BlockInputs runId={runId} name={name} views={views} />
  if (!view) return <p className="p-3 text-sm text-muted">"{name}" hasn't run in this run.</p>
  if (result.isLoading) return <Spinner />
  if (result.error) return <ErrorNote error={result.error} />
  const block = result.data!
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2 text-sm" data-testid="block-result">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium">{name}</span>
        <StatusBadge status={block.status} />
        {block.attempt > 1 && <span className="text-xs text-muted">attempt {block.attempt}</span>}
        {block.metadata?.cachedFrom ? (
          <span className="text-xs text-muted">result reused from an earlier run</span>
        ) : null}
      </div>
      {block.error && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-danger">
          <span className="font-mono text-xs">{block.error.code}</span> {block.error.message}
        </p>
      )}
      {block.status === 'waiting' && <WaitingNote metadata={block.metadata} />}
      {childRunOf(block) && (
        <p className="text-xs text-muted">
          Child run: <RunLink runId={childRunOf(block)!} />
        </p>
      )}
      <AiCall block={block} />
      {block.status !== 'waiting' && typeof block.metadata?.taskId === 'string' && (
        <p className="text-xs text-muted">
          <Link to="/inbox/$taskId" params={{ taskId: block.metadata.taskId }} className="hover:text-accent">
            Its task
          </Link>
        </p>
      )}
      {block.status === 'succeeded' &&
        (tab === 'data' ? (
          <DataTab value={block.data} name={name} className="max-h-[32rem] min-h-24 shrink-0" />
        ) : (
          <JsonTree value={block.data} name={name} root={`${name}.data`} className="max-h-[32rem] shrink-0" />
        ))}
      {isLoop && <Iterations runId={runId} loop={name} runStatus={runStatus} />}
    </div>
  )
}

/** What a block was given: the data of the blocks connected into it, from the same run. */
function BlockInputs({ runId, name, views }: { runId: string; name: string; views: Map<string, BlockView> }) {
  const definition = useEditor((s) => s.definition)
  const from = [...new Set(definition.edges.filter((e) => e.to === name).map((e) => e.from))].filter((k) =>
    views.has(k),
  )
  const results = useQueries({
    queries: from.map((key) => ({
      queryKey: ['run', runId, 'block', key, views.get(key)?.status],
      queryFn: () => runsApi.block(runId, key),
    })),
  })
  if (!from.length) return <p className="p-3 text-sm text-muted">No block before "{name}" ran in this run.</p>
  if (results.some((r) => r.isLoading)) return <Spinner />
  const value = Object.fromEntries(from.map((key, i) => [key, results[i]?.data?.data ?? null]))
  return <JsonTree value={value} name={`${name}-inputs`} root="" label="inputs" className="h-full" />
}

interface AiMeta {
  provider: string
  model: string
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  costUsd?: number | null
  durationMs?: number
  promptsHidden?: boolean
  request?: { system?: string; prompt?: string }
}

interface AgentStepView {
  workflow: string
  input: unknown
  runId: string | null
  ok: boolean
}

/** An AI call's metadata (M35): a query's, or a failed one's error details. */
function aiMetaOf(block: BlockView & { data: unknown }): AiMeta | null {
  for (const m of [block.metadata, block.error?.details] as unknown[]) {
    const meta = m as Partial<AiMeta> | null | undefined
    if (meta && (meta.provider === 'anthropic' || meta.provider === 'openai_compatible') && meta.usage) {
      return meta as AiMeta
    }
  }
  return null
}

/**
 * An AI call (M35): the model, tokens, cost and time; the prompts sent unless the resource hides them; an agent's
 * steps, each a link to its child run.
 */
function AiCall({ block }: { block: BlockView & { data: unknown } }) {
  const ai = aiMetaOf(block)
  if (!ai) return null
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US')
  const cached = (ai.usage.cacheReadTokens ?? 0) + (ai.usage.cacheWriteTokens ?? 0)
  const steps =
    ((block.data as { steps?: unknown } | null)?.steps as AgentStepView[] | undefined) ??
    ((block.error?.details as { steps?: unknown } | undefined)?.steps as AgentStepView[] | undefined)
  const provider = ai.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'
  const cost =
    typeof ai.costUsd === 'number' ? `$${ai.costUsd.toFixed(ai.costUsd < 0.01 ? 6 : 4)}` : 'cost unknown'
  return (
    <div className="space-y-1.5 rounded-md border border-border px-3 py-2 text-xs" data-testid="ai-call">
      <p className="text-muted">
        <span className="font-mono text-ink">{ai.model}</span> ({provider}) · {n(ai.usage.inputTokens)} input
        + {n(ai.usage.outputTokens)} output tokens
        {cached ? ` (${n(ai.usage.cacheReadTokens)} from cache)` : ''} · {cost}
        {typeof ai.durationMs === 'number' ? ` · ${(ai.durationMs / 1000).toFixed(1)} s` : ''}
      </p>
      {ai.promptsHidden ? (
        <p className="text-muted">Prompts hidden (the resource keeps them out of run history).</p>
      ) : ai.request ? (
        <details>
          <summary className="cursor-pointer text-muted hover:text-ink">Prompts sent</summary>
          {ai.request.system && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-subtle p-2 font-mono">
              <span className="text-muted">system: </span>
              {ai.request.system}
            </pre>
          )}
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-subtle p-2 font-mono">
            {ai.request.prompt}
          </pre>
        </details>
      ) : null}
      {steps?.length ? (
        <div data-testid="ai-steps">
          <p className="text-muted">Tool calls:</p>
          <ol className="ml-4 list-decimal">
            {steps.map((step) => (
              <li key={step.runId ?? `${step.workflow}:${JSON.stringify(step.input)}`}>
                <span className="font-mono">{step.workflow}</span> {step.ok ? '' : '(failed) '}
                {step.runId && <RunLink runId={step.runId} />}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

/** The child run a Workflow block started, from its metadata (or its waiting state). */
function childRunOf(block: BlockView & { data: unknown }): string | null {
  const meta = block.metadata ?? {}
  const id = meta.runId ?? meta.childRunId ?? (block.data as { runId?: unknown } | null)?.runId
  return typeof id === 'string' ? id : null
}

function WaitingNote({ metadata }: { metadata: Record<string, unknown> | null }) {
  const until = typeof metadata?.until === 'string' ? new Date(metadata.until) : null
  if (typeof metadata?.taskId === 'string') {
    return (
      <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
        Waiting for someone to complete its task.{' '}
        <Link to="/inbox/$taskId" params={{ taskId: metadata.taskId }} className="font-medium underline">
          Open the task
        </Link>
      </p>
    )
  }
  return (
    <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
      {metadata?.childRunId ? 'Waiting for its child run to finish' : 'Waiting'}
      {until && !metadata?.childRunId ? ` until ${until.toLocaleString()}` : ''}.
    </p>
  )
}

/** A link to a run in its workflow's editor (the parent of a child run, or a child). */
function RunLink({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => runsApi.get(runId) })
  if (!run.data) return <span className="font-mono">{runId.slice(0, 8)}</span>
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId: run.data.workflow.id }}
      search={{ run: runId }}
      className="font-medium text-accent hover:underline"
    >
      {run.data.workflow.name} · {run.data.status}
    </Link>
  )
}

function CancelButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        title="Cancel this run: in-flight queries and requests are stopped"
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await cancelOpenRun()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        {!busy && <Square className="size-3.5" />} Cancel
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </>
  )
}

const ITERATIONS_PAGE = 50

/** A loop's committed iterations, a page at a time, optionally only the failed ones; click one for its data. */
function Iterations({ runId, loop, runStatus }: { runId: string; loop: string; runStatus: string }) {
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<'' | 'errored' | 'failed'>('')
  const [open, setOpen] = useState<number | null>(null)
  const progress = useRun((s) => s.iterations[loop] ?? 0)
  const page = useQuery({
    queryKey: ['run', runId, 'iterations', loop, offset, status, runStatus, progress],
    queryFn: () =>
      runsApi.iterations(runId, loop, { offset, limit: ITERATIONS_PAGE, status: status || undefined }),
  })
  const total = page.data?.total ?? 0
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="iterations">
      <div className="flex items-center gap-2">
        <span className="font-medium">Iterations</span>
        <span className="text-xs text-muted">{total} committed</span>
        <div className="flex-1" />
        <Select
          aria-label="Iteration status"
          className="h-7 text-xs"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status)
            setOffset(0)
          }}
        >
          <option value="">All</option>
          <option value="errored">Errored (loop went on)</option>
          <option value="failed">Failed</option>
        </Select>
        <Button
          size="icon"
          variant="ghost"
          title="Previous page"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - ITERATIONS_PAGE))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted">
          {total ? `${offset + 1}–${Math.min(offset + ITERATIONS_PAGE, total)}` : '0'}
        </span>
        <Button
          size="icon"
          variant="ghost"
          title="Next page"
          disabled={offset + ITERATIONS_PAGE >= total}
          onClick={() => setOffset(offset + ITERATIONS_PAGE)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      {page.error && <ErrorNote error={page.error} />}
      <ul className="divide-y divide-border rounded-md border border-border">
        {page.data?.iterations.map((it) => (
          <IterationRow
            key={it.index}
            runId={runId}
            loop={loop}
            iteration={it}
            open={open === it.index}
            onToggle={() => setOpen(open === it.index ? null : it.index)}
          />
        ))}
      </ul>
    </div>
  )
}

function IterationRow({
  runId,
  loop,
  iteration,
  open,
  onToggle,
}: {
  runId: string
  loop: string
  iteration: IterationView
  open: boolean
  onToggle: () => void
}) {
  const data = useQuery({
    queryKey: ['run', runId, 'block', `${loop}[${iteration.index}]`],
    queryFn: () => runsApi.block(runId, `${loop}[${iteration.index}]`),
    enabled: open && iteration.status === 'succeeded',
  })
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-canvas"
      >
        <span className="w-12 font-mono text-muted">[{iteration.index}]</span>
        <StatusBadge status={iteration.status} />
        {iteration.attempt > 1 && <span className="text-muted">attempt {iteration.attempt}</span>}
        <span className="min-w-0 flex-1 truncate text-danger">{iteration.error?.message}</span>
        <span className="text-muted">{duration(iteration.startedAt, iteration.finishedAt)}</span>
      </button>
      {open && iteration.status === 'succeeded' && (
        <div className="px-2 pb-2">{data.data ? <Json value={data.data.data} /> : <Spinner />}</div>
      )}
    </li>
  )
}

/** A run's log lines (or one block's), filtered by text and by level, with their times. */
function LogsTab({ run, views, block }: { run: RunView; views: BlockView[]; block?: string }) {
  const [text, setText] = useState('')
  const [level, setLevel] = useState<LevelFilter>('all')
  const [timestamps, setTimestamps] = useState(true)
  const logs = useQuery({
    queryKey: ['run', run.id, 'logs'],
    queryFn: () => runsApi.logs(run.id).then((r) => r.logs),
    refetchInterval: FINAL_RUN_STATUSES.has(run.status) ? false : 1000,
  })
  const lines = useMemo(() => logLines(logs.data ?? [], views, block), [logs.data, views, block])
  const shown = filterLines(lines, text, level)
  const counts = countKinds(lines)
  const pick = (next: LevelFilter) => setLevel((was) => (was === next ? 'all' : next))
  if (logs.isLoading) return <Spinner />
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-2">
        <Input
          aria-label="Filter entries"
          placeholder="Filter entries"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-7 max-w-xs text-xs"
        />
        <div className="flex-1" />
        <Checkbox
          className="text-xs"
          label="Timestamps"
          checked={timestamps}
          onChange={(e) => setTimestamps(e.target.checked)}
        />
        <LevelCount
          label="errors"
          count={counts.error}
          tone="text-danger"
          active={level === 'error'}
          onClick={() => pick('error')}
        />
        <LevelCount
          label="succeeded"
          count={counts.success}
          tone="text-success"
          active={level === 'success'}
          onClick={() => pick('success')}
        />
        <LevelCount
          label="info"
          count={counts.info + counts.warn}
          tone="text-muted"
          active={level === 'info'}
          onClick={() => pick('info')}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="Download the logs"
          aria-label="Download the logs"
          onClick={() => downloadJson(lines, `${run.workflow.slug}-run-${run.id}-logs.json`)}
        >
          <Download className="size-3.5" />
        </Button>
      </div>
      {!lines.length ? (
        <p className="p-4 text-sm text-muted">No logs. console.log in code blocks shows up here.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs" data-testid="run-logs">
          {shown.map((line) => (
            <li
              key={line.id}
              className={cn(
                'flex items-start gap-2 px-2 py-0.5',
                line.kind === 'success' && 'bg-success/5',
                line.kind === 'error' && 'bg-danger/5 text-danger',
                line.kind === 'warn' && 'text-warning-strong',
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {line.kind === 'success' && <Check className="size-3 text-success" />}
                {line.kind === 'error' && <X className="size-3" />}
              </span>
              {!block && line.block && !line.message.startsWith('---') && (
                <span className="w-24 shrink-0 truncate text-muted">{line.block}</span>
              )}
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{line.message}</span>
              {timestamps && line.at && (
                <span className="shrink-0 text-muted">{new Date(line.at).toLocaleString()}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function LevelCount({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string
  count: number
  tone: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={`Show only ${label}`}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs',
        tone,
        active && 'bg-subtle ring-1 ring-border',
      )}
    >
      {count} {label}
    </button>
  )
}

function OutputTab({ run }: { run: RunView }) {
  return (
    <div className="grid h-full grid-cols-2 gap-3 overflow-y-auto p-3 text-sm">
      <div>
        <h3 className="mb-1 font-medium">Input</h3>
        <Json value={run.input.data ?? null} />
      </div>
      <div data-testid="run-output">
        <h3 className="mb-1 font-medium">{run.error ? 'Error' : 'Response'}</h3>
        {run.error ? (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-danger">
            {run.error.block && <span className="font-mono">{run.error.block}: </span>}
            {run.error.message}
          </p>
        ) : run.response ? (
          <>
            <p className="mb-1 text-xs text-muted">HTTP {run.response.status}</p>
            <Json value={run.response.body} />
          </>
        ) : (
          <p className="text-muted">
            {isFinal(run.status) ? 'No Response block ran.' : 'Waiting for the run…'}
          </p>
        )}
      </div>
    </div>
  )
}

/** Pretty JSON, cut short when it's huge (the full value is in the export). */
function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  const shown =
    text.length > 100_000 ? `${text.slice(0, 100_000)}\n… (${text.length - 100_000} more characters)` : text
  return (
    <pre className="max-h-56 overflow-auto rounded-md bg-canvas p-2 font-mono text-xs" data-testid="json">
      {shown}
    </pre>
  )
}

/** Downloads the run, every block with its data, and the logs as one JSON file. */
function ExportButton({ run }: { run: RunView }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      title="Download the run as JSON"
      onClick={async () => {
        setBusy(true)
        try {
          const blocks = await runsApi.blocks(run.id)
          const withData = await Promise.all(blocks.map((b) => runsApi.block(run.id, b.key)))
          const { logs } = await runsApi.logs(run.id)
          const blob = new Blob([JSON.stringify({ run, blocks: withData, logs }, null, 2)], {
            type: 'application/json',
          })
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = `${run.workflow.slug}-run-${run.id}.json`
          link.click()
          URL.revokeObjectURL(link.href)
        } finally {
          setBusy(false)
        }
      }}
    >
      <Download className="size-4" /> Export
    </Button>
  )
}
