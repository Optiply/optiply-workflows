import type { CodeFetcher, PoolManager } from '@ow/connectors'
import {
  type Db,
  environments,
  type WorkflowRun,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
} from '@ow/db'
import { DEFAULT_RUN_TIMEOUT_MS, pythonFields, type WorkflowDefinition } from '@ow/definition'
import { type CodeRuntime, IvmRuntime, type PythonRunner } from '@ow/sandbox'
import { eq } from 'drizzle-orm'
import { PgChildRuns } from './children'
import { BlockFailure, LeaseLostError, RunCancelledError } from './errors'
import { executeRun } from './orchestrator'
import { PgRunStore } from './pg-store'
import {
  type Claim,
  ensureDeadline,
  finishRun,
  loadCheckpoints,
  loadWaits,
  releaseRun,
  renewLease,
  suspendRun,
} from './queue'
import { PgUserTasks } from './tasks'
import type { BlockResult, LibraryQueries, ResourceProvider, RunInput, RunResponse } from './types'

/** Run-specific values the engine can't know: config vars (secret ones decrypted) and what to scrub. */
export interface RunContextProvider {
  load(run: WorkflowRun): Promise<{ configVars: Record<string, unknown>; secrets: string[] }>
}

/** Where a run's Python packages come from (M23): the server builds or installs them (docs/architecture.md §2.26). */
export interface PythonEnvProvider {
  /**
   * The builder's env id for this run's packages: a release's lock, or the draft's requirements. Throws a
   * `BlockFailure` (`python_packages`, the build's log in its details) when they can't be installed.
   */
  envFor(run: WorkflowRun, definition: WorkflowDefinition): Promise<string>
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
  /** Runs Python code blocks; shared by every run of the process. Without it they fail (`python_unavailable`). */
  python?: PythonRunner
  /**
   * Python packages (M23): the env for a run whose definition declares some. Without it such runs' Python blocks fail
   * (`python_packages_unavailable`).
   */
  pythonEnvs?: PythonEnvProvider
  /** Library queries for Library query blocks and runners (M21). Without it they fail (`library`). */
  library?: LibraryQueries
  /** Default 30s; renewed every third of it. */
  leaseMs?: number
  log?: DispatcherLogger
  /** Test hook: stop renewing leases, as a hung worker would. */
  renewLeases?: boolean
  /** Told about runs and blocks as they finish here, e.g. for metrics. */
  observer?: RunObserver
}

/** What the executor reports as runs and blocks finish in this process. Must not throw. */
export interface RunObserver {
  /** A run ended here (final status) or paused (`waiting`). Duration: since the run first started. */
  runSettled?(e: {
    status: 'succeeded' | 'failed' | 'cancelled' | 'waiting'
    triggerType: string
    durationMs: number
  }): void
  /** A block's result this lease committed (not results reused from earlier leases or runs). */
  blockFinished?(e: { type: string; status: string; durationMs: number }): void
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

  private readonly children: PgChildRuns
  private readonly tasks: PgUserTasks

  constructor(private readonly opts: RunExecutorOptions) {
    this.children = new PgChildRuns(opts.db)
    this.tasks = new PgUserTasks(opts.db)
    this.leaseMs = opts.leaseMs ?? 30_000
    this.db = opts.db
    this.log = opts.log ?? noLog
  }

