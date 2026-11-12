import { type AppDefinition, addWorkflowQuery, type WorkflowAppQuery } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Workflow } from 'lucide-react'
import { useState } from 'react'
import { Dialog, EmptyState, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AppCodeField, EditorField, problemsAt } from './fields'
import { useAppEditor } from './store'

/** Picks a published workflow for a "Run workflow" query (M36). */
export function AddWorkflowQueryDialog({
  page,
  onAdd,
  onClose,
}: {
  page: string | null
  onAdd: (make: (def: AppDefinition) => { definition: AppDefinition; name: string }) => void
  onClose: () => void
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.workflows.list.queryOptions())
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const published = (list.data ?? []).filter(
    (w) => w.liveReleaseId && (!needle || w.name.toLowerCase().includes(needle) || w.slug.includes(needle)),
  )
  return (
    <Dialog title="Run a workflow" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          aria-label="Search workflows"
          placeholder="Search by name or slug"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {list.isLoading && <Spinner />}
        <ErrorNote error={list.error} />
        {list.data && published.length === 0 && (
          <EmptyState icon={<Workflow className="size-6" />} title="Nothing to run">
            Only published workflows you can see are listed.{' '}
            <Link to="/workflows" className="text-accent hover:underline">
              Open Workflows
            </Link>
          </EmptyState>
        )}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="workflow-picker">
          {published.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle"
                onClick={() => {
                  onAdd((def) => addWorkflowQuery(def, w.slug, { page }))
                  onClose()
                }}
              >
                <Workflow className="size-4 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{w.slug}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

/** A workflow query's workflow, whether to wait for it, and when it runs. */
export function WorkflowQueryHeader({
  query,
  edit,
}: {
  query: WorkflowAppQuery
  edit: (change: (q: WorkflowAppQuery) => WorkflowAppQuery) => void
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.workflows.list.queryOptions())
  const readOnly = useAppEditor((s) => s.readOnly)
  const workflow = list.data?.find((w) => w.slug === query.workflow)
  return (
    <>
      <Select
        aria-label="Workflow"
        disabled={readOnly}
        className="w-56"
        value={query.workflow}
        onChange={(e) => edit((q) => ({ ...q, workflow: e.target.value }))}
      >
        {!workflow && <option value={query.workflow}>{query.workflow}</option>}
        {(list.data ?? [])
          .filter((w) => w.liveReleaseId || w.slug === query.workflow)
          .map((w) => (
            <option key={w.id} value={w.slug}>
              {w.name}
            </option>
          ))}
      </Select>
      <Select
        aria-label="Wait"
        disabled={readOnly}
        className="w-56"
        value={query.mode ?? 'sync'}
        onChange={(e) => edit((q) => ({ ...q, mode: e.target.value as 'sync' | 'async' }))}
      >
        <option value="sync">Wait for its response</option>
        <option value="async">Start it and go on ({'{ runId }'})</option>
      </Select>
      <Select
        aria-label="Run"
        disabled={readOnly}
        className="w-56"
        value={query.run}
        onChange={(e) => edit((q) => ({ ...q, run: e.target.value as 'auto' | 'manual' }))}
      >
        <option value="manual">Run only when triggered</option>
        <option value="auto">Run automatically when inputs change</option>
      </Select>
      {workflow && (
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className="flex items-center gap-1 self-center text-xs text-accent hover:underline"
        >
          Open workflow <ExternalLink className="size-3" />
        </Link>
      )}
    </>
  )
}

/** The JSON its run starts with, as the workflow's `startTrigger.data`. */
export function WorkflowQueryBody({
  query,
  base,
  edit,
}: {
  query: WorkflowAppQuery
  base: (string | number)[]
  edit: (change: (q: WorkflowAppQuery) => WorkflowAppQuery) => void
}) {
  const diagnostics = useAppEditor((s) => s.diagnostics)
  return (
    <EditorField
      label="Input"
      hint='JSON with {{ }}, the run’s startTrigger.data, e.g. {"orderId": {{ table1.selectedRow.id }}}'
    >
      <AppCodeField
        path={[...base, 'input']}
        language="plaintext"
        height={100}
        value={query.input ?? ''}
        problems={problemsAt(diagnostics, [...base, 'input'])}
        onChange={(text) =>
          edit((q) => {
            const { input: _, ...rest } = q
            return text.trim() ? { ...rest, input: text } : rest
          })
        }
      />
    </EditorField>
  )
}
