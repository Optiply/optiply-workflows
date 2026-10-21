import {
  type Db,
  environments,
  resourceConfigs,
  resources,
  type Workflow,
  type WorkflowRelease,
  type WorkflowRun,
  type WorkflowTrigger,
  workflowReleases,
  workflowRuns,
  workflows,
  workflowTriggers,
} from '@ow/db'
import {
  type AliasSegment,
  matchWebhookAlias,
  parseWebhookAlias,
  queriedResources,
  type WebhookTrigger,
} from '@ow/definition'
import type { RunEvent } from '@ow/engine'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { RunEventHub } from './run-events'
import { RunRequestError } from './workflow-runs'

/** A webhook's body as sent, with the parser that matched its content type. */
export class RawBody {
  constructor(
    readonly kind: 'json' | 'form' | 'text',
    readonly bytes: Buffer,
  ) {}

  /** JSON (an empty body is null), a form as an object, anything else as text. */
  parse(): unknown {
    const text = this.bytes.toString('utf8')
    if (this.kind === 'form') return Object.fromEntries(new URLSearchParams(text))
    if (this.kind === 'text') return text
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new RunRequestError(400, 'invalid_request', 'The body is not valid JSON')
    }
  }
}

export interface WebhookTarget {
  workflow: Workflow
  trigger: WorkflowTrigger
  release: WorkflowRelease
  webhook: Required<Pick<WebhookTrigger, 'methods' | 'syncTimeoutMs'>> & WebhookTrigger
  pathParams: Record<string, string>
}

/** The live webhook of the workflow with this slug. */
export async function webhookBySlug(db: Db, slug: string): Promise<WebhookTarget> {
  const [row] = await db
    .select({ workflow: workflows, trigger: workflowTriggers, release: workflowReleases })
    .from(workflows)
    .leftJoin(
      workflowTriggers,
      and(eq(workflowTriggers.workflowId, workflows.id), eq(workflowTriggers.kind, 'webhook')),
    )
    .leftJoin(workflowReleases, eq(workflowReleases.id, workflowTriggers.releaseId))
    .where(eq(workflows.slug, slug))
  if (!row) throw new RunRequestError(404, 'not_found', `No workflow has the slug "${slug}"`)
  if (!row.trigger?.enabled || !row.release) {
    throw new RunRequestError(
      404,
      'not_found',
      `Workflow "${slug}" has no live webhook; publish one with it enabled`,
    )
  }
  return target(row.workflow, row.trigger, row.release, {})
}

/**
 * The live webhook whose alias matches the path (already split and decoded). When several match, the one with the
 * most fixed segments wins (`orders/latest` over `orders/:id`).
 */
export async function webhookByAlias(db: Db, path: string[]): Promise<WebhookTarget> {
  const candidates = await db
    .select({ trigger: workflowTriggers })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.kind, 'webhook'),
        eq(workflowTriggers.enabled, true),
        sql`split_part(${workflowTriggers.aliasShape}, '/', 1) = ${path[0] ?? ''}`,
      ),
    )
  let best: { trigger: WorkflowTrigger; params: Record<string, string>; fixed: number } | undefined
  for (const { trigger } of candidates) {
    const parsed = parseWebhookAlias(String(trigger.config.alias ?? ''))
    if (!parsed.ok) continue
    const params = matchWebhookAlias(parsed.segments, path)
    const fixed = parsed.segments.filter((s: AliasSegment) => s.text !== undefined).length
    if (params && (!best || fixed > best.fixed)) best = { trigger, params, fixed }
  }
  if (!best) throw new RunRequestError(404, 'not_found', 'No webhook answers at this URL')
  const [row] = await db
    .select({ workflow: workflows, release: workflowReleases })
    .from(workflows)
    .innerJoin(workflowReleases, eq(workflowReleases.id, best.trigger.releaseId))
    .where(eq(workflows.id, best.trigger.workflowId))
  return target(row!.workflow, best.trigger, row!.release, best.params)
}

function target(
  workflow: Workflow,
  trigger: WorkflowTrigger,
  release: WorkflowRelease,
  pathParams: Record<string, string>,
): WebhookTarget {
  const webhook = trigger.config as WebhookTarget['webhook']
  return { workflow, trigger, release, webhook, pathParams }
}

