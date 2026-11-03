import { type Db, type QueueTriggerState, queueDeliveries, workflowRuns, workflowTriggers } from '@ow/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { startRun } from './queue'
import { createAdapter } from './queue-adapters'
import type { ResourceProvider } from './types'

/**
 * Queue triggers (Pub/Sub M19, SQS and Kafka M26; architecture §2.22, §2.29), in each worker: one worker at a time
 * holds a trigger's lease (on its `workflow_triggers` row) and receives its messages through the kind's adapter, up to
 * `maxInFlight` whose runs are under way. Each delivery starts a run (idempotency key `<kind>:<trigger>:<message>:<n>`);
 * `queue_deliveries` remembers what each message's latest run was, so a redelivery of one that succeeded is answered
 * without a run, and one whose run is still going is held again rather than run twice.
 */
export interface QueueConsumerOptions {
  db: Db
  resources: ResourceProvider
  /** This process, as lease holder. */
  workerId: string
  log?: QueueLogger
  /** How often leases are taken and renewed: 5 s. */
  intervalMs?: number
  /** How long a lease lasts without being renewed: 30 s. */
  leaseMs?: number
  /** The first wait after a failed pull, doubling up to 30 s: 1 s. */
  retryMs?: number
  /** How often held messages' runs are checked for their end: 1 s. */
  checkMs?: number
  /** How often held messages' deadlines (Pub/Sub) or visibility (SQS) are extended: 20 s. */
  extendEveryMs?: number
  /** The deadline or visibility set each time, in seconds: 60. */
  holdDeadlineSeconds?: number
  /** How long a minute of `maxHoldMinutes` is, for tests: 60 s. */
  holdMinuteMs?: number
  /** How long a second of Kafka's `retryBackoffSeconds` is, for tests: 1 s. */
  backoffSecondMs?: number
}

export const QUEUE_KINDS = ['pubsub', 'sqs', 'kafka', 'rabbitmq'] as const
export type QueueKind = (typeof QUEUE_KINDS)[number]

/** What a held message's end became, as counted in `ow_queue_messages_total{outcome}`. */
export type QueueOutcome =
  | 'acked'
  | 'nacked'
  | 'retried'
  | 'dead_lettered'
  | 'dropped'
  | 'duplicate'
  | 'released'
export const QUEUE_OUTCOMES: readonly QueueOutcome[] = [
  'acked',
  'nacked',
  'retried',
  'dead_lettered',
  'dropped',
  'duplicate',
  'released',
]

function emptyStats() {
  return {
    inFlight: 0,
    pullErrors: 0,
    ...(Object.fromEntries(QUEUE_OUTCOMES.map((o) => [o, 0])) as Record<QueueOutcome, number>),
  }
}

/** This process's queue triggers per kind, for metrics (`ow_queue_*`). */
export const queueStats: Record<QueueKind, ReturnType<typeof emptyStats>> = {
  pubsub: emptyStats(),
  sqs: emptyStats(),
  kafka: emptyStats(),
  rabbitmq: emptyStats(),
}

export interface QueueLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/** A projected queue trigger, as its lease returns it. */
export type QueueTriggerRow = {
  id: string
  workflow_id: string
  release_id: string
  environment_id: string
  kind: QueueKind
  name: string
  config: { resource: string; maxInFlight: number; maxHoldMinutes: number } & Record<string, unknown>
} & Record<string, unknown>

/** A message an adapter received. */
export interface QueueMessage {
  /** The message's id within the trigger: Pub/Sub's or SQS's message id, Kafka's `<topic>/<partition>/<offset>`. */
  id: string
  /** What answers this delivery: Pub/Sub's ack id, SQS's receipt handle (new on each delivery); Kafka's id. */
  handle: string
  /** The run's input: `startTrigger.data` and `startTrigger.message`; given the delivery's attempt where it says so. */
  input: RunInputOf | ((attempt: number) => RunInputOf)
}

type RunInputOf = { data: unknown; message: object }

