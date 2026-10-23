import {
  ConnectorError,
  type PubSubClient,
  type PubSubResourceClient,
  parseResource,
  pubsubClient,
  type ReceivedMessage,
} from '@ow/connectors'
import { type Db, type PubSubTriggerState, pubsubDeliveries, workflowRuns, workflowTriggers } from '@ow/db'
import type { PubSubTrigger } from '@ow/definition'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { startRun } from './queue'
import type { PubSubRunMessage, ResourceProvider } from './types'

/**
 * Pub/Sub triggers (M19, architecture §2.22), in each worker: one worker at a time holds a trigger's lease (on its
 * `workflow_triggers` row) and pulls its subscription, up to `maxInFlight` messages whose runs are under way. Each
 * delivery starts a run (idempotency key `pubsub:<trigger>:<message>:<n>`); `pubsub_deliveries` remembers what each
 * message's latest run was, so a redelivery of one that succeeded is acked without a run, and one whose run is still
 * going is held again rather than run twice.
 */
export interface PubSubConsumerOptions {
  db: Db
  resources: ResourceProvider
  /** This process, as lease holder. */
  workerId: string
  log?: PubSubLogger
  /** How often leases are taken and renewed: 5 s. */
  intervalMs?: number
  /** How long a lease lasts without being renewed: 30 s. */
  leaseMs?: number
  /** The first wait after a failed pull, doubling up to 30 s: 1 s. */
  retryMs?: number
  /** How often held messages' runs are checked for their end: 1 s. */
  checkMs?: number
  /** How often held messages' deadlines are extended: 20 s. */
  extendEveryMs?: number
  /** The deadline set each time, in Pub/Sub's seconds: 60. */
  holdDeadlineSeconds?: number
  /** How long a minute of `maxHoldMinutes` is, for tests: 60 s. */
  holdMinuteMs?: number
}

/** This process's Pub/Sub triggers, for metrics (`ow_pubsub_*`). */
export const pubsubStats = { inFlight: 0, acked: 0, nacked: 0, duplicate: 0, released: 0, pullErrors: 0 }

export interface PubSubLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/** A projected Pub/Sub trigger, as its lease returns it. */
type TriggerRow = {
  id: string
  workflow_id: string
  release_id: string
  environment_id: string
  name: string
  config: PubSubTrigger & { maxInFlight: number; maxHoldMinutes: number }
} & Record<string, unknown>

/** A delivery whose run is under way: its message is held (not acked) until the run ends. */
export interface HeldMessage {
  ackId: string
  messageId: string
  runId: string
  since: number
}

export class PubSubConsumer {
  private readonly subscribers = new Map<string, Subscriber>()
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> = Promise.resolve()

  constructor(private readonly opts: PubSubConsumerOptions) {}

  start(): void {
    void this.tick()
    this.timer ??= setInterval(() => void this.tick(), this.opts.intervalMs ?? 5_000)
  }