/** The environment `?environment=` names, or the default one. */
export async function webhookEnvironment(db: Db, slug: string | undefined) {
  const rows = await db.select().from(environments)
  const env = slug ? rows.find((e) => e.slug === slug) : rows.find((e) => e.isDefault)
  if (!env) throw new RunRequestError(404, 'not_found', `No environment "${slug}"`)
  return env
}

/** Refuses up front when a resource the release queries isn't configured in the environment. */
export async function requireConfiguredResources(
  db: Db,
  release: WorkflowRelease,
  environment: { id: string; name: string },
) {
  const slugs = queriedResources(release.definition)
  if (!slugs.length) return
  const rows = await db
    .select({ slug: resources.slug, configured: resourceConfigs.id })
    .from(resources)
    .leftJoin(
      resourceConfigs,
      and(eq(resourceConfigs.resourceId, resources.id), eq(resourceConfigs.environmentId, environment.id)),
    )
    .where(inArray(resources.slug, slugs))
  for (const slug of slugs) {
    if (!rows.find((r) => r.slug === slug)?.configured) {
      throw new RunRequestError(
        400,
        'resource_not_configured',
        `Resource "${slug}" isn't configured in ${environment.name}`,
      )
    }
  }
}

/** Headers that never reach the run: the credentials the caller authenticated with. */
export function runHeaders(
  headers: Record<string, string | string[] | undefined>,
  keySource: 'x-api-key' | 'authorization',
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'cookie' || name === keySource) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

const FINAL = new Set(['succeeded', 'failed', 'cancelled'])

/** A wake-up that can be triggered from hooks and events, and awaited repeatedly. */
export class Signal {
  private resolve: (() => void) | undefined
  private pending = false
  readonly fire = () => {
    this.pending = true
    this.resolve?.()
  }
  wait(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.resolve = undefined
        this.pending = false
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.resolve = done
    })
  }
}

/**
 * Waits until the run has a reply or is final, for at most `timeoutMs`; returns the run, or null on timeout or when
 * the run pauses (`waiting`: the caller answers 202 and reads the run later). Woken by
 * `signal` (the inline runner's hooks) and by run events from other processes; polls when there's no event hub.
 */
export async function waitForReply(
  db: Db,
  events: RunEventHub | undefined,
  runId: string,
  timeoutMs: number,
  signal = new Signal(),
): Promise<WorkflowRun | null> {
  const unsubscribe = events
    ? await events.subscribe(runId, (event: RunEvent) => {
        if (
          event.type === 'response' ||
          (event.type === 'run' && (FINAL.has(event.status) || event.status === 'waiting'))
        ) {
          signal.fire()
        }
      })
    : () => {}
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId))
      if (!run || run.response || FINAL.has(run.status)) return run ?? null
      // Paused at a Wait (or a child workflow): the caller gets 202 and reads the run later.
      if (run.status === 'waiting') return null
      const left = deadline - Date.now()
      if (left <= 0) return null
      await signal.wait(events ? left : Math.min(left, 200))
    }
  } finally {
    unsubscribe()
  }
}

/** Response headers a workflow can't set: they describe the connection, not the reply. */
const HOP_BY_HOP = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade'])

/**
 * Answers a webhook from its run: the Response block's status, headers and body when one replied; otherwise
 * `200 { runId, status }` for a succeeded run and `500 { runId, status, error }` for a failed one. A string body with
 * a non-JSON content type is sent as is; everything else is JSON.
 */
export function sendRunReply(reply: FastifyReply, run: WorkflowRun) {
  reply.header('x-run-id', run.id)
  const response = run.response as { status: number; headers: Record<string, string>; body: unknown } | null
  if (response) {
    for (const [name, value] of Object.entries(response.headers)) {
      if (!HOP_BY_HOP.has(name)) reply.header(name, value)
    }
    reply.code(response.status)
    if (response.body === null || response.body === undefined) return reply.send()
    const type = response.headers['content-type']
    if (typeof response.body === 'string' && type && !/json/i.test(type)) return reply.send(response.body)
    return reply.type(type ?? 'application/json; charset=utf-8').send(JSON.stringify(response.body))
  }
  if (run.status === 'succeeded') return reply.code(200).send({ runId: run.id, status: run.status })
  const error = run.error as { code?: string; message?: string } | null
  return reply.code(500).send({
    runId: run.id,
    status: run.status,
    error: error ? { code: error.code ?? 'failed', message: error.message ?? 'The run failed' } : null,
  })
}
