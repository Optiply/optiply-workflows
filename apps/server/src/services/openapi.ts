import { type Db, environments, type Workflow, workflows, workflowTriggers } from '@ow/db'
import {
  parseWebhookAlias,
  type ResolvedWebhook,
  resolveWebhookSettings,
  signatureHeaderOf,
  WEBHOOK_PRESETS,
  type WebhookTrigger,
  webhookEnvironments,
} from '@ow/definition'
import { and, eq, isNotNull } from 'drizzle-orm'

/**
 * The OpenAPI 3.1 document of the public REST routes (M15, architecture §2.18): the live webhooks the caller may
 * call, and `GET /runs/{id}` for async callers. Body schemas are JSON Schema 2020-12, which OpenAPI 3.1 embeds as is.
 */
export async function openApiDocument(
  db: Db,
  opts: { publicUrl: string; visible: (workflow: Workflow) => boolean },
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ workflow: workflows, trigger: workflowTriggers })
    .from(workflowTriggers)
    .innerJoin(workflows, eq(workflows.id, workflowTriggers.workflowId))
    .where(
      and(
        eq(workflowTriggers.kind, 'webhook'),
        eq(workflowTriggers.enabled, true),
        isNotNull(workflows.liveReleaseId),
      ),
    )
    .orderBy(workflows.slug)
  const envs = await db
    .select({ slug: environments.slug, isDefault: environments.isDefault })
    .from(environments)

  const paths: Record<string, Record<string, unknown>> = {}
  const schemas: Record<string, unknown> = { ...SHARED_SCHEMAS }
  for (const { workflow, trigger } of rows) {
    if (!opts.visible(workflow)) continue
    const webhook = resolveWebhookSettings(trigger.config as WebhookTrigger)
    const bodyRef = webhook.bodySchema ? `${workflow.slug}.body` : null
    if (bodyRef) {
      schemas[bodyRef] = {
        $id: `urn:optiply-workflows:webhook-body:${workflow.slug}`,
        ...webhook.bodySchema,
      }
    }
    const allowed = webhookEnvironments(webhook, envs).map((e) => e.slug)

    const routes: { path: string; params: string[]; id: string }[] = [
      { path: `/workflows/${workflow.slug}/webhook`, params: [], id: workflow.slug },
    ]
    const alias = webhook.alias !== undefined ? parseWebhookAlias(webhook.alias) : null
    if (alias?.ok) {
      routes.push({
        path: `/hooks/${alias.segments.map((s) => (s.param ? `{${s.param}}` : s.text)).join('/')}`,
        params: alias.segments.flatMap((s) => (s.param ? [s.param] : [])),
        id: `${workflow.slug}.alias`,
      })
    }
    for (const route of routes) {
      paths[route.path] = Object.fromEntries(
        webhook.methods.map((method) => [
          method.toLowerCase(),
          operation(workflow, webhook, method, route, allowed, bodyRef),
        ]),
      )
    }
  }

  paths['/runs/{id}'] = {
    get: {
      operationId: 'getRun',
      summary: 'Read a run',
      description:
        "An API key reads the runs of the workflows and environments it's allowed (async webhook callers).",
      tags: ['Runs'],
      security: KEY_SECURITY,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '200': {
          description: 'The run',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { run: { $ref: '#/components/schemas/Run' } },
                required: ['run'],
              },
            },
          },
        },
        '401': errorResponse('No API key, or an unknown one'),
        '404': errorResponse('No such run, or not one this key may read'),
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Optiply Workflows',
      version: '1',
      description:
        "Webhooks start a workflow's live release. Errors are `{ error: { code, message, details? } }`. This document lists the webhooks you may call.",
    },
    servers: [{ url: new URL('/api/v1', opts.publicUrl).toString() }],
    tags: [
      { name: 'Webhooks', description: 'Start a workflow' },
      { name: 'Runs', description: 'Follow a run started asynchronously' },
    ],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'The same API key as `Authorization: Bearer ow_…`',
        },
      },
      schemas,
    },
  }
}

const KEY_SECURITY = [{ apiKey: [] }, { bearer: [] }]

