import type { Keyring } from '@ow/crypto'
import type { Db } from '@ow/db'
import { WEBHOOK_METHODS } from '@ow/definition'
import type { InlineRunner } from '@ow/engine'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Metrics } from '../metrics'
import { apiKeyAllows, authenticateApiKey, presentedApiKey } from '../services/api-keys'
import type { RunEventHub } from '../services/run-events'
import { recordRejection, requireUnderLimit, WebhookRejection } from '../services/webhook-limits'
import { readSigningSecrets, verifyWebhookSignature } from '../services/webhook-signatures'
import {
  bodyValidator,
  RawBody,
  requireConfiguredResources,
  runHeaders,
  Signal,
  sendRunReply,
  type WebhookTarget,
  waitForReply,
  webhookByAlias,
  webhookBySlug,
  webhookEnvironment,
} from '../services/webhooks'
import { RunRequestError } from '../services/workflow-runs'

const MAX_IDEMPOTENCY_KEY = 255

/**
 * Webhooks: other systems start a workflow's live release over HTTP.
 *
 * - `/api/v1/workflows/<slug>/webhook`, and `/api/v1/hooks/<alias>` when the webhook has an alias (`:params` land in
 *   `startTrigger.pathParams`). The methods the webhook allows (POST by default); others get 405.
 * - An API key in `X-Api-Key` or `Authorization: Bearer`; that header never reaches the run. Keys can be limited to
 *   workflows and environments.
 * - `?environment=<slug>` picks the environment (default: the default one); other query parameters arrive as
 *   `startTrigger.urlParams`, the body as `startTrigger.data` (JSON, a form as an object, anything else as text) and
 *   the headers as `startTrigger.headers`.
 * - `Idempotency-Key`: a repeat gets the same run (and its reply) instead of a new one, marked
 *   `Idempotent-Replayed: true`.
 * - Sync by default: the run executes in this process when a slot is free (else on a worker) and the call waits up to
 *   the webhook's `syncTimeoutMs` for the reply (see `sendRunReply`); after that, or with `Prefer: respond-async`,
 *   the answer is `202 { runId, status }` with the run's URL in `Location`. `X-Run-Id` is on every answer.
 */
