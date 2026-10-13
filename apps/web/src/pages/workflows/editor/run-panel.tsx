import { useQuery } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Button, ErrorNote, Select, Spinner } from '@/components/ui'
import { type BlockView, duration, FINAL_RUN_STATUSES, type RunView, runsApi } from '@/lib/runs-api'
import { cn } from '@/lib/utils'
import { isFinal, useRun } from './run-state'
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
          <BlockResult runId={run.id} view={byKey.get(current)} name={current} runStatus={run.status} />
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
}: {
  runId: string
  name: string
  view: BlockView | undefined
  runStatus: string
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
      {block.status === 'succeeded' && <Json value={block.data} />}
    </div>
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
            className={cn(log.level === 'error' && 'text-danger', log.level === 'warn' && 'text-amber-700')}
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
