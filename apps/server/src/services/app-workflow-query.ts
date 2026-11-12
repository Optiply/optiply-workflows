import type { WorkflowAppQuery } from '@ow/app-definition'
import type { ConnectorErrorCode } from '@ow/connectors'
import { workflows } from '@ow/db'
import type { InlineRunner } from '@ow/engine'
import { renderJson } from '@ow/expressions'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { type Access, atLeast } from './permissions'
import type { QueryOutcome, QueryRunDeps } from './resource-query'
import type { RunEventHub } from './run-events'
import { Signal, waitForReply } from './webhooks'

/** How the API runs workflows for apps: its inline runner (as sync webhooks), and run events from other processes. */
export interface AppWorkflowRuns {
  runner: InlineRunner
  events?: RunEventHub
}

/** How long a sync workflow query waits when the query sets no timeout. */
export const DEFAULT_WORKFLOW_QUERY_TIMEOUT_MS = 120_000

/**
 * Runs an app's workflow query (M36): the workflow's live release, in the app's environment, as the person using the
 * app (`triggerType: 'app'`, `createdBy` them). `input` (a JSON template) becomes `startTrigger.data`; its values are
 * evaluated as a resource query's are (`evaluate`). `sync` waits for the run's Response block (its body is the
 * data) or its end; `async` answers `{ runId }` once it's queued.
 *
 * Who may: for the live release, whoever may use the app (its publisher vouched for the workflow, as for resources);
 * for the draft, the person also needs Use on the workflow.
 */
export async function runWorkflowQuery(
  deps: QueryRunDeps & { runs?: AppWorkflowRuns },
  access: Access,
  user: { id: string },
  opts: {
    query: WorkflowAppQuery
    environmentId: string
    evaluate: (code: string) => unknown
    draft: boolean
    signal?: AbortSignal
  },
): Promise<QueryOutcome> {
  const started = performance.now()
  // Connectors' error codes, the finer reason in `details.reason`.
  const fail = (
    code: ConnectorErrorCode,
    reason: string,
    message: string,
    details: Record<string, unknown> = {},
  ): QueryOutcome => ({
    ok: false,
    error: { code, message, details: { reason, ...details } },
    durationMs: Math.round(performance.now() - started),
  })
  const { query } = opts
  const [workflow] = await deps.db
    .select({ id: workflows.id, folderId: workflows.folderId, liveReleaseId: workflows.liveReleaseId })
    .from(workflows)
    .where(eq(workflows.slug, query.workflow))
  if (!workflow)
    return fail('invalid_query', 'unknown_workflow', `No workflow has the slug "${query.workflow}"`)
  if (opts.draft && !atLeast(access.workflowLevel(workflow), 'use')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need use access to workflow "${query.workflow}" to run the draft's queries`,
    })
  }
  if (!workflow.liveReleaseId)
    return fail('invalid_query', 'not_published', `Workflow "${query.workflow}" isn't published`)
  if (!deps.runs) return fail('connection', 'unavailable', "Workflows can't be run from apps here")

  let data: unknown = null
  if (query.input?.trim()) {
    try {
      data = await renderJson(query.input, async (code) => opts.evaluate(code))
    } catch (err) {
      return fail('expression', 'input', `The input: ${(err as Error).message}`)
    }
  }

  const signal = new Signal()
  const { run } = await deps.runs.runner.start(
    {
      workflowId: workflow.id,
      releaseId: workflow.liveReleaseId,
      environmentId: opts.environmentId,
      triggerType: 'app',
      input: { data },
      createdBy: user.id,
    },
    { onResponse: signal.fire, onDone: signal.fire },
  )
  const durationMs = () => Math.round(performance.now() - started)
  if (query.mode === 'async') {
    return {
      ok: true,
      data: { runId: run.id },
      metadata: { runId: run.id, workflow: query.workflow },
      durationMs: durationMs(),
    }
  }

  const timeoutMs = query.timeoutMs ?? DEFAULT_WORKFLOW_QUERY_TIMEOUT_MS
  const done = await waitForReply(deps.db, deps.runs.events, run.id, timeoutMs, signal, opts.signal)
  const details = { runId: run.id, workflow: query.workflow }
  if (opts.signal?.aborted)
    return fail('aborted', 'aborted', 'The app stopped waiting for the workflow', details)
  if (!done) {
    return fail(
      'timeout',
      'workflow_running',
      `Workflow "${query.workflow}" is still running or paused (run ${run.id}); run it async to not wait`,
      details,
    )
  }
  const response = done.response as { status: number; body: unknown } | null
  // A workflow answering an error status (a Response block with 4xx or 5xx): the query fails, with its body.
  if (response && response.status >= 400) {
    return fail('http', 'error_status', `Workflow "${query.workflow}" answered ${response.status}`, {
      ...details,
      status: response.status,
      body: response.body,
    })
  }
  if (response) {
    return {
      ok: true,
      data: response.body ?? null,
      metadata: { ...details, status: done.status, responseStatus: response.status },
      durationMs: durationMs(),
    }
  }
  if (done.status === 'succeeded') {
    return { ok: true, data: null, metadata: { ...details, status: done.status }, durationMs: durationMs() }
  }
  const error = done.error as { message?: string } | null
  return fail(
    'query',
    done.status === 'cancelled' ? 'workflow_cancelled' : 'workflow_failed',
    `Workflow "${query.workflow}" ${done.status === 'cancelled' ? 'was cancelled' : `failed: ${error?.message ?? 'unknown error'}`}`,
    details,
  )
}