export const webhooksApi: FastifyPluginAsync<{
  db: Db
  keyring: Keyring
  /** The URL callers use (PUBLIC_URL): HubSpot and custom `{url}` signatures sign it. */
  publicUrl: string
  events?: RunEventHub
  runner: InlineRunner
  metrics?: Metrics
}> = async (app, { db, keyring, publicUrl, events, runner, metrics }) => {
  // Bodies are kept as bytes, tagged with how to read them, and parsed only once the caller is authenticated: a
  // signature covers the exact bytes sent.
  app.removeContentTypeParser(['application/json', 'text/plain'])
  const keep =
    (kind: RawBody['kind']) =>
    (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: RawBody) => void) =>
      done(null, new RawBody(kind, body, String(req.headers['content-type'] ?? '')))
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, keep('json'))
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, keep('form'))
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, keep('multipart'))
  app.addContentTypeParser('*', { parseAs: 'buffer' }, keep('text'))

  /** The webhook (and, once known, the environment) a request reached, for recording a rejection. */
  const reached = new WeakMap<FastifyRequest, { triggerId: string; environmentId: string | null }>()

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof RunRequestError) {
      if (err.status < 500) {
        const reason = err instanceof WebhookRejection ? err.reason : err.code
        metrics?.webhookRejected(reason)
        const target = reached.get(req)
        if (target && (!(err instanceof WebhookRejection) || err.record)) {
          await recordRejection(db, {
            ...target,
            status: err.status,
            reason,
            message: err.message,
            ip: req.ip ?? null,
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
          }).catch((e) => req.log.error({ err: e }, 'recording a webhook rejection failed'))
        }
      }
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
      })
    }
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      metrics?.webhookRejected(FASTIFY_REASONS[status] ?? 'invalid_request')
      return reply.code(status).send({ error: { code: 'invalid_request', message: (err as Error).message } })
    }
    app.log.error({ err }, 'webhook error')
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } })
  })

  async function handle(req: FastifyRequest, reply: FastifyReply, find: () => Promise<WebhookTarget>) {
    const { workflow, trigger, release, webhook, pathParams } = await find()
    reached.set(req, { triggerId: trigger.id, environmentId: null })
    await requireUnderLimit(db, trigger.id, webhook.rateLimit, (seconds) =>
      reply.header('retry-after', String(seconds)),
    )
    if (!webhook.methods.includes(req.method as (typeof WEBHOOK_METHODS)[number])) {
      reply.header('allow', webhook.methods.join(', '))
      throw new RunRequestError(
        405,
        'method_not_allowed',
        `This webhook accepts ${webhook.methods.join(', ')}`,
      )
    }
    const { environment: envSlug, ...urlParams } = (req.query ?? {}) as Record<string, string | string[]>
    const environment = await webhookEnvironment(
      db,
      webhook,
      typeof envSlug === 'string' ? envSlug : undefined,
    )
    reached.set(req, { triggerId: trigger.id, environmentId: environment.id })
    const raw = req.body instanceof RawBody ? req.body : null

    const presented = presentedApiKey(req.headers)
    let apiKeyId: string | null = null
    if (webhook.auth.type === 'apiKey') {
      if (!presented) {
        throw new RunRequestError(401, 'unauthorized', 'Send an API key in the X-Api-Key header')
      }
      const key = await authenticateApiKey(db, presented.key)
      if (!key) throw new RunRequestError(401, 'unauthorized', 'This API key is unknown, revoked or expired')
      if (!apiKeyAllows(key, workflow.id, environment.id)) {
        throw new RunRequestError(
          403,
          'forbidden',
          `This API key can't start workflow "${workflow.slug}" in ${environment.name}`,
        )
      }
      apiKeyId = key.id
    } else if (webhook.auth.type === 'signature') {
      const auth = webhook.auth
      const secrets = await readSigningSecrets(db, keyring, auth.secret, environment.id)
      const check = secrets
        ? verifyWebhookSignature(auth, secrets, {
            method: req.method,
            url: new URL(req.url, publicUrl).toString(),
            headers: req.headers,
            body: raw?.bytes ?? Buffer.alloc(0),
          })
        : ({
            ok: false,
            reason: 'secret_unset',
            message: `Config var ${auth.secret} has no secret value`,
          } as const)
      if (!check.ok) {
        req.log.info(
          { workflow: workflow.slug, reason: check.reason },
          `webhook signature refused: ${check.message}`,
        )
        throw new WebhookRejection(
          401,
          'unauthorized',
          "The request's signature couldn't be verified",
          check.reason,
        )
      }
    }

    await requireConfiguredResources(db, release, environment)
    const data = raw ? await raw.parse() : null

    // Slack checks a new Events API URL with a challenge, signed like any event: answer it without a run.
    if (webhook.auth.type === 'signature' && webhook.auth.preset === 'slack' && isSlackChallenge(data)) {
      return reply.code(200).send({ challenge: data.challenge })
    }

    const errors = bodyValidator(release, webhook, req.log)?.(data)
    if (errors) {
      throw new WebhookRejection(
        400,
        'invalid_body',
        "The body doesn't match the webhook's schema",
        'invalid_body',
        {
          details: { errors },
        },
      )
    }

    const header = (name: string | null) => {
      const value = name ? req.headers[name] : undefined
      return typeof value === 'string' && value ? value : undefined
    }
    const idempotencyKey = header('idempotency-key') ?? header(webhook.idempotencyHeader)
    if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
      throw new RunRequestError(
        400,
        'invalid_request',
        `Idempotency-Key is longer than ${MAX_IDEMPOTENCY_KEY}`,
      )
    }
    const respondAsync =
      /\brespond-async\b/i.test(String(req.headers.prefer ?? '')) || webhook.syncTimeoutMs === 0
    const signal = new Signal()
    const started = await runner.start(
      {
        workflowId: workflow.id,
        releaseId: release.id,
        environmentId: environment.id,
        triggerType: 'webhook',
        triggerId: trigger.id,
        apiKeyId,
        idempotencyKey: idempotencyKey ?? null,
        input: {
          data,
          headers: runHeaders(req.headers, presented?.source),
          pathParams,
          urlParams,
        },
      },
      { onResponse: signal.fire, onDone: signal.fire },
    )
    const { run, replayed } = started
    if (replayed) reply.header('idempotent-replayed', 'true')

    const answered = respondAsync
      ? null
      : await waitForReply(db, events, run.id, webhook.syncTimeoutMs, signal)
    if (answered) return sendRunReply(reply, answered)
    reply.header('x-run-id', run.id).header('location', `/api/v1/runs/${run.id}`)
    return reply.code(202).send({ runId: run.id, status: run.status })
  }

  app.route({
    method: [...WEBHOOK_METHODS],
    url: '/workflows/:slug/webhook',
    handler: (req, reply) =>
      handle(req, reply, () => webhookBySlug(db, (req.params as { slug: string }).slug)),
  })

  app.route({
    method: [...WEBHOOK_METHODS],
    url: '/hooks/*',
    handler: (req, reply) =>
      handle(req, reply, () => {
        let path: string[]
        try {
          path = (req.params as { '*': string })['*'].split('/').map(decodeURIComponent)
        } catch {
          throw new RunRequestError(400, 'invalid_request', 'The URL has a malformed escape')
        }
        return webhookByAlias(db, path)
      }),
  })
}

function isSlackChallenge(data: unknown): data is { type: 'url_verification'; challenge: string } {
  const d = data as { type?: unknown; challenge?: unknown } | null
  return d?.type === 'url_verification' && typeof d.challenge === 'string'
}

/** Reason codes for the 4xx Fastify answers before the handler (body parsing). */
const FASTIFY_REASONS: Record<number, string> = { 413: 'body_too_large', 415: 'unsupported_media_type' }
