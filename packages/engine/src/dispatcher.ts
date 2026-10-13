import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { PoolManager } from '@ow/connectors'
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
import type postgres from 'postgres'
import { LeaseLostError } from './errors'
import { executeRun } from './orchestrator'
import { PgRunStore } from './pg-store'
import {
  type Claim,
  claimRuns,
  ensureDeadline,
  finishRun,
  loadCheckpoints,
  RUNS_QUEUED_CHANNEL,
  reapExpiredLeases,
  releaseRun,
  renewLease,
} from './queue'
import type { ResourceProvider, RunInput } from './types'

/** Run-specific values the engine can't know: config vars (secret ones decrypted) and what to scrub. */
export interface RunContextProvider {
  load(run: WorkflowRun): Promise<{ configVars: Record<string, unknown>; secrets: string[] }>
}

export interface DispatcherLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface DispatcherOptions {
  db: Db
  /** The postgres.js client behind `db`, for LISTEN. Without it the worker only polls. */
  listener?: postgres.Sql
  workerId?: string
  /** Runs this worker executes at once. Default 4. */
  concurrency?: number
  /** Default 30s; renewed every third of it. */
  leaseMs?: number
  /** Fallback poll when no NOTIFY arrives. Default 5s. */
  pollIntervalMs?: number
  /** How often to look for expired leases. Default 5s. */
  reapIntervalMs?: number
  /** Recoveries before a run whose worker keeps dying fails. Default 3. */
  maxRecoveries?: number
  pool: PoolManager
  resources: ResourceProvider
  context?: RunContextProvider
  /** One sandbox per run lease. Default: a fresh `IvmRuntime`. */
  createSandbox?: () => CodeRuntime
  log?: DispatcherLogger
  /** Test hook: stop renewing leases, as a hung worker would. */
  renewLeases?: boolean
}

const noLog: DispatcherLogger = { info() {}, warn() {}, error() {} }

/**
 * A worker's claim loop. Claims due runs up to its concurrency, renews their leases while they execute, wakes on
 * NOTIFY (polling as a fallback), and periodically recovers runs whose worker died. `stop()` hands in-flight runs
 * back to the queue.
 */
export class Dispatcher {
  readonly workerId: string
  private readonly opts: Required<
    Pick<DispatcherOptions, 'concurrency' | 'leaseMs' | 'pollIntervalMs' | 'reapIntervalMs' | 'maxRecoveries'>
  > &
    DispatcherOptions
  private readonly log: DispatcherLogger
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private running = false
  private stopping = false
  private wakeUp: (() => void) | undefined
  private woken = false
  private loopDone: Promise<void> = Promise.resolve()
  private reapTimer: NodeJS.Timeout | undefined
  private unlisten: (() => Promise<void>) | undefined

  constructor(opts: DispatcherOptions) {
    this.opts = {
      concurrency: 4,
      leaseMs: 30_000,
      pollIntervalMs: 5_000,
      reapIntervalMs: 5_000,
      maxRecoveries: 3,
      ...opts,
    }
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.log = opts.log ?? noLog
  }

  /** Runs in flight on this worker. */
  get activeRuns(): string[] {
    return [...this.active.keys()]
  }

  async start() {
    if (this.running) return
    this.running = true
    if (this.opts.listener) {
      const { unlisten } = await this.opts.listener.listen(RUNS_QUEUED_CHANNEL, () => this.wake())
      this.unlisten = unlisten
    }
    this.reapTimer = setInterval(() => void this.reap(), this.opts.reapIntervalMs)
    this.loopDone = this.loop()
    this.log.info({ workerId: this.workerId }, 'dispatcher started')
  }

  /** Stops claiming new runs; runs in flight carry on to the end. */
  async drain() {
    this.running = false
    this.wake()
    await this.loopDone
  }

  /** Stops claiming, interrupts in-flight runs and hands them back to the queue. */
  async stop() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.reapTimer)
    await this.drain()
    await this.unlisten?.().catch(() => {})
    for (const { controller } of this.active.values()) controller.abort(new Error('worker shutting down'))
    await Promise.all([...this.active.values()].map((a) => a.done))
    this.log.info({ workerId: this.workerId }, 'dispatcher stopped')
  }

  /** One recovery pass (also runs on a timer). */
  async reap() {
    try {
      const { requeued, failed } = await reapExpiredLeases(this.opts.db, this.opts.maxRecoveries)
      if (requeued.length || failed.length)
        this.log.warn({ requeued, failed }, 'recovered runs with expired leases')
    } catch (err) {
      this.log.error({ err }, 'lease recovery failed')
    }
  }

  private wake() {
    this.woken = true
    this.wakeUp?.()
  }

  private async loop() {
    while (this.running) {
      const free = this.opts.concurrency - this.active.size
      if (free > 0) {
        try {
          const claims = await claimRuns(this.opts.db, this.workerId, free, this.opts.leaseMs)
          for (const claim of claims) this.process(claim)
          if (claims.length === free) continue
        } catch (err) {
          this.log.error({ err }, 'claiming runs failed')
        }
      }
      await this.sleepUntilWoken(this.opts.pollIntervalMs)
    }
  }

  private sleepUntilWoken(ms: number): Promise<void> {
    if (this.woken || !this.running) {
      this.woken = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakeUp = undefined
        this.woken = false
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakeUp = done
    })
  }

  private process(claim: Claim) {
    const controller = new AbortController()
    const renew =
      this.opts.renewLeases === false
        ? undefined
        : setInterval(async () => {
            try {
              if (!(await renewLease(this.opts.db, claim, this.opts.leaseMs))) {
                controller.abort(new LeaseLostError(`Lost the lease on run ${claim.runId}`))
              }
            } catch (err) {
              this.log.warn({ err, runId: claim.runId }, 'lease renewal failed')
            }
          }, this.opts.leaseMs / 3)
    const done = this.execute(claim, controller.signal)
      .catch((err) => this.log.error({ err, runId: claim.runId }, 'run execution failed'))
      .finally(() => {
        clearInterval(renew)
        this.active.delete(claim.runId)
        this.wake()
      })
    this.active.set(claim.runId, { controller, done })
  }

  private async execute(claim: Claim, signal: AbortSignal) {
    const { db } = this.opts
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, claim.runId))
    if (!run) return
    const definition = await loadDefinition(db, run)
    const [env] = await db.select().from(environments).where(eq(environments.id, run.environmentId))
    const context = (await this.opts.context?.load(run)) ?? { configVars: {}, secrets: [] }
    const deadline = await ensureDeadline(db, claim, definition.settings?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    if (!deadline) return // Lost the lease already.
    const checkpoints = await loadCheckpoints(db, run.id)

    const store = new PgRunStore(db, claim)
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
        services: { sandbox, pool: this.opts.pool, resources: this.opts.resources },
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
      if (this.stopping) await releaseRun(db, claim).catch(() => {})
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