  /** Stops pulling and gives the leases up, so another worker takes the triggers at once. */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    await Promise.all([...this.subscribers.values()].map((s) => s.stop()))
    this.subscribers.clear()
    await this.opts.db.execute(sql`
      update workflow_triggers set lease_owner = null, lease_expires_at = null
      where kind = 'pubsub' and lease_owner = ${this.opts.workerId}`)
  }

  /** Triggers this process pulls for now, and the messages held for each. */
  get stats(): { triggers: number; inFlight: number } {
    let inFlight = 0
    for (const s of this.subscribers.values()) inFlight += s.held.size
    return { triggers: this.subscribers.size, inFlight }
  }

  /** Takes and renews leases, and starts or stops pulling to match. Never throws. */
  tick(): Promise<void> {
    this.ticking = this.ticking
      .then(() => this.leaseAndSync())
      .catch((err: unknown) => {
        this.opts.log?.warn({ err }, 'pubsub lease tick failed')
      })
    return this.ticking
  }

  private async leaseAndSync(): Promise<void> {
    const { db, workerId } = this.opts
    const leaseSecs = (this.opts.leaseMs ?? 30_000) / 1000
    // Ours (renewed), or free: nobody's, or a lease nobody renewed (its worker went away).
    const held = await db.execute<TriggerRow>(sql`
      update workflow_triggers
      set lease_owner = ${workerId}, lease_expires_at = now() + make_interval(secs => ${leaseSecs})
      where kind = 'pubsub' and enabled
        and (lease_owner = ${workerId} or lease_owner is null or lease_expires_at < now())
      returning id, workflow_id, release_id, environment_id, name, config`)
    const ids = new Set(held.map((t) => t.id))
    for (const [id, subscriber] of this.subscribers) {
      // Lost (another worker took it after a missed renewal), disabled, or dropped by a release.
      if (!ids.has(id)) {
        this.subscribers.delete(id)
        await subscriber.stop()
      }
    }
    // What each held trigger is doing, for the editor (one small update per trigger and tick).
    for (const subscriber of this.subscribers.values()) {
      await db
        .update(workflowTriggers)
        .set({ state: subscriber.state() })
        .where(and(eq(workflowTriggers.id, subscriber.triggerId), eq(workflowTriggers.leaseOwner, workerId)))
    }
    for (const trigger of held) {
      const current = this.subscribers.get(trigger.id)
      if (current && current.key === settingsKey(trigger)) continue
      if (current) await current.stop()
      if (!current)
        this.opts.log?.info({ triggerId: trigger.id, trigger: trigger.name }, 'pubsub trigger leased')
      const subscriber = new Subscriber(trigger, this.opts)
      this.subscribers.set(trigger.id, subscriber)
      subscriber.start()
    }
  }
}

/** A new release, other settings or another environment start the trigger's puller afresh. */
function settingsKey(t: TriggerRow): string {
  return JSON.stringify([t.release_id, t.environment_id, t.config])
}

/** One trigger's puller: its subscription, its held messages, its errors. */
class Subscriber {
  readonly key: string
  readonly held = new Map<string, HeldMessage>()
  private readonly abort = new AbortController()
  private loop: Promise<void> = Promise.resolve()
  private holding: Promise<void> = Promise.resolve()
  private client: PubSubResourceClient | undefined
  private wakeUp: (() => void) | undefined
  private lastMessageAt: string | null = null
  private lastPullAt: string | null = null
  private lastError: string | null = null
  private lastErrorAt: string | null = null

  constructor(
    private readonly trigger: TriggerRow,
    private readonly opts: PubSubConsumerOptions,
  ) {
    this.key = settingsKey(trigger)
  }

  get triggerId(): string {
    return this.trigger.id
  }

