import type { CodeFetcher, PoolManager } from '@ow/connectors'
import {
  type Db,
  environments,
  type WorkflowRun,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
} from '@ow/db'
import { DEFAULT_RUN_TIMEOUT_MS, type WorkflowDefinition } from '@ow/definition'
import { type CodeRuntime, IvmRuntime } from '@ow/sandbox'
import { eq } from 'drizzle-orm'
import { LeaseLostError } from './errors'
import { executeRun } from './orchestrator'
import { PgRunStore } from './pg-store'
import { type Claim, ensureDeadline, finishRun, loadCheckpoints, releaseRun, renewLease } from './queue'
import type { ResourceProvider, RunInput, RunResponse } from './types'

/** Run-specific values the engine can't know: config vars (secret ones decrypted) and what to scrub. */
export interface RunContextProvider {
  load(run: WorkflowRun): Promise<{ configVars: Record<string, unknown>; secrets: string[] }>
}

export interface DispatcherLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export const noLog: DispatcherLogger = { info() {}, warn() {}, error() {} }

export interface RunExecutorOptions {
  db: Db
  pool: PoolManager
  resources: ResourceProvider
  context?: RunContextProvider
  /** Backs `fetch` in code; shared by every run of the process. Without it, code can't fetch. */
  fetcher?: Pick<CodeFetcher, 'fetch'>
  /** One sandbox per run lease. Default: a fresh `IvmRuntime`. */
  createSandbox?: () => CodeRuntime
  /** Default 30s; renewed every third of it. */
  leaseMs?: number
  log?: DispatcherLogger
  /** Test hook: stop renewing leases, as a hung worker would. */
  renewLeases?: boolean
}

/**
 * Executes runs this process has claimed: loads the run and what it executes, renews the lease while it runs,
 * executes it, and records the outcome. Shared by the worker's `Dispatcher` and the API's inline runner (sync
 * webhooks), so a run behaves the same wherever it executes.
 */
export class RunExecutor {
  readonly leaseMs: number
  readonly db: Db
  private readonly log: DispatcherLogger

  constructor(private readonly opts: RunExecutorOptions) {
    this.leaseMs = opts.leaseMs ?? 30_000
    this.db = opts.db
    this.log = opts.log ?? noLog
  }

  /**
   * Executes a claimed run until it finishes or is interrupted. `controller` aborts it (shutdown); losing the lease
   * aborts it too. `handBack()` says whether an interrupted run goes straight back to the queue (graceful shutdown)
   * or is left for the reaper (lease lost, database trouble), which counts a recovery. Never throws.
   */
  async execute(
    claim: Claim,
    controller: AbortController,
    opts: { handBack: () => boolean; onResponse?: (response: RunResponse) => void },
  ): Promise<void> {
    const renew =
      this.opts.renewLeases === false
        ? undefined
        : setInterval(async () => {
            try {
              if (!(await renewLease(this.opts.db, claim, this.leaseMs))) {
                controller.abort(new LeaseLostError(`Lost the lease on run ${claim.runId}`))
              }
            } catch (err) {
              this.log.warn({ err, runId: claim.runId }, 'lease renewal failed')
            }
          }, this.leaseMs / 3)
    try {
      await this.run(claim, controller.signal, opts)
    } catch (err) {
      this.log.error({ err, runId: claim.runId }, 'run execution failed')
    } finally {
      clearInterval(renew)
    }
  }

  private async run(
    claim: Claim,
    signal: AbortSignal,
    opts: { handBack: () => boolean; onResponse?: (response: RunResponse) => void },
  ) {
    const { db } = this.opts
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, claim.runId))
    if (!run) return
    const definition = await loadDefinition(db, run)
    const [env] = await db.select().from(environments).where(eq(environments.id, run.environmentId))
    const context = (await this.opts.context?.load(run)) ?? { configVars: {}, secrets: [] }
    const deadline = await ensureDeadline(db, claim, definition.settings?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    if (!deadline) return // Lost the lease already.
    const checkpoints = await loadCheckpoints(db, run.id)

    const store = new PgRunStore(db, claim, { onResponse: opts.onResponse })
    const sandbox = this.opts.createSandbox?.() ?? new IvmRuntime()
    let outcome: Awaited<ReturnType<typeof executeRun>>
    try {
      outcome = await executeRun({
        runId: run.id,
        definition,
        environmentId: run.environmentId,
        input: run.input as RunInput,
        globals: {
          configVars: context.configVars,
          workflowContext: {
            runId: run.id,
            workflowId: run.workflowId,
            environment: env?.slug,
            triggerType: run.triggerType,
          },
          idempotencyKey: run.idempotencyKey ?? run.id,
        },
        services: {
          sandbox,
          pool: this.opts.pool,
          resources: this.opts.resources,
          fetcher: this.opts.fetcher,
        },
        store,
        checkpoints,
        only: run.targetBlocks ?? undefined,
        responded: run.response !== null,
        signal,
        deadline,
        secrets: context.secrets,
      })
    } finally {
      sandbox.dispose()
      await store.flush()
    }

    if (outcome.status === 'interrupted') {
      // On shutdown, hand the run straight back. Otherwise (lease lost, database trouble) leave it: if we
      // still hold it, the lease expires and the reaper counts a recovery, so a run that keeps breaking fails.
      if (opts.handBack()) await releaseRun(db, claim).catch(() => {})
      this.log.warn({ runId: run.id, error: outcome.error }, 'run interrupted')
      return
    }
    const finished = await finishRun(db, claim, { status: outcome.status, error: outcome.error })
    if (!finished) this.log.warn({ runId: run.id }, 'lost the lease before finishing the run')
  }
}

async function loadDefinition(db: Db, run: WorkflowRun): Promise<WorkflowDefinition> {
  if (run.releaseId) {
    const [release] = await db.select().from(workflowReleases).where(eq(workflowReleases.id, run.releaseId))
    return release!.definition
  }
  const [snapshot] = await db
    .select()
    .from(workflowDraftSnapshots)
    .where(eq(workflowDraftSnapshots.id, run.draftSnapshotId!))
  return snapshot!.definition
}
