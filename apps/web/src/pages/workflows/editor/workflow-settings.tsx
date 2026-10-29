import {
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_REQUIREMENTS,
  MAX_RUN_TIMEOUT_MS,
  type WorkflowDefinition,
} from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { ProtectDialog, UNPROTECT_CONFIRM, useGitInfo, useUnprotect } from '@/components/git'
import { Button, ErrorNote, Field, Input, Spinner, Textarea } from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { useEditor } from './store'

type Workflow = RouterOutputs['workflows']['get']
type WorkflowSettings = NonNullable<WorkflowDefinition['settings']>

/**
 * Workflow-wide settings: the run timeout and the Python packages are part of the definition (saved with the
 * draft, live once published); the concurrency limit belongs to the workflow and applies to every run at once.
 */
export function WorkflowSettingsTab({
  workflow,
  canEdit,
  hasEdit = canEdit,
}: {
  workflow: Workflow
  /** The draft shown can be edited (not a protected workflow's main draft). */
  canEdit: boolean
  /** The person has Edit on the workflow: settings outside the draft. */
  hasEdit?: boolean
}) {
  const timeoutMs = useEditor((s) => s.definition.settings?.timeoutMs)
  const setTimeoutMinutes = (text: string) =>
    useEditor.getState().update((def) => {
      const minutes = Number(text)
      if (!text.trim() || !Number.isFinite(minutes) || minutes <= 0)
        return withSetting(def, 'timeoutMs', undefined)
      const ms = Math.min(MAX_RUN_TIMEOUT_MS, Math.max(1000, Math.round(minutes * 60_000)))
      return withSetting(def, 'timeoutMs', ms)
    })

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Run timeout (minutes)"
        hint={`A run fails when it takes longer. Default ${DEFAULT_RUN_TIMEOUT_MS / 60_000}, at most ${MAX_RUN_TIMEOUT_MS / 3_600_000} hours. Saved with the draft; live runs use it once you publish.`}
      >
        <Input
          type="number"
          min={1}
          className="w-32"
          disabled={!canEdit}
          placeholder={String(DEFAULT_RUN_TIMEOUT_MS / 60_000)}
          defaultValue={timeoutMs ? String(timeoutMs / 60_000) : ''}
          onChange={(e) => setTimeoutMinutes(e.target.value)}
        />
      </Field>
      <PythonPackages workflowId={workflow.id} canEdit={canEdit} hasEdit={hasEdit} />
      <ConcurrencyLimit workflow={workflow} canEdit={hasEdit} />
      {workflow.level === 'own' && <GitProtection workflow={workflow} />}
    </div>
  )
}

/** One workflow setting set, or removed with `undefined`; settings left empty go too (stored sparsely). */
function withSetting<K extends keyof WorkflowSettings>(
  def: WorkflowDefinition,
  key: K,
  value: WorkflowSettings[K] | undefined,
): WorkflowDefinition {
  const { [key]: _old, ...others } = def.settings ?? {}
  const settings = value === undefined ? others : { ...others, [key]: value }
  const { settings: _settings, ...rest } = def
  return Object.keys(settings).length ? { ...rest, settings } : rest
}

/**
 * The workflow's Python packages (M23): pip requirements, one a line, installed for its Python blocks. Blank lines
 * aren't kept; the validator's problems show under the field, by line.
 */
function PythonPackages({
  workflowId,
  canEdit,
  hasEdit,
}: {
  workflowId: string
  canEdit: boolean
  /** Edit on the workflow: the install state and Install now (they're about the packages, not this draft). */
  hasEdit: boolean
}) {
  const requirements = useEditor((s) => s.definition.settings?.python?.requirements)
  // The whole list from the store (a filtered one would be a new array on every read), filtered here.
  const problems = useEditor((s) => s.diagnostics).filter((d) => d.code === 'invalid_requirement')
  const stored = requirements?.join('\n') ?? ''
  const [text, setText] = useState(stored)
  // Someone else's change (a collaborator, undo, a reload) shows here; the field's own blank lines stay while typing.
  useEffect(() => {
    setText((current) => (requirementLines(current).join('\n') === stored ? current : stored))
  }, [stored])
  const edit = (value: string) => {
    setText(value)
    const lines = requirementLines(value)
    useEditor
      .getState()
      .update((def) => withSetting(def, 'python', lines.length ? { requirements: lines } : undefined))
  }
  return (
    <Field
      label="Python packages"
      hint={`pip requirements for this workflow's Python blocks, one a line (polars==1.9.0, openpyxl>=3.1), at most ${MAX_REQUIREMENTS}; wheels from the package index only. Installed before a run, kept with each release.`}
    >
      <Textarea
        rows={4}
        className="font-mono text-xs"
        disabled={!canEdit}
        placeholder="polars==1.9.0"
        spellCheck={false}
        aria-label="Python packages"
        value={text}
        onChange={(e) => edit(e.target.value)}
      />
      {problems.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-danger" data-testid="requirement-problems">
          {problems.map((p) => {
            const index = p.path[3]
            return (
              <li key={`${index ?? 'all'}-${p.message}`}>
                {typeof index === 'number' ? `${requirements?.[index] ?? `Line ${index + 1}`}: ` : ''}
                {p.message}
              </li>
            )
          })}
        </ul>
      )}
      {hasEdit && requirements?.length && !problems.length ? (
        <PackagesState workflowId={workflowId} requirements={requirements} />
      ) : null}
    </Field>
  )
}