function operation(
  workflow: Workflow,
  webhook: ResolvedWebhook,
  method: string,
  route: { params: string[]; id: string },
  environments: string[],
  bodyRef: string | null,
) {
  const auth = webhook.auth
  const notes: string[] = []
  if (workflow.description) notes.push(workflow.description)
  if (auth.type === 'public') notes.push('Public: no authentication.')
  if (auth.type === 'signature') {
    const label = auth.preset === 'custom' ? 'an HMAC' : `a ${WEBHOOK_PRESETS[auth.preset].label}`
    notes.push(`Signed: the request must carry ${label} signature of its body.`)
  }
  if (webhook.rateLimit) {
    notes.push(`At most ${webhook.rateLimit.requests} calls per ${webhook.rateLimit.windowSeconds} s.`)
  }
  notes.push(
    webhook.syncTimeoutMs > 0
      ? `Waits up to ${webhook.syncTimeoutMs / 1000} s for the workflow's reply, then answers 202 (or at once with \`Prefer: respond-async\`).`
      : 'Answers 202 at once; read the run at its Location.',
  )

  const signatureHeader = signatureHeaderOf(auth)
  const parameters: Record<string, unknown>[] = [
    ...route.params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    {
      name: 'environment',
      in: 'query',
      required: false,
      description: 'The environment to run in (default: the default environment, or the first one allowed)',
      schema: { type: 'string', enum: environments },
    },
    // Public webhooks ignore it: any caller could read another's run.
    ...(auth.type === 'public'
      ? []
      : [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'A repeat with the same key gets the same run and its reply',
            schema: { type: 'string', maxLength: 255 },
          },
        ]),
    {
      name: 'Prefer',
      in: 'header',
      required: false,
      description: '`respond-async` answers 202 at once',
      schema: { type: 'string' },
    },
    ...(signatureHeader
      ? [{ name: signatureHeader, in: 'header', required: true, schema: { type: 'string' } }]
      : []),
  ]

  const hasBody = method !== 'GET' && method !== 'DELETE'
  const anyBody = { description: 'Any JSON, form or text' }
  const responses: Record<string, unknown> = {
    '200': {
      description: "The workflow's reply (its Response block), or `{ runId, status }` when it has none",
      headers: { 'X-Run-Id': { schema: { type: 'string', format: 'uuid' } } },
      content: { 'application/json': { schema: {} } },
    },
    '202': {
      description: 'Still running: read the run at its Location',
      headers: { Location: { schema: { type: 'string' } } },
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RunAccepted' } } },
    },
    '400': errorResponse(
      bodyRef ? "The body doesn't match the schema (see `details.errors`)" : 'A malformed body',
    ),
    '401': errorResponse(
      auth.type === 'apiKey' ? 'No API key, or an unknown one' : "The signature couldn't be verified",
    ),
    '403': errorResponse('Not allowed in this environment (or for this API key)'),
    '405': errorResponse('Another method'),
    '413': errorResponse('The body is over 10 MB, or has more than 1,000 parts'),
  }
  if (auth.type === 'public') delete responses['401']
  if (webhook.rateLimit) {
    responses['429'] = {
      ...errorResponse('Over the rate limit'),
      headers: {
        'Retry-After': { description: 'Seconds until the limit resets', schema: { type: 'integer' } },
      },
    }
  }

  return {
    operationId: `${route.id}.${method.toLowerCase()}`,
    summary: workflow.name,
    description: notes.join('\n\n'),
    tags: ['Webhooks'],
    security: auth.type === 'apiKey' ? KEY_SECURITY : [],
    parameters,
    ...(hasBody && {
      requestBody: {
        description:
          'A multipart body arrives as an object: fields as strings, files as `WebhookFile` objects.',
        required: Boolean(bodyRef),
        content: bodyRef
          ? {
              'application/json': { schema: { $ref: `#/components/schemas/${bodyRef}` } },
              'multipart/form-data': { schema: { $ref: `#/components/schemas/${bodyRef}` } },
            }
          : {
              'application/json': { schema: anyBody },
              'application/x-www-form-urlencoded': { schema: { type: 'object' } },
              'multipart/form-data': { schema: { type: 'object', additionalProperties: true } },
              'text/plain': { schema: { type: 'string' } },
            },
      },
    }),
    responses,
  }
}

function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
}

const SHARED_SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object' },
        },
        required: ['code', 'message'],
      },
    },
    required: ['error'],
  },
  RunAccepted: {
    type: 'object',
    properties: { runId: { type: 'string', format: 'uuid' }, status: { type: 'string' } },
    required: ['runId', 'status'],
  },
  WebhookFile: {
    type: 'object',
    description: 'A file from a multipart body, as the run receives it',
    properties: {
      filename: { type: 'string' },
      contentType: { type: 'string' },
      size: { type: 'integer' },
      base64: { type: 'string', contentEncoding: 'base64' },
    },
    required: ['filename', 'contentType', 'size', 'base64'],
  },
  Run: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      workflow: {
        type: 'object',
        properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' } },
      },
      environment: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] },
      triggerType: { type: 'string' },
      input: {},
      response: {},
      error: {},
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      finishedAt: { type: ['string', 'null'], format: 'date-time' },
    },
    required: ['id', 'status'],
  },
}
