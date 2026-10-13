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

export interface RunView {
  id: string
  workflow: { id: string; slug: string; name: string }
  environment: string
  version: 'draft' | 'live'
  targetBlocks: string[] | null
  status: RunStatus
  triggerType: string
  input: { data?: unknown }
  response: { status: number; headers: Record<string, string>; body: unknown } | null
  error: RunError | null
  recoveries: number
  createdBy: string | null
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
  start: (slug: string, input: unknown, environment?: string) =>
    call<{ run: RunView }>(`/workflows/${slug}/runs${env(environment)}`, {
      method: 'POST',
      body: { input },
    }).then((r) => r.run),
  startBlock: (slug: string, block: string, environment?: string) =>
    call<{ run: RunView }>(`/workflows/${slug}/blocks/${encodeURIComponent(block)}/runs${env(environment)}`, {
      method: 'POST',
      body: {},
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
}

/** `1.2 s`, `350 ms`, or `—` while unknown. */
export function duration(from: string | null, to: string | null): string {
  if (!from) return '—'
  const ms = (to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
