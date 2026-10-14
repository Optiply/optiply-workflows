import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type postgres from 'postgres'
import { type DispatcherLogger, noLog, RunExecutor, type RunExecutorOptions } from './executor'
import { type Claim, claimRuns, RUNS_QUEUED_CHANNEL, reapExpiredLeases } from './queue'

export type { DispatcherLogger, RunContextProvider } from './executor'

export interface DispatcherOptions extends RunExecutorOptions {
  /** The postgres.js client behind `db`, for LISTEN. Without it the worker only polls. */
  listener?: postgres.Sql
  workerId?: string
  /** Runs this worker executes at once. Default 4. */
  concurrency?: number
  /** Fallback poll when no NOTIFY arrives. Default 5s. */
  pollIntervalMs?: number
  /** How often to look for expired leases. Default 5s. */
  reapIntervalMs?: number
  /** Recoveries before a run whose worker keeps dying fails. Default 3. */
  maxRecoveries?: number
}

/**
 * A worker's claim loop. Claims due runs up to its concurrency, renews their leases while they execute, wakes on
 * NOTIFY (polling as a fallback), and periodically recovers runs whose worker died. `stop()` hands in-flight runs
 * back to the queue.
 */
export class Dispatcher {
  readonly workerId: string
  private readonly opts: Required<
    Pick<DispatcherOptions, 'concurrency' | 'pollIntervalMs' | 'reapIntervalMs' | 'maxRecoveries'>
  > &
    DispatcherOptions
  private readonly log: DispatcherLogger
  private readonly executor: RunExecutor
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
      pollIntervalMs: 5_000,
      reapIntervalMs: 5_000,
      maxRecoveries: 3,
      ...opts,
    }
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.log = opts.log ?? noLog
    this.executor = new RunExecutor(opts)
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
          const claims = await claimRuns(this.opts.db, this.workerId, free, this.executor.leaseMs)
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
    const done = this.executor.execute(claim, controller, { handBack: () => this.stopping }).finally(() => {
      this.active.delete(claim.runId)
      this.wake()
    })
    this.active.set(claim.runId, { controller, done })
  }
}
