import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { workflowRuns } from '@ow/db'
import type postgres from 'postgres'
import { listenForCancels } from './dispatcher'
import { RunExecutor, type RunExecutorOptions } from './executor'
import { type StartedRun, startRun } from './queue'
import type { RunResponse } from './types'

export interface InlineRunnerOptions extends RunExecutorOptions {
  /** Runs executing in this process at once; more are queued for the workers. Default 8; 0 queues everything. */
  concurrency?: number
  workerId?: string
  /** The postgres.js client behind `db`, to hear about cancelled runs at once (lease renewals notice them too). */
  listener?: postgres.Sql
}

/**
 * Executes runs in the process that starts them: the API runs sync webhooks itself, so a reply doesn't wait for a
 * worker to wake up and claim the run. The run is claimed when it's inserted and executes exactly as on a worker
 * (`RunExecutor`, with a lease): if this process dies, the lease expires and a worker resumes it. When every slot
 * is busy, or the workflow is at its concurrency limit, the run is queued for the workers instead.
 */
export class InlineRunner {
  readonly workerId: string
  private readonly executor: RunExecutor
  private readonly concurrency: number
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  /** Slots taken by starts still inserting their run. */
  private reserved = 0
  private stopping = false
  private readonly unlistenCancel: Promise<(() => Promise<void>) | undefined>

  constructor(opts: InlineRunnerOptions) {
    this.executor = new RunExecutor(opts)
    this.concurrency = opts.concurrency ?? 8
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}-inline-${randomUUID().slice(0, 8)}`
    this.unlistenCancel = opts.listener
      ? listenForCancels(opts.listener, this.active).catch((err) => {
          opts.log?.error({ err }, 'listening for cancelled runs failed')
          return undefined
        })
      : Promise.resolve(undefined)
  }

  /** Runs executing in this process. */
  get activeRuns(): string[] {
    return [...this.active.keys()]
  }

  /**
   * Starts a run, here if a slot is free. `onResponse` fires when this process records the run's reply, `onDone`
   * when it stops executing the run. Neither fires for a run that went to the workers or was replayed.
   */
  async start(
    values: typeof workflowRuns.$inferInsert,
    hooks: { onResponse?: (response: RunResponse) => void; onDone?: () => void } = {},
  ): Promise<StartedRun> {
    const here = !this.stopping && this.active.size + this.reserved < this.concurrency
    if (here) this.reserved++
    let started: StartedRun
    try {
      started = await startRun(
        this.executor.db,
        values,
        here ? { claimAs: { workerId: this.workerId, leaseMs: this.executor.leaseMs } } : {},
      )
    } finally {
      if (here) this.reserved--
    }
    const { claim } = started
    if (claim) {
      const controller = new AbortController()
      const done = this.executor
        .execute(claim, controller, { handBack: () => this.stopping, onResponse: hooks.onResponse })
        .finally(() => {
          this.active.delete(claim.runId)
          hooks.onDone?.()
        })
      this.active.set(claim.runId, { controller, done })
    }
    return started
  }

  /** Stops starting runs here, interrupts the ones executing and hands them back to the queue. */
  async stop() {
    this.stopping = true
    await (await this.unlistenCancel)?.().catch(() => {})
    for (const { controller } of this.active.values()) controller.abort(new Error('API shutting down'))
    await Promise.all([...this.active.values()].map((a) => a.done))
  }
}
