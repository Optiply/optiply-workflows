import {
  type BlockStatus,
  blockRunPayloads,
  blockRuns,
  type Db,
  type LogLevel,
  runLogs,
  workflowRuns,
} from '@ow/db'
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { LeaseLostError } from './errors'
import { type Claim, notifyRunEvent } from './queue'
import type { BlockResult, RunResponse, RunStore, WaitState } from './types'

/** A committed result is never overwritten, not even by a later lease. */
const FINAL: BlockStatus[] = ['succeeded', 'errored', 'failed', 'skipped', 'cancelled']

const LOG_FLUSH_MS = 250
const LOG_BATCH = 200

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type LogEntry = { blockKey: string | null; level: LogLevel; message: string }

/**
 * A run's progress in Postgres, fenced by the lease's epoch. Every write runs in a transaction that first
 * share-locks the run row and checks the epoch is still ours and the run still `running`; a claim, release or
 * reaper update needs that row exclusively, so it waits for in-flight commits and every later write sees the
 * new epoch and throws `LeaseLostError`.
 */
export class PgRunStore implements RunStore {
  private logs: LogEntry[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private flushing: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: Db,
    private readonly claim: Claim,
    private readonly hooks: { onResponse?: (response: RunResponse) => void } = {},
  ) {}

  async blockStarted(key: string, attempt: number, startedAt: Date) {
    await this.fenced(async (tx) => {
      const written = await tx
        .insert(blockRuns)
        .values({
          runId: this.claim.runId,
          blockKey: key,
          status: 'running',
          attempt,
          epoch: this.claim.epoch,
          startedAt,
        })
        .onConflictDoUpdate({
          target: [blockRuns.runId, blockRuns.blockKey],
          set: {
            status: 'running',
            attempt,
            epoch: this.claim.epoch,
            startedAt,
            port: null,
            error: null,
            metadata: null,
            finishedAt: null,
            updatedAt: new Date(),
          },
          setWhere: notInArray(blockRuns.status, FINAL),
        })
        .returning({ id: blockRuns.id })
      if (written.length) {
        await notifyRunEvent(tx, {
          runId: this.claim.runId,
          type: 'block',
          key,
          status: 'running',
          attempt,
          port: null,
        })
      }
    })
  }

  async blockWaiting(key: string, attempt: number, state: WaitState) {
    await this.fenced(async (tx) => {
      const values = {
        status: 'waiting' as const,
        attempt,
        epoch: this.claim.epoch,
        metadata: {
          until: state.until.toISOString(),
          ...(state.childRunId && { childRunId: state.childRunId }),
          ...(state.since && { since: state.since.toISOString() }),
          ...(state.taskId && { taskId: state.taskId }),
        },
      }
      const written = await tx
        .insert(blockRuns)
        .values({ runId: this.claim.runId, blockKey: key, ...values, startedAt: new Date() })
        .onConflictDoUpdate({
          target: [blockRuns.runId, blockRuns.blockKey],
          set: { ...values, updatedAt: new Date() },
          setWhere: notInArray(blockRuns.status, FINAL),
        })
        .returning({ id: blockRuns.id })
      if (written.length) {
        await notifyRunEvent(tx, {
          runId: this.claim.runId,
          type: 'block',
          key,
          status: 'waiting',
          attempt,
          port: null,
        })
      }
    })
  }

  async blockFinished(result: BlockResult, extra?: { response?: RunResponse }) {
    const responded = await this.fenced(async (tx) => {
      const values = {
        status: result.status,
        attempt: result.attempt,
        epoch: this.claim.epoch,
        port: result.port,
        error: result.error as Record<string, unknown> | null,
        metadata: result.metadata,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      }
      const [row] = await tx
        .insert(blockRuns)
        .values({ runId: this.claim.runId, blockKey: result.key, ...values })
        .onConflictDoUpdate({
          target: [blockRuns.runId, blockRuns.blockKey],
          set: { ...values, updatedAt: new Date() },
          setWhere: notInArray(blockRuns.status, FINAL),
        })
        .returning({ id: blockRuns.id })
      if (!row) return false // Already committed.
      await notifyRunEvent(tx, {
        runId: this.claim.runId,
        type: 'block',
        key: result.key,
        status: result.status,
        attempt: result.attempt,
        port: result.port,
      })
      if (result.status === 'succeeded') {
        await tx
          .insert(blockRunPayloads)
          .values({ blockRunId: row.id, data: result.data, sizeBytes: result.sizeBytes })
          .onConflictDoUpdate({
            target: blockRunPayloads.blockRunId,
            set: { data: result.data, sizeBytes: result.sizeBytes },
          })
      }
      if (!extra?.response) return false
      const recorded = await tx
        .update(workflowRuns)
        .set({ response: extra.response as unknown as Record<string, unknown> })
        .where(and(eq(workflowRuns.id, this.claim.runId), isNull(workflowRuns.response)))
        .returning({ id: workflowRuns.id })
      if (!recorded.length) return false
      // A sync webhook waiting on another process replies as soon as this commits.
      await notifyRunEvent(tx, { runId: this.claim.runId, type: 'response' })
      return true
    })
    if (responded && extra?.response) this.hooks.onResponse?.(extra.response)
  }

  async iterationsFinished(loop: string, results: readonly BlockResult[]) {
    if (!results.length) return
    await this.fenced(async (tx) => {
      const rows = await tx
        .insert(blockRuns)
        .values(
          results.map((r) => ({
            runId: this.claim.runId,
            blockKey: r.key,
            status: r.status,
            attempt: r.attempt,
            epoch: this.claim.epoch,
            port: r.port,
            error: r.error as Record<string, unknown> | null,
            metadata: r.metadata,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
          })),
        )
        // An iteration an earlier lease committed stays as it was.
        .onConflictDoNothing({ target: [blockRuns.runId, blockRuns.blockKey] })
        .returning({ id: blockRuns.id, key: blockRuns.blockKey })
      const byKey = new Map(results.map((r) => [r.key, r]))
      const payloads = rows.flatMap((row) => {
        const r = byKey.get(row.key)!
        return r.status === 'succeeded' ? [{ blockRunId: row.id, data: r.data, sizeBytes: r.sizeBytes }] : []
      })
      if (payloads.length) await tx.insert(blockRunPayloads).values(payloads)
      if (rows.length) {
        await notifyRunEvent(tx, {
          runId: this.claim.runId,
          type: 'iterations',
          key: loop,
          count: rows.length,
        })
      }
    })
  }

  log(entry: LogEntry) {
    this.logs.push(entry)
    if (this.logs.length >= LOG_BATCH) void this.flush()
    else this.flushTimer ??= setTimeout(() => void this.flush(), LOG_FLUSH_MS)
  }

  /** Writes buffered logs. Logs are best effort: a lost lease or a database error drops them. */
  flush(): Promise<void> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const batch = this.logs.splice(0)
    if (batch.length) {
      this.flushing = this.flushing.then(() =>
        this.fenced(async (tx) => {
          await tx.insert(runLogs).values(batch.map((l) => ({ ...l, runId: this.claim.runId })))
        }).catch(() => {}),
      )
    }
    return this.flushing
  }

  private async fenced<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const held = await tx.execute(sql`
        select 1 from workflow_runs
        where id = ${this.claim.runId} and epoch = ${this.claim.epoch} and status = 'running'
        for share`)
      if (!held.length) {
        throw new LeaseLostError(`Lost the lease on run ${this.claim.runId} (epoch ${this.claim.epoch})`)
      }
      return fn(tx)
    })
  }
}