/** A delivery whose run is under way: its message is held (not answered) until the run ends. */
export interface HeldMessage {
  id: string
  handle: string
  runId: string
  /** The delivery's number for this message: its runs so far, this one included. */
  attempt: number
  since: number
}

/**
 * What a kind does with its queue. The shared code decides when (a run ended, a redelivery, a stop); the adapter talks
 * to the queue. Calls take a signal stopped with the subscriber and after 15 s.
 */
export interface QueueAdapter {
  /** Up to `max` messages, waiting a while for some; throws when the queue can't be reached. */
  pull(max: number, signal: AbortSignal): Promise<QueueMessage[]>
  /** Keeps held messages from being handed out again while their runs last (Pub/Sub's deadline, SQS's visibility). */
  extend(held: Pick<HeldMessage, 'id' | 'handle'>[], signal: AbortSignal): Promise<void>
  /** Done with a message: its run succeeded, it was released past the hold, or it is a finished one come again. */
  ack(held: Pick<HeldMessage, 'id' | 'handle'>, signal: AbortSignal): Promise<void>
  /**
   * Its run failed or was cancelled (`error`: the run's). Pub/Sub and SQS hand it back to the queue (`nacked`); Kafka
   * retries it later (`retried`) or, after its attempts, dead-letters it (`dead_lettered`, `dropped`).
   */
  fail(
    held: HeldMessage,
    error: string | null,
    signal: AbortSignal,
  ): Promise<'nacked' | 'retried' | 'dead_lettered' | 'dropped'>
  /** Stopping: hands held messages back where the queue allows, and closes connections. Never throws. */
  close(held: HeldMessage[]): Promise<void>
  /** After a failed pull: the next call makes a new client, so settings fixed meanwhile are picked up. */
  reset(): void
  /**
   * A pulled message whose run couldn't start (the database went away). Pub/Sub and SQS hand it out again after its
   * deadline; Kafka, which has none, offers it again later itself.
   */
  undelivered?(message: QueueMessage): void
}

export interface AdapterContext {
  trigger: QueueTriggerRow
  resources: ResourceProvider
  opts: QueueConsumerOptions
  log: (level: 'info' | 'warn', obj: object, msg: string) => void
  /** Records a held message's final outcome reached later than its `fail` (Kafka's dead letter sent on a later try). */
  settled(held: HeldMessage, outcome: 'dead_lettered' | 'dropped'): Promise<void>
}

export class QueueConsumer {
  private readonly subscribers = new Map<string, Subscriber>()
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> = Promise.resolve()

  constructor(private readonly opts: QueueConsumerOptions) {}

  start(): void {
    void this.tick()
    this.timer ??= setInterval(() => void this.tick(), this.opts.intervalMs ?? 5_000)
  }