/**
 * Whether these packages are installed (M23): their versions and size, pip's reason when it failed, or not yet;
 * Install now so the next run doesn't wait. Asked again a moment after the field stops changing.
 */
function PackagesState({ workflowId, requirements }: { workflowId: string; requirements: string[] }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settled = useSettled(requirements, 600)
  const input = { workflowId, requirements: settled }
  const state = useQuery(trpc.workflows.pythonEnv.queryOptions(input))
  const install = useMutation(
    trpc.workflows.installPythonEnv.mutationOptions({
      // Under the requirements it installed: the field may have changed since.
      onSuccess: (data, sent) => queryClient.setQueryData(trpc.workflows.pythonEnv.queryKey(sent), data),
    }),
  )
  const data = state.data
  const button = (label: string) => (
    <Button size="sm" loading={install.isPending} onClick={() => install.mutate(input)}>
      {label}
    </Button>
  )
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="packages-state">
      {install.isPending ? (
        <span className="text-muted">Installing… (a first install can take a minute)</span>
      ) : !data ? (
        <Spinner />
      ) : !data.available ? (
        <span className="text-warning-strong">{data.message}</span>
      ) : data.state === 'none' ? (
        <div className="flex items-center gap-2">
          <span className="text-muted">Not installed yet: the next run installs them first.</span>
          {button('Install now')}
        </div>
      ) : data.state === 'ready' ? (
        <span className="text-muted">
          Installed: {data.packages.join(', ')} ({formatBytes(data.sizeBytes)})
        </span>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-danger">Install failed: {data.error}</span>
            {button('Try again')}
          </div>
          {data.log && (
            <details>
              <summary className="cursor-pointer text-muted">pip's output</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-2 font-mono">
                {data.log}
              </pre>
            </details>
          )}
        </>
      )}
      <ErrorNote error={install.error ?? state.error} />
    </div>
  )
}

/** The field's lines as requirements: trimmed, blank ones left out. */
function requirementLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** `value` once it has stayed the same for `ms` (compared as JSON). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `value`
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [key, ms])
  return settled
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Owners protect the workflow in Git (M11), or unprotect it. */
function GitProtection({ workflow }: { workflow: Workflow }) {
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const unprotect = useUnprotect('workflow')
  if (!git?.configured && !workflow.gitProtected) return null
  return (
    // Not a Field: that's a <label>, and these are buttons.
    <section className="flex flex-col gap-1.5">
      <h4 className="text-sm font-medium text-ink">Git</h4>
      <div>
        {workflow.gitProtected ? (
          <Button
            size="sm"
            variant="danger"
            loading={unprotect.isPending}
            onClick={async () =>
              (await confirmDialog(UNPROTECT_CONFIRM)) &&
              unprotect.mutate({ kind: 'workflow', id: workflow.id })
            }
          >
            Unprotect
          </Button>
        ) : (
          <Button size="sm" onClick={() => setProtecting(true)}>
            <GitBranch className="size-3.5" /> Protect in Git
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">
        {workflow.gitProtected
          ? `Protected: edited on branches, deployed by merging into ${git?.branch ?? 'the deploy branch'}.`
          : 'Protect it to have changes reviewed in pull requests before they go live.'}
      </span>
      <ErrorNote error={unprotect.error} />
      {protecting && <ProtectDialog kind="workflow" object={workflow} onClose={() => setProtecting(false)} />}
    </section>
  )
}

function ConcurrencyLimit({ workflow, canEdit }: { workflow: Workflow; canEdit: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [value, setValue] = useState(workflow.maxConcurrentRuns ? String(workflow.maxConcurrentRuns) : '')
  useEffect(
    () => setValue(workflow.maxConcurrentRuns ? String(workflow.maxConcurrentRuns) : ''),
    [workflow.maxConcurrentRuns],
  )
  const save = useMutation(
    trpc.workflows.update.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.workflows.get.queryKey({ id: workflow.id }) }),
    }),
  )
  const next = value.trim() ? Math.round(Number(value)) : null
  const invalid = next !== null && (!Number.isFinite(next) || next < 1 || next > 1000)
  const changed = next !== workflow.maxConcurrentRuns

  return (
    <Field
      label="Runs at once"
      hint="The most runs of this workflow that execute at the same time, editor runs included; more wait in the queue. Empty for no limit. Applies right away, not per release."
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          max={1000}
          className="w-32"
          disabled={!canEdit}
          placeholder="No limit"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {canEdit && (
          <Button
            size="sm"
            disabled={invalid || !changed}
            loading={save.isPending}
            onClick={() => save.mutate({ id: workflow.id, maxConcurrentRuns: next })}
          >
            Save
          </Button>
        )}
      </div>
      {invalid && <span className="text-xs text-danger">Use a number from 1 to 1000</span>}
      <ErrorNote error={save.error} />
    </Field>
  )
}
