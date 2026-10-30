import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Download, Square, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Button, ErrorNote, Select, Spinner } from '@/components/ui'
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
import { ResultTabs } from './result-view'
import { cancelOpenRun, isFinal, useRun } from './run-state'
import { useEditor } from './store'

/** The open run: its blocks with data and errors, its logs and its output, plus a picker of recent runs. */
export function RunPanel() {
  const runId = useRun((s) => s.runId)
  const run = useRun((s) => s.run)
  const slug = useRun((s) => s.slug)
  const [tab, setTab] = useState<'blocks' | 'logs' | 'output'>('blocks')
  const recent = useQuery({ queryKey: ['workflow-runs', slug], queryFn: () => runsApi.ofWorkflow(slug, 20) })

  return (
    <section
      className="nokey flex h-80 shrink-0 flex-col border-t border-border bg-surface"
      data-testid="run-panel"
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <span className="text-sm font-semibold">Run</span>
        <Select
          aria-label="Run"
          className="h-8 max-w-72"
          value={runId ?? ''}
          onChange={(e) => useRun.getState().open(e.target.value || null)}
        >
          <option value="">{recent.data?.length ? 'Pick a run…' : 'No runs yet'}</option>
          {recent.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {new Date(r.createdAt).toLocaleTimeString()} · {r.status} · {r.environment}
              {r.targetBlocks ? ` · only ${r.targetBlocks.join(', ')}` : ''}
            </option>
          ))}
        </Select>
        {run && (
          <>
            <StatusBadge status={run.status} />
            <span className="whitespace-nowrap text-xs text-muted">
              {run.environment} · {run.targetBlocks ? `block ${run.targetBlocks.join(', ')}` : run.version} ·{' '}
              {duration(run.startedAt, run.finishedAt)}
            </span>
            {queueMessageLine(run) && (
              <span
                className="whitespace-nowrap text-xs text-muted"
                data-testid={run.triggerType === 'pubsub' ? 'run-pubsub' : 'run-queue'}
              >
                {queueMessageLine(run)}
              </span>
            )}
            {run.parentRunId && (
              <span className="whitespace-nowrap text-xs text-muted">
                started by <RunLink runId={run.parentRunId} />
              </span>
            )}
            {!isFinal(run.status) && <CancelButton />}
          </>
        )}
        <div className="flex-1" />
        {(['blocks', 'logs', 'output'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'cursor-pointer rounded-md px-2.5 py-1 text-sm capitalize text-muted hover:text-ink',
              tab === t && 'bg-accent-soft font-medium text-accent',
            )}
          >
            {t}
          </button>
        ))}
        {run && isFinal(run.status) && <ExportButton run={run} />}
        <Button
          size="icon"
          variant="ghost"
          title="Close run panel"
          onClick={() => useRun.getState().togglePanel(false)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {!runId ? (
          <p className="p-4 text-sm text-muted">
            Run the workflow, or pick an earlier run, to see its results here.
          </p>
        ) : !run ? (
          <Spinner />
        ) : tab === 'blocks' ? (
          <BlocksTab run={run} />
        ) : tab === 'logs' ? (
          <LogsTab run={run} />
        ) : (
          <OutputTab run={run} />
        )}
      </div>
    </section>
  )
}

function BlocksTab({ run }: { run: RunView }) {
  const live = useRun((s) => s.blocks)
  const progress = useRun((s) => s.iterations)
  // Select the definition itself: a selector returning a new array each time would re-render forever.
  const definition = useEditor((s) => s.definition)
  const order = useMemo(() => definition.blocks.map((b) => b.name), [definition])
  const selected = useEditor((s) => s.selected)
  const blocks = useQuery({
    queryKey: ['run', run.id, 'blocks', run.status, Object.keys(live).length],
    queryFn: () => runsApi.blocks(run.id),
  })
  const byKey = new Map((blocks.data ?? []).map((b) => [b.key, b]))
  const keys = [...new Set([...order.filter((k) => live[k] || byKey.has(k)), ...byKey.keys()])]
  const current = selected && (live[selected] || byKey.has(selected)) ? selected : keys[0]

  return (
    <div className="flex h-full">
      <ul className="w-64 shrink-0 overflow-y-auto border-r border-border py-1" data-testid="run-blocks">
        {keys.map((key) => {
          const view = byKey.get(key)
          const status = live[key]?.status ?? view?.status ?? 'pending'
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => useEditor.getState().select(key)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas',
                  key === current && 'bg-accent-soft',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{key}</span>
                {view?.metadata?.cachedFrom ? <span className="text-xs text-muted">cached</span> : null}
                {progress[key] && status === 'running' ? (
                  <span className="text-xs text-muted">{progress[key]} done</span>
                ) : null}
                <span className="text-xs text-muted">
                  {view ? duration(view.startedAt, view.finishedAt) : ''}
                </span>
                <StatusBadge status={status} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        {current && (
          <BlockResult
            runId={run.id}
            view={byKey.get(current)}
            name={current}
            runStatus={run.status}
            isLoop={definition.blocks.some((b) => b.name === current && b.type === 'loop')}
          />
        )}
      </div>
    </div>
  )
}

function BlockResult({
  runId,
  name,
  view,
  runStatus,
  isLoop,
}: {
  runId: string
  name: string
  view: BlockView | undefined
  runStatus: string
  isLoop: boolean
}) {
  const result = useQuery({
    queryKey: ['run', runId, 'block', name, view?.status, runStatus],
    queryFn: () => runsApi.block(runId, name),
    enabled: !!view,
  })
  if (!view) return <p className="text-sm text-muted">"{name}" hasn't run in this run.</p>
  if (result.isLoading) return <Spinner />
  if (result.error) return <ErrorNote error={result.error} />
  const block = result.data!
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="block-result">
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
      {block.status !== 'waiting' && typeof block.metadata?.taskId === 'string' && (
        <p className="text-xs text-muted">
          <Link to="/inbox/$taskId" params={{ taskId: block.metadata.taskId }} className="hover:text-accent">
            Its task
          </Link>
        </p>
      )}
      {block.status === 'succeeded' && (
        <ResultTabs value={block.data} name={name} root={`${name}.data`} className="h-64" />
      )}
      {isLoop && <Iterations runId={runId} loop={name} runStatus={runStatus} />}
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

function LogsTab({ run }: { run: RunView }) {
  const logs = useQuery({
    queryKey: ['run', run.id, 'logs'],
    queryFn: () => runsApi.logs(run.id).then((r) => r.logs),
    refetchInterval: FINAL_RUN_STATUSES.has(run.status) ? false : 1000,
  })
  if (logs.isLoading) return <Spinner />
  if (!logs.data?.length)
    return <p className="p-4 text-sm text-muted">No logs. console.log in code blocks shows up here.</p>
  return (
    <ol className="h-full overflow-y-auto p-2 font-mono text-xs" data-testid="run-logs">
      {logs.data.map((log) => (
        <li key={log.id} className="flex gap-3 px-1 py-0.5">
          <span className="shrink-0 text-muted">{new Date(log.at).toLocaleTimeString()}</span>
          <span className="w-24 shrink-0 truncate text-muted">{log.blockKey ?? 'run'}</span>
          <span
            className={cn(
              log.level === 'error' && 'text-danger',
              log.level === 'warn' && 'text-warning-strong',
            )}
          >
            {log.message}
          </span>
        </li>
      ))}
    </ol>
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