  /** Stops receiving and gives the leases up, so another worker takes the triggers at once. */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    await Promise.all([...this.subscribers.values()].map((s) => s.stop()))
    this.subscribers.clear()
    await this.opts.db.execute(sql`
      update workflow_triggers set lease_owner = null, lease_expires_at = null
      where kind in ('pubsub', 'sqs', 'kafka', 'rabbitmq') and lease_owner = ${this.opts.workerId}`)
  }

  /** Triggers this process receives for now, and the messages held for each. */
  get stats(): { triggers: number; inFlight: number } {
    let inFlight = 0
    for (const s of this.subscribers.values()) inFlight += s.held.size
    return { triggers: this.subscribers.size, inFlight }
  }

  /** Takes and renews leases, and starts or stops receiving to match. Never throws. */
  tick(): Promise<void> {
    this.ticking = this.ticking
      .then(() => this.leaseAndSync())
      .catch((err: unknown) => {
        this.opts.log?.warn({ err }, 'queue lease tick failed')
      })
    return this.ticking
  }

  private async leaseAndSync(): Promise<void> {
    const { db, workerId } = this.opts
    const leaseSecs = (this.opts.leaseMs ?? 30_000) / 1000
    // Ours (renewed), or free: nobody's, or a lease nobody renewed (its worker went away).
    const held = await db.execute<QueueTriggerRow>(sql`
      update workflow_triggers
      set lease_owner = ${workerId}, lease_expires_at = now() + make_interval(secs => ${leaseSecs})
      where kind in ('pubsub', 'sqs', 'kafka', 'rabbitmq') and enabled
        and (lease_owner = ${workerId} or lease_owner is null or lease_expires_at < now())
      returning id, workflow_id, release_id, environment_id, kind, name, config`)
    const ids = new Set(held.map((t) => t.id))
    for (const [id, subscriber] of this.subscribers) {
      // Lost (another worker took it after a missed renewal), disabled, or dropped by a release.
      if (!ids.has(id)) {
        this.subscribers.delete(id)
        await subscriber.stop()
        // Not receiving any more: give the lease up at once (if still ours), so the editor stops showing it.
        await db.execute(sql`
          update workflow_triggers set lease_owner = null, lease_expires_at = null
          where id = ${id} and lease_owner = ${workerId}`)
      }
    }
    // What each held trigger is doing, for the editor: written when it changed (one small update per such trigger).
    for (const subscriber of this.subscribers.values()) {
      const state = subscriber.state()
      const text = JSON.stringify(state)
      if (text === subscriber.writtenState) continue
      await db
        .update(workflowTriggers)
        .set({ state })
        .where(and(eq(workflowTriggers.id, subscriber.triggerId), eq(workflowTriggers.leaseOwner, workerId)))
      subscriber.writtenState = text
    }
    for (const trigger of held) {
      const current = this.subscribers.get(trigger.id)
      if (current && current.key === settingsKey(trigger)) {
        // A new release with the same trigger settings: its runs start the new release, nothing is restarted.
        current.trigger = trigger
        continue
      }
      if (current) await current.stop()
      if (!current)
        this.opts.log?.info(
          { triggerId: trigger.id, trigger: trigger.name },
          `${trigger.kind} trigger leased`,
        )
      const subscriber = new Subscriber(trigger, this.opts)
      this.subscribers.set(trigger.id, subscriber)
      subscriber.start()
    }
  }
}

/** Other settings or another environment start the trigger's receiver afresh (a new release alone doesn't). */
function settingsKey(t: QueueTriggerRow): string {
  return JSON.stringify([t.kind, t.environment_id, t.config])
}

/** One trigger's receiver: its adapter, its held messages, its errors. */
class Subscriber {
  readonly key: string
  readonly held = new Map<string, HeldMessage>()
  /** The state last written to the trigger's row. */
  writtenState: string | undefined
  private readonly abort = new AbortController()
  private readonly adapter: QueueAdapter
  private readonly stats: ReturnType<typeof emptyStats>
  private loop: Promise<void> = Promise.resolve()
  private holding: Promise<void> = Promise.resolve()
  private wakeUp: (() => void) | undefined
  private lastMessageAt: string | null = null
  private lastPullAt: string | null = null
  private lastError: string | null = null
  private lastErrorAt: string | null = null

  constructor(
    /** Swapped for the next release's row by the lease tick when only the release changed. */
    public trigger: QueueTriggerRow,
    private readonly opts: QueueConsumerOptions,
  ) {
    this.key = settingsKey(trigger)
    this.stats = queueStats[trigger.kind]
    this.adapter = createAdapter({
      trigger,
      resources: opts.resources,
      opts,
      log: (level, obj, msg) =>
        opts.log?.[level]({ triggerId: trigger.id, ...obj }, `${trigger.kind} ${msg}`),
      settled: async (held, outcome) => {
        this.stats[outcome]++
        await this.record(held, outcome)
      },
    })
  }

  get triggerId(): string {
    return this.trigger.id
  }

  private get kind(): QueueKind {
    return this.trigger.kind
  }

