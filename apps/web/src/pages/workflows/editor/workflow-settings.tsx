import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from '@ow/definition'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ProtectDialog, UNPROTECT_CONFIRM, useGitInfo, useUnprotect } from '@/components/git'
import { Button, ErrorNote, Field, Input } from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { useEditor } from './store'

type Workflow = RouterOutputs['workflows']['get']

/**
 * Workflow-wide settings: the run timeout is part of the definition (saved with the draft, live once published);
 * the concurrency limit belongs to the workflow and applies to every run at once.
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
      const { settings: _, ...rest } = def
      if (!text.trim() || !Number.isFinite(minutes) || minutes <= 0) return rest
      const ms = Math.min(MAX_RUN_TIMEOUT_MS, Math.max(1000, Math.round(minutes * 60_000)))
      return { ...rest, settings: { ...def.settings, timeoutMs: ms } }
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
      <ConcurrencyLimit workflow={workflow} canEdit={hasEdit} />
      {workflow.level === 'own' && <GitProtection workflow={workflow} />}
    </div>
  )
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
            onClick={() =>
              confirm(UNPROTECT_CONFIRM) && unprotect.mutate({ kind: 'workflow', id: workflow.id })
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
