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
  type ResolvedWebhook,
  resolveWebhookSettings,
  type WebhookTrigger,
  webhookEnvironments,
} from '@ow/definition'
import { type BodyValidator, compileBodySchema } from '@ow/definition/body-schema'
import type { RunEvent } from '@ow/engine'
import busboy from 'busboy'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { RunEventHub } from './run-events'
import { WebhookRejection } from './webhook-limits'
import { RunRequestError } from './workflow-runs'

/** A webhook's body as sent, with the parser that matched its content type. */
export class RawBody {
  constructor(
    readonly kind: 'json' | 'form' | 'multipart' | 'text',
    readonly bytes: Buffer,
    /** The Content-Type header, for the multipart boundary. */
    readonly contentType = '',
  ) {}

  /**
   * JSON (an empty body is null), a form as an object, multipart as fields and files (`parseMultipart`), anything
   * else as text.
   */
  async parse(): Promise<unknown> {
    if (this.kind === 'multipart') return parseMultipart(this.bytes, this.contentType)
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

/** A file from a multipart body, as a run receives it (and a REST query's multipart part accepts it). */
export interface WebhookFile {
  filename: string
  contentType: string
  size: number
  base64: string
}

/** More parts than this is refused (413). */
export const MAX_MULTIPART_PARTS = 1000

/**
 * A `multipart/form-data` body as an object: each field a string, each file a `WebhookFile`; a name sent more than
 * once becomes an array. Parsed with busboy: the platform's own parser (undici's `Response.formData`) refuses valid
 * bodies whose boundary text appears inside a part.
 */
function parseMultipart(bytes: Buffer, contentType: string): Promise<Record<string, unknown>> {
  const malformed = () => new RunRequestError(400, 'invalid_request', 'The multipart body is malformed')
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy
    try {
      parser = busboy({
        headers: { 'content-type': contentType },
        // The whole body is already capped (the app's bodyLimit); fields may use all of it.
        limits: { parts: MAX_MULTIPART_PARTS, fieldSize: Number.POSITIVE_INFINITY },
        defParamCharset: 'utf8',
      })
    } catch {
      reject(malformed())
      return
    }
    const parts = new Map<string, unknown[]>()
    const add = (name: string, item: unknown) => parts.set(name, [...(parts.get(name) ?? []), item])
    parser.on('field', (name, value) => add(name, value))
    parser.on('file', (name, stream, info) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const file = Buffer.concat(chunks)
        add(name, {
          filename: info.filename ?? '',
          // RFC 7578 §4.4: a part without Content-Type is text/plain.
          contentType: info.mimeType,
          size: file.length,
          base64: file.toString('base64'),
        } satisfies WebhookFile)
      })
    })
    parser.on('partsLimit', () =>
      reject(
        new WebhookRejection(
          413,
          'too_many_parts',
          `A multipart body can have at most ${MAX_MULTIPART_PARTS} parts`,
          'too_many_parts',
        ),
      ),
    )
    parser.on('error', () => reject(malformed()))
    parser.on('close', () =>
      resolve(
        Object.fromEntries([...parts].map(([name, items]) => [name, items.length === 1 ? items[0] : items])),
      ),
    )
    parser.end(bytes)
  })
}

export interface WebhookTarget {
  workflow: Workflow
  trigger: WorkflowTrigger
  release: WorkflowRelease
  /** The live release's webhook with every default applied. */
  webhook: ResolvedWebhook
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
  const webhook = resolveWebhookSettings(trigger.config as WebhookTrigger)
  return { workflow, trigger, release, webhook, pathParams }
}

/**
 * The environment `?environment=` names, among those the webhook allows. Without one: the default environment, or
 * the first listed when the webhook lists environments without the default.
 */
export async function webhookEnvironment(db: Db, webhook: ResolvedWebhook, slug: string | undefined) {
  const rows = await db.select().from(environments)
  const allowed = webhookEnvironments(webhook, rows)
  const fallback = allowed.find((e) => e.isDefault) ?? allowed[0]
  const env = slug === undefined ? fallback : rows.find((e) => e.slug === slug)
  if (!env) throw new RunRequestError(404, 'not_found', `No environment "${slug ?? 'default'}"`)
  if (!allowed.includes(env))
    throw new RunRequestError(403, 'forbidden', `This webhook doesn't run in ${env.name}`)
  return env
}

const validators = new Map<string, BodyValidator | null>()
const VALIDATOR_CACHE_SIZE = 100

/**
 * The webhook's body validator for a release, compiled once and kept (the latest 100 releases). Null without a
 * schema, or for one that doesn't compile (the validator refuses those before a release; logged here).
 */
export function bodyValidator(
  release: WorkflowRelease,
  webhook: ResolvedWebhook,
  log: { warn(obj: object, msg: string): void },
): BodyValidator | null {
  if (!webhook.bodySchema) return null
  if (validators.has(release.id)) return validators.get(release.id)!
  const compiled = compileBodySchema(webhook.bodySchema)
  if (!compiled.ok)
    log.warn({ releaseId: release.id, error: compiled.error }, "webhook body schema doesn't compile")
  const validate = compiled.ok ? compiled.validate : null
  if (validators.size >= VALIDATOR_CACHE_SIZE) validators.delete(validators.keys().next().value!)
  validators.set(release.id, validate)
  return validate
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

/** Headers that never reach the run: cookies and every API key the caller sent (used or not). */
export function runHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'cookie' || name === 'x-api-key') continue
    const text = Array.isArray(value) ? value.join(', ') : value
    if (name === 'authorization' && /^\s*Bearer\s+ow_/i.test(text)) continue
    out[name] = text
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