  state(): QueueTriggerState {
    return {
      inFlight: this.held.size,
      lastMessageAt: this.lastMessageAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    }
  }

  start(): void {
    this.loop = this.pullLoop()
    this.holding = this.holdLoop()
  }

  /**
   * Stops receiving and holding. Held messages are handed back where the queue allows (Pub/Sub's nack, SQS's
   * visibility), so the trigger's next worker gets them at once and holds them for their runs, which go on.
   */
  async stop(): Promise<void> {
    this.abort.abort()
    this.wake()
    await Promise.all([this.loop, this.holding])
    const left = [...this.held.values()]
    this.held.clear()
    this.stats.inFlight -= left.length
    await this.adapter.close(left).catch(() => {})
  }

  private wake(): void {
    this.wakeUp?.()
  }

  /** Waits `ms`, or less when woken (a held message finished) or stopped. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      const signal = this.abort.signal
      function done() {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.wakeUp = done
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private async pullLoop(): Promise<void> {
    const { config } = this.trigger
    const firstRetry = this.opts.retryMs ?? 1_000
    let retry = firstRetry
    while (!this.abort.signal.aborted) {
      const room = config.maxInFlight - this.held.size
      if (room <= 0) {
        await this.sleep(1_000)
        continue
      }
      let received: QueueMessage[]
      try {
        received = await this.adapter.pull(
          room,
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(90_000)]),
        )
        retry = firstRetry
        this.lastPullAt = new Date().toISOString()
        if (received.length) this.lastMessageAt = this.lastPullAt
      } catch (err) {
        if (this.abort.signal.aborted) return
        this.stats.pullErrors++
        this.lastError = describe(err)
        this.lastErrorAt = new Date().toISOString()
        this.opts.log?.warn(
          { triggerId: this.trigger.id, trigger: this.trigger.name, err: describe(err), retryInMs: retry },
          `${this.kind} pull failed`,
        )
        // Settings fixed meanwhile (a key, a role) are picked up on the next try.
        this.adapter.reset()
        await this.sleep(retry)
        retry = Math.min(retry * 2, 30_000)
        continue
      }
      for (const message of received) {
        if (this.abort.signal.aborted) return
        try {
          await this.deliver(message)
        } catch (err) {
          // The run couldn't start (the database went away): the queue hands it out again after its deadline.
          this.adapter.undelivered?.(message)
          this.opts.log?.warn(
            { triggerId: this.trigger.id, messageId: message.id, err: describe(err) },
            `${this.kind} delivery failed`,
          )
        }
      }
    }
  }

  /** Starts a run for a delivery, or recognises a redelivery: answered (it finished) or held (its run goes on). */
  private async deliver(message: QueueMessage): Promise<void> {
    const outcome = await startDelivery(this.opts.db, this.trigger, message)
    if (outcome.kind === 'done') {
      this.stats.duplicate++
      await this.adapter.ack(message, this.callSignal())
      this.opts.log?.info(
        { triggerId: this.trigger.id, messageId: message.id },
        `${this.kind} redelivery of a finished message acked`,
      )
      return
    }
    const earlier = this.held.get(message.id)
    if (!earlier) this.stats.inFlight++
    this.held.set(message.id, {
      id: message.id,
      handle: message.handle,
      runId: outcome.runId,
      attempt: outcome.attempt,
      // A redelivery of a message already held keeps its hold's start.
      since: earlier?.since ?? Date.now(),
    })
    // A subscription's own deadline (Pub/Sub's 10 s by default) is short: held for longer at once.
    await this.extend([message])
  }