  state(): PubSubTriggerState {
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
   * Stops pulling and holding. Held messages are nacked, so the trigger's next worker gets them at once (and holds them
   * for their runs, which go on); one nack it can't send just waits out its deadline.
   */
  async stop(): Promise<void> {
    this.abort.abort()
    this.wake()
    await Promise.all([this.loop, this.holding])
    const left = [...this.held.values()]
    this.held.clear()
    pubsubStats.inFlight -= left.length
    if (left.length && this.client) {
      await this.client.pubsub
        .nack(
          this.trigger.config.subscription,
          left.map((h) => h.ackId),
          AbortSignal.timeout(5_000),
        )
        .catch(() => {})
    }
    await this.client?.agent.close().catch(() => {})
    this.client = undefined
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
      let received: ReceivedMessage[]
      try {
        const pubsub = await this.pubsub()
        received = await pubsub.pull(
          config.subscription,
          room,
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(90_000)]),
        )
        retry = firstRetry
        this.lastPullAt = new Date().toISOString()
        if (received.length) this.lastMessageAt = this.lastPullAt
      } catch (err) {
        if (this.abort.signal.aborted) return
        pubsubStats.pullErrors++
        this.lastError = describe(err)
        this.lastErrorAt = new Date().toISOString()
        this.opts.log?.warn(
          { triggerId: this.trigger.id, trigger: this.trigger.name, err: describe(err), retryInMs: retry },
          'pubsub pull failed',
        )
        // Settings fixed meanwhile (a key, a role) are picked up on the next try.
        await this.client?.agent.close().catch(() => {})
        this.client = undefined
        await this.sleep(retry)
        retry = Math.min(retry * 2, 30_000)
        continue
      }
      for (const message of received) {
        if (this.abort.signal.aborted) return
        try {
          await this.deliver(message)
        } catch (err) {
          // The run couldn't start (the database went away): Pub/Sub redelivers after the deadline.
          this.opts.log?.warn(
            { triggerId: this.trigger.id, messageId: message.message.messageId, err: describe(err) },
            'pubsub delivery failed',
          )
        }
      }
    }
  }

  /** The resource's client in the trigger's environment, made on first use and after a failure. */
  private async pubsub(): Promise<PubSubClient> {
    if (this.client) return this.client.pubsub
    const { connector, resource } = await this.opts.resources.resolve(
      this.trigger.config.resource,
      this.trigger.environment_id,
    )
    if (connector.type !== 'pubsub')
      throw new ConnectorError('invalid_config', `"${this.trigger.config.resource}" isn't a Pub/Sub resource`)
    const parsed = parseResource(connector, resource)
    this.client = pubsubClient(
      parsed.config as Parameters<typeof pubsubClient>[0],
      parsed.secrets as Parameters<typeof pubsubClient>[1],
    )
    return this.client.pubsub
  }

  /** Starts a run for a delivery, or recognises a redelivery: acked (it succeeded) or held (its run goes on). */
  private async deliver(received: ReceivedMessage): Promise<void> {
    const { message } = received
    const outcome = await startDelivery(this.opts.db, this.trigger, received)
    if (outcome.kind === 'done') {
      pubsubStats.duplicate++
      await this.client!.pubsub.acknowledge(
        this.trigger.config.subscription,
        [received.ackId],
        this.abort.signal,
      )
      this.opts.log?.info(
        { triggerId: this.trigger.id, messageId: message.messageId },
        'pubsub redelivery of a finished message acked',
      )
      return
    }
    const earlier = this.held.get(message.messageId)
    if (!earlier) pubsubStats.inFlight++
    this.held.set(message.messageId, {
      ackId: received.ackId,
      messageId: message.messageId,
      runId: outcome.runId,
      // A redelivery of a message already held keeps its hold's start.
      since: earlier?.since ?? Date.now(),
    })
    // The subscription's own deadline (10 s by default) is short: held for longer at once.
    await this.extend([received.ackId])
  }

  private async extend(ackIds: string[]): Promise<void> {
    try {
      await this.client!.pubsub.modifyAckDeadline(
        this.trigger.config.subscription,
        ackIds,
        this.opts.holdDeadlineSeconds ?? 60,
        this.abort.signal,
      )
    } catch (err) {
      // An extension missed: Pub/Sub may redeliver, and the redelivery is held for the same run.
      if (!this.abort.signal.aborted)
        this.opts.log?.warn(
          { triggerId: this.trigger.id, err: describe(err) },
          'pubsub hold extension failed',
        )
    }
  }

  /** Watches held messages' runs: acks on success, nacks on failure or cancel, releases past the hold, extends. */
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
        const statuses = new Map(
          (
            await this.opts.db
              .select({ id: workflowRuns.id, status: workflowRuns.status })
              .from(workflowRuns)
              .where(
                inArray(
                  workflowRuns.id,
                  held.map((h) => h.runId),
                ),
              )
          ).map((r) => [r.id, r.status]),
        )
        const now = Date.now()
        for (const h of held) {
          const status = statuses.get(h.runId)
          if (status === 'succeeded') await this.finish(h, 'succeeded')
          // Failed, cancelled, or gone (deleted with its workflow): Pub/Sub redelivers it.
          else if (status === undefined || status === 'failed' || status === 'cancelled')
            await this.finish(h, 'failed')
          else if (now - h.since >= maxHoldMs) await this.finish(h, 'released')
        }
        if (now >= nextExtend && this.held.size) {
          nextExtend = now + extendEveryMs
          await this.extend([...this.held.values()].map((h) => h.ackId))
        }
      } catch (err) {
        if (!this.abort.signal.aborted)
          this.opts.log?.warn({ triggerId: this.trigger.id, err: describe(err) }, 'pubsub hold check failed')
      }
    }
  }

  /**
   * A held message's end: recorded first (so a redelivery of one whose ack was lost is recognised), then acked
   * (`succeeded`, `released`) or nacked (`failed`, for Pub/Sub to redeliver with its backoff and dead-letter policy).
   */
  private async finish(h: HeldMessage, outcome: 'succeeded' | 'failed' | 'released'): Promise<void> {
    await this.opts.db
      .update(pubsubDeliveries)
      .set({ outcome, updatedAt: new Date() })
      .where(
        and(
          eq(pubsubDeliveries.triggerId, this.trigger.id),
          eq(pubsubDeliveries.messageId, h.messageId),
          eq(pubsubDeliveries.lastRunId, h.runId),
        ),
      )
    this.held.delete(h.messageId)
    pubsubStats.inFlight--
    const subscription = this.trigger.config.subscription
    const where = { triggerId: this.trigger.id, messageId: h.messageId, runId: h.runId }
    try {
      if (outcome === 'failed') {
        await this.client!.pubsub.nack(subscription, [h.ackId], this.abort.signal)
        pubsubStats.nacked++
        this.opts.log?.info(where, 'pubsub message nacked: its run failed')
      } else {
        await this.client!.pubsub.acknowledge(subscription, [h.ackId], this.abort.signal)
        pubsubStats[outcome === 'released' ? 'released' : 'acked']++
        if (outcome === 'released')
          this.opts.log?.warn(
            { ...where, maxHoldMinutes: this.trigger.config.maxHoldMinutes },
            'pubsub message held past maxHoldMinutes: acked, its run goes on',
          )
      }
    } catch (err) {
      // Lost: Pub/Sub redelivers it after its deadline, and the recorded outcome decides then.
      if (!this.abort.signal.aborted)
        this.opts.log?.warn({ ...where, err: describe(err) }, 'pubsub ack or nack failed')
    }
    this.wake()
  }
}