  /**
   * Executes a claimed run until it finishes, pauses or is interrupted. `controller` aborts it (shutdown, or a
   * `RunCancelledError` to cancel it); losing the lease aborts it too. `handBack()` says whether an interrupted run goes straight back to the queue (graceful shutdown)
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
              const lease = await renewLease(this.opts.db, claim, this.leaseMs)
              if (lease === 'lost')
                controller.abort(new LeaseLostError(`Lost the lease on run ${claim.runId}`))
              // Someone cancelled the run and this process missed the NOTIFY.
              if (lease === 'cancel') controller.abort(new RunCancelledError())
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
    if (run.cancelRequestedAt) {
      // Cancelled while its previous worker held it.
      await finishRun(db, claim, {
        status: 'cancelled',
        error: { code: 'cancelled', message: 'The run was cancelled' },
      })
      return
    }
    const definition = await loadDefinition(db, run)
    const [env] = await db.select().from(environments).where(eq(environments.id, run.environmentId))
    const context = (await this.opts.context?.load(run)) ?? { configVars: {}, secrets: [] }
    const deadline = await ensureDeadline(db, claim, definition.settings?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    if (!deadline) return // Lost the lease already.
    const checkpoints = await loadCheckpoints(db, run.id)
    const waits = await loadWaits(db, run.id)

    const store = new PgRunStore(db, claim, { onResponse: opts.onResponse })
    const sandbox = this.opts.createSandbox?.() ?? new IvmRuntime()
    let outcome: Awaited<ReturnType<typeof executeRun>>
    try {
      outcome = await executeRun({
        runId: run.id,
        definition,
        environmentId: run.environmentId,
        // Only a draft run has a person behind it (whoever ran it from the editor).
        actingUserId: run.draftSnapshotId ? run.createdBy : null,
        currentUserId: run.createdBy,
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
          children: this.children,
          tasks: this.tasks,
          python: this.opts.python,
          pythonEnv: this.pythonEnvFor(run, definition),
          library: this.opts.library,
        },
        store,
        checkpoints,
        waits,
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

    this.observe(run, definition, checkpoints, outcome)

    if (outcome.status === 'interrupted') {
      // On shutdown, hand the run straight back. Otherwise (lease lost, database trouble) leave it: if we
      // still hold it, the lease expires and the reaper counts a recovery, so a run that keeps breaking fails.
      if (opts.handBack()) await releaseRun(db, claim).catch(() => {})
      this.log.warn({ runId: run.id, error: outcome.error }, 'run interrupted')
      return
    }
    if (outcome.status === 'waiting') {
      if (!(await suspendRun(db, claim, outcome.resumeAt!))) {
        this.log.warn({ runId: run.id }, 'lost the lease before pausing the run')
      }
      return
    }
    const finished = await finishRun(db, claim, { status: outcome.status, error: outcome.error })
    if (!finished) this.log.warn({ runId: run.id }, 'lost the lease before finishing the run')
  }

  /**
   * The run's Python packages (M23); undefined when its definition declares none or has no Python. Asked for as the
   * run starts, so a first install overlaps the blocks before its Python ones; they wait for it.
   */
  private pythonEnvFor(
    run: WorkflowRun,
    definition: WorkflowDefinition,
  ): (() => Promise<string>) | undefined {
    if (!definition.settings?.python?.requirements.length || !pythonFields(definition).length)
      return undefined
    const provider = this.opts.pythonEnvs
    if (!provider) {
      return () =>
        Promise.reject(
          new BlockFailure(
            'python_packages_unavailable',
            "This workflow's Python packages can't be installed on this instance (PYTHON_BUILDER_URL)",
          ),
        )
    }
    const env = shared(() => provider.envFor(run, definition))
    env.prefetch() // the Python block that waits for it reports a failure
    return env
  }

  private observe(
    run: WorkflowRun,
    definition: WorkflowDefinition,
    checkpoints: readonly BlockResult[],
    outcome: Awaited<ReturnType<typeof executeRun>>,
  ) {
    const observer = this.opts.observer
    if (!observer) return
    try {
      const earlier = new Set(checkpoints.map((c) => c.key))
      const types = new Map(definition.blocks.map((b) => [b.name, b.type]))
      for (const result of outcome.results.values()) {
        if (earlier.has(result.key) || result.metadata?.cachedFrom) continue
        observer.blockFinished?.({
          type: types.get(result.key) ?? 'unknown',
          status: result.status,
          durationMs: result.startedAt ? result.finishedAt.getTime() - result.startedAt.getTime() : 0,
        })
      }
      if (outcome.status !== 'interrupted') {
        observer.runSettled?.({
          status: outcome.status,
          triggerType: run.triggerType,
          durationMs: Date.now() - (run.startedAt ?? run.createdAt).getTime(),
        })
      }
    } catch (err) {
      this.log.warn({ err }, 'run observer failed')
    }
  }
}

/**
 * Asks once for many callers (a loop's iterations share it). A failure is kept until a caller has had it, then the
 * next call asks again (a retried block: the index may have been down). `prefetch` asks ahead without being a
 * caller, so a failure it meets goes to the first block that waits, not asked for twice — unless it's older than
 * `freshMs` by then (the block came much later: ask again).
 */
export function shared<T>(
  get: () => Promise<T>,
  freshMs = 30_000,
): (() => Promise<T>) & { prefetch(): void } {
  let pending: Promise<T> | undefined
  let seen = false // `pending` failed and a caller has had that
  let failedAt: number | undefined // when `pending` failed
  const start = () => {
    const current = get()
    pending = current
    seen = false
    failedAt = undefined
    current.catch(() => {
      if (pending === current) failedAt = Date.now()
    })
    return current
  }
  const call = () => {
    const stale = failedAt !== undefined && Date.now() - failedAt > freshMs
    const current = !pending || seen || stale ? start() : pending
    return current.catch((err: unknown) => {
      if (pending === current) seen = true
      throw err
    })
  }
  return Object.assign(call, {
    prefetch: () => {
      if (!pending) start()
    },
  })
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