  /** For answers and extensions: stopped with the subscriber, and never longer than 15 s (a hung call mustn't stall
   * the hold loop while other messages' deadlines run out). */
  private callSignal(): AbortSignal {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)])
  }

  private async extend(held: Pick<HeldMessage, 'id' | 'handle'>[]): Promise<void> {
    try {
      await this.adapter.extend(held, this.callSignal())
    } catch (err) {
      // An extension missed: the queue may hand it out again, and the redelivery is held for the same run.
      if (!this.abort.signal.aborted)
        this.opts.log?.warn(
          { triggerId: this.trigger.id, err: describe(err) },
          `${this.kind} hold extension failed`,
        )
    }
  }

  /** Watches held messages' runs: answers on success, failure or cancel, releases past the hold, extends. */
  private async holdLoop(): Promise<void> {
    const checkMs = this.opts.checkMs ?? 1_000
    const extendEveryMs = this.opts.extendEveryMs ?? 20_000
    const maxHoldMs = this.trigger.config.maxHoldMinutes * (this.opts.holdMinuteMs ?? 60_000)
    let nextExtend = Date.now() + extendEveryMs
    while (!this.abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, checkMs)
        const signal = this.abort.signal
        function done() {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
      })
      if (this.abort.signal.aborted || !this.held.size) continue
      try {
        const held = [...this.held.values()]
        const runs = new Map(
          (
            await this.opts.db
              .select({ id: workflowRuns.id, status: workflowRuns.status, error: workflowRuns.error })
              .from(workflowRuns)
              .where(
                inArray(
                  workflowRuns.id,
                  held.map((h) => h.runId),
                ),
              )
          ).map((r) => [r.id, r]),
        )
        const now = Date.now()
        for (const h of held) {
          const run = runs.get(h.runId)
          if (run?.status === 'succeeded') await this.finish(h, 'succeeded')
          // Failed, cancelled, or gone (deleted with its workflow): the kind's failure path.
          else if (run === undefined || run.status === 'failed' || run.status === 'cancelled')
            await this.finish(h, 'failed', runError(run))
          else if (now - h.since >= maxHoldMs) await this.finish(h, 'released')
        }
        if (now >= nextExtend && this.held.size) {
          nextExtend = now + extendEveryMs
          await this.extend([...this.held.values()])
        }
      } catch (err) {
        if (!this.abort.signal.aborted)
          this.opts.log?.warn(
            { triggerId: this.trigger.id, err: describe(err) },
            `${this.kind} hold check failed`,
          )
      }
    }
  }

  /**
   * A held message's end: recorded first (so a redelivery of one whose answer was lost is recognised), then answered:
   * acked (`succeeded`, `released`), or through the adapter's failure path (`failed`): handed back to the queue, or
   * Kafka's retry or dead letter (then recorded as such).
   */
  private async finish(
    h: HeldMessage,
    outcome: 'succeeded' | 'failed' | 'released',
    error: string | null = null,
  ): Promise<void> {
    await this.record(h, outcome)
    // A redelivery for the same run may have replaced the entry meanwhile: its handle is the one to answer.
    const current = this.held.get(h.id)
    const answer = current && current.runId === h.runId ? current : h
    if (!current || current.runId === h.runId) {
      this.held.delete(h.id)
      this.stats.inFlight--
    }
    const where = { triggerId: this.trigger.id, messageId: h.id, runId: h.runId }
    try {
      if (outcome === 'failed') {
        const result = await this.adapter.fail(answer, error, this.callSignal())
        this.stats[result]++
        if (result === 'dead_lettered' || result === 'dropped') await this.record(h, result)
        this.opts.log?.[result === 'dropped' ? 'warn' : 'info'](
          { ...where, attempt: h.attempt },
          result === 'nacked'
            ? `${this.kind} message nacked: its run failed`
            : result === 'retried'
              ? `${this.kind} message to be retried: its run failed`
              : result === 'dead_lettered'
                ? `${this.kind} message dead-lettered after its last attempt`
                : `${this.kind} message dropped after its last attempt (no dead-letter topic)`,
        )
      } else {
        await this.adapter.ack(answer, this.callSignal())
        this.stats[outcome === 'released' ? 'released' : 'acked']++
        if (outcome === 'released')
          this.opts.log?.warn(
            { ...where, maxHoldMinutes: this.trigger.config.maxHoldMinutes },
            `${this.kind} message held past maxHoldMinutes: acked, its run goes on`,
          )
      }
    } catch (err) {
      // Lost: the queue hands it out again after its deadline, and the recorded outcome decides then.
      if (!this.abort.signal.aborted)
        this.opts.log?.warn({ ...where, err: describe(err) }, `${this.kind} ack or nack failed`)
    }
    this.wake()
  }

  private async record(h: HeldMessage, outcome: QueueDeliveryOutcome): Promise<void> {
    await this.opts.db
      .update(queueDeliveries)
      .set({ outcome, updatedAt: new Date() })
      .where(
        and(
          eq(queueDeliveries.triggerId, this.trigger.id),
          eq(queueDeliveries.messageId, h.id),
          eq(queueDeliveries.lastRunId, h.runId),
        ),
      )
  }
}