/**
 * What a delivery means, decided under the delivery row's lock: `done` (its run succeeded or was released: ack it),
 * `running` (the latest run is still under way: hold the message for it), or `started` (a new run for this delivery).
 */
export async function startDelivery(
  db: Db,
  trigger: Pick<TriggerRow, 'id' | 'workflow_id' | 'release_id' | 'environment_id' | 'config'>,
  received: ReceivedMessage,
): Promise<{ kind: 'done' } | { kind: 'running' | 'started'; runId: string }> {
  const { message } = received
  return db.transaction(async (tx) => {
    await tx
      .insert(pubsubDeliveries)
      .values({ triggerId: trigger.id, messageId: message.messageId })
      .onConflictDoNothing()
    const [delivery] = await tx
      .select()
      .from(pubsubDeliveries)
      .where(
        and(eq(pubsubDeliveries.triggerId, trigger.id), eq(pubsubDeliveries.messageId, message.messageId)),
      )
      .for('update')
    if (delivery!.outcome === 'succeeded' || delivery!.outcome === 'released')
      return { kind: 'done' as const }
    if (delivery!.outcome === null && delivery!.lastRunId) {
      const [latest] = await tx
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, delivery!.lastRunId))
      if (latest && ['queued', 'running', 'waiting'].includes(latest.status))
        return { kind: 'running' as const, runId: delivery!.lastRunId }
    }
    const n = delivery!.runs + 1
    const { run } = await startRun(tx as unknown as Db, {
      workflowId: trigger.workflow_id,
      releaseId: trigger.release_id,
      environmentId: trigger.environment_id,
      triggerType: 'pubsub',
      triggerId: trigger.id,
      idempotencyKey: `pubsub:${trigger.id}:${message.messageId}:${n}`,
      input: { data: messageData(message.data), message: runMessage(received, trigger.config.subscription) },
    })
    await tx
      .update(pubsubDeliveries)
      .set({ runs: n, lastRunId: run.id, outcome: null, updatedAt: new Date() })
      .where(
        and(eq(pubsubDeliveries.triggerId, trigger.id), eq(pubsubDeliveries.messageId, message.messageId)),
      )
    return { kind: 'started' as const, runId: run.id }
  })
}

/** The message's data as `startTrigger.data`: parsed when it's JSON, else its text. */
function messageData(data: Buffer): unknown {
  const text = data.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function runMessage(received: ReceivedMessage, subscription: string): PubSubRunMessage {
  const { message } = received
  return {
    messageId: message.messageId,
    publishTime: message.publishTime,
    attributes: message.attributes,
    ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
    ...(received.deliveryAttempt ? { deliveryAttempt: received.deliveryAttempt } : {}),
    subscription,
    dataBase64: message.data.toString('base64'),
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
