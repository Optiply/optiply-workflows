/** A typed client for the REST runs API (`/api/v1`), which the browser calls with its session cookie. */

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
export type BlockStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'errored'
  | 'failed'
  | 'skipped'
  | 'waiting'
  | 'cancelled'
  | 'interrupted'

export interface RunError {
  code: string
  message: string
  block?: string
  details?: unknown
}

/** What a Pub/Sub-triggered run got besides its data (M19): `startTrigger.message`. */
export interface RunPubSubMessage {
  messageId: string
  publishTime: string
  attributes: Record<string, string>
  orderingKey?: string
  deliveryAttempt?: number
  subscription: string
}

/** What an SQS- or Kafka-triggered run got besides its data (M26), as far as the run views show it. */
export interface RunQueueMessage {
  messageId?: string
  queue?: string
  receiveCount?: number
  topic?: string
  partition?: number
  offset?: string
  key?: string | null
  attempt?: number
  /** Kafka (M30): the Schema Registry schema its value was decoded with. */
  schemaId?: number
  /** RabbitMQ (M30). */
  redelivered?: boolean
  /** Kinesis (M30). */
  stream?: string
  shardId?: string
  sequenceNumber?: string
}

/** A run's Pub/Sub message, when a Pub/Sub trigger started it. */
export function pubsubMessage(run: Pick<RunView, 'triggerType' | 'input'>): RunPubSubMessage | undefined {
  return run.triggerType === 'pubsub' ? (run.input?.message as RunPubSubMessage | undefined) : undefined
}

/** The line naming a queue-triggered run's message (Pub/Sub, SQS, Kafka), or undefined for other runs. */
export function queueMessageLine(run: Pick<RunView, 'triggerType' | 'input'>): string | undefined {
  const m = run.input?.message as (RunPubSubMessage & RunQueueMessage) | undefined
  if (!m) return undefined
  if (run.triggerType === 'pubsub')
    return `Pub/Sub message ${m.messageId} · ${m.subscription}${m.deliveryAttempt ? ` · delivery ${m.deliveryAttempt}` : ''}`
  if (run.triggerType === 'sqs')
    return `SQS message ${m.messageId} · ${m.queue?.split('/').pop()}${m.receiveCount && m.receiveCount > 1 ? ` · receive ${m.receiveCount}` : ''}`
  if (run.triggerType === 'kafka')
    return `Kafka ${m.topic}/${m.partition}@${m.offset}${m.key ? ` · key ${m.key}` : ''}${m.schemaId ? ` · schema ${m.schemaId}` : ''}${m.attempt && m.attempt > 1 ? ` · attempt ${m.attempt}` : ''}`
  if (run.triggerType === 'kinesis')
    return `Kinesis ${m.stream}/${m.shardId}@${m.sequenceNumber}${m.attempt && m.attempt > 1 ? ` · attempt ${m.attempt}` : ''}`
  if (run.triggerType === 'rabbitmq')
    return `RabbitMQ message${m.messageId ? ` ${m.messageId}` : ''} · ${m.queue}${m.redelivered ? ' · redelivered' : ''}`
  return undefined
}

export interface RunView {
  id: string
  workflow: { id: string; slug: string; name: string }
  environment: string
  version: 'draft' | 'live'
  targetBlocks: string[] | null
  status: RunStatus
  triggerType: string
  input: { data?: unknown; message?: RunPubSubMessage | RunQueueMessage }
  response: { status: number; headers: Record<string, string>; body: unknown } | null
  error: RunError | null
  recoveries: number
  /** The run that started this one (a Workflow block or loop), if any. */
  parentRunId: string | null
  createdBy: string | null
  /** The API key a webhook call presented. */
  apiKeyId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface BlockView {
  key: string
  status: BlockStatus
  attempt: number
  port: string | null
  error: RunError | null
  metadata: Record<string, unknown> | null
  sizeBytes: number | null
  startedAt: string | null
  finishedAt: string | null
}

/** A committed loop iteration, without its data. */
export interface IterationView extends Omit<BlockView, 'key' | 'port'> {
  index: number
}

export interface RunLog {
  id: number
  blockKey: string | null
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  at: string
}

export const FINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

async function call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...(init && {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.body),
    }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`)
  return body as T
}

const env = (environment?: string) => (environment ? `?environment=${encodeURIComponent(environment)}` : '')

export const runsApi = {
  /** `draftId`: a Git branch draft of a protected workflow (M11) instead of the main draft. */
  start: (slug: string, input: unknown, environment?: string, draftId?: string | null) =>
    call<{ run: RunView }>(`/workflows/${slug}/runs${env(environment)}`, {
      method: 'POST',
      body: { input, ...(draftId ? { draftId } : {}) },
    }).then((r) => r.run),
  /** `input`: run every ancestor again with it, instead of reusing the latest run's results. */
  startBlock: (
    slug: string,
    block: string,
    environment?: string,
    draftId?: string | null,
    fresh: { input?: unknown } = {},
  ) =>
    call<{ run: RunView }>(`/workflows/${slug}/blocks/${encodeURIComponent(block)}/runs${env(environment)}`, {
      method: 'POST',
      body: { ...(draftId ? { draftId } : {}), ...fresh },
    }).then((r) => r.run),
  get: (id: string) => call<{ run: RunView }>(`/runs/${id}`).then((r) => r.run),
  list: (params: { status?: string; before?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    ).toString()
    return call<{ runs: RunView[]; next: string | null }>(`/runs${qs ? `?${qs}` : ''}`)
  },
  ofWorkflow: (slug: string, limit = 20) =>
    call<{ runs: RunView[]; next: string | null }>(`/workflows/${slug}/runs?limit=${limit}`).then(
      (r) => r.runs,
    ),
  blocks: (id: string) => call<{ blocks: BlockView[] }>(`/runs/${id}/blocks`).then((r) => r.blocks),
  block: (id: string, key: string) =>
    call<{ block: BlockView & { data: unknown } }>(`/runs/${id}/blocks/${encodeURIComponent(key)}`).then(
      (r) => r.block,
    ),
  logs: (id: string, after = 0) => call<{ logs: RunLog[]; next: number }>(`/runs/${id}/logs?after=${after}`),
  /** 200 with the cancelled run, or 202 while a running run is being stopped. */
  cancel: (id: string) =>
    call<{ run: RunView }>(`/runs/${id}/cancel`, { method: 'POST', body: {} }).then((r) => r.run),
  children: (id: string) => call<{ runs: RunView[] }>(`/runs/${id}/children`).then((r) => r.runs),
  iterations: (
    id: string,
    key: string,
    params: { offset?: number; limit?: number; status?: string } = {},
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    ).toString()
    return call<{ iterations: IterationView[]; total: number }>(
      `/runs/${id}/blocks/${encodeURIComponent(key)}/iterations${qs ? `?${qs}` : ''}`,
    )
  },
}

/** `1.2 s`, `350 ms`, or `—` while unknown. */
export function duration(from: string | null, to: string | null): string {
  if (!from) return '—'
  const ms = (to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