type QueueDeliveryOutcome = 'succeeded' | 'failed' | 'released' | 'dead_lettered' | 'dropped'

/** Outcomes after which a message is never run again. */
const FINISHED: readonly (string | null)[] = ['succeeded', 'released', 'dead_lettered', 'dropped']

/**
 * What a delivery means, decided under the delivery row's lock: `done` (its run succeeded, or it was released or
 * dead-lettered: answer it), `running` (the latest run is still under way: hold the message for it), or `started` (a
 * new run for this delivery). `attempt` is the delivery's number for the message.
 */
export async function startDelivery(
  db: Db,
  trigger: Pick<QueueTriggerRow, 'id' | 'workflow_id' | 'release_id' | 'environment_id' | 'kind'>,
  message: Pick<QueueMessage, 'id' | 'input'>,
): Promise<{ kind: 'done' } | { kind: 'running' | 'started'; runId: string; attempt: number }> {
  return db.transaction(async (tx) => {
    const match = and(eq(queueDeliveries.triggerId, trigger.id), eq(queueDeliveries.messageId, message.id))
    await tx
      .insert(queueDeliveries)
      .values({ triggerId: trigger.id, messageId: message.id })
      .onConflictDoNothing()
    const [delivery] = await tx.select().from(queueDeliveries).where(match).for('update')
    if (FINISHED.includes(delivery!.outcome)) return { kind: 'done' as const }
    if (delivery!.outcome === null && delivery!.lastRunId) {
      const [latest] = await tx
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, delivery!.lastRunId))
      if (latest && ['queued', 'running', 'waiting'].includes(latest.status))
        return { kind: 'running' as const, runId: delivery!.lastRunId, attempt: delivery!.runs }
      // It ended, but its outcome wasn't recorded (its worker stopped first): record it now. One that succeeded is
      // done: never run again.
      const ended = latest?.status === 'succeeded' ? 'succeeded' : 'failed'
      await tx.update(queueDeliveries).set({ outcome: ended, updatedAt: new Date() }).where(match)
      if (ended === 'succeeded') return { kind: 'done' as const }
    }
    const n = delivery!.runs + 1
    const { run } = await startRun(tx as unknown as Db, {
      workflowId: trigger.workflow_id,
      releaseId: trigger.release_id,
      environmentId: trigger.environment_id,
      triggerType: trigger.kind,
      triggerId: trigger.id,
      idempotencyKey: `${trigger.kind}:${trigger.id}:${message.id}:${n}`,
      input: typeof message.input === 'function' ? message.input(n) : message.input,
    })
    await tx
      .update(queueDeliveries)
      .set({ runs: n, lastRunId: run.id, outcome: null, updatedAt: new Date() })
      .where(match)
    return { kind: 'started' as const, runId: run.id, attempt: n }
  })
}

/** A failed run's error message, for Kafka's dead letters. */
function runError(run: { status: string; error: Record<string, unknown> | null } | undefined): string | null {
  if (!run) return 'the run was deleted'
  if (run.status === 'cancelled') return 'the run was cancelled'
  const message = run.error?.message
  return typeof message === 'string' ? message : null
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
