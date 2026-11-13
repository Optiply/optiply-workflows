import { type Keyring, scrubSecretsDeep } from '@ow/crypto'
import {
  type ApiKey,
  blockRunPayloads,
  blockRuns,
  type Db,
  environments,
  runLogs,
  type Workflow,
  type WorkflowRun,
  workflowRuns,
  workflows,
} from '@ow/db'
import { cancelRun, type RunEvent } from '@ow/engine'
import { and, asc, desc, eq, gt, inArray, lt, notLike, sql } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions'
import { apiKeyAllows, authenticateApiKey, presentedApiKey } from '../services/api-keys'
import { openApiDocument } from '../services/openapi'
import { type Access, atLeast, loadAccess } from '../services/permissions'
import type { RunEventHub } from '../services/run-events'
import { RunRequestError, secretConfigValues, startBlockRun, startManualRun } from '../services/workflow-runs'

/**
 * The runs API: start a manual run, cancel runs, and read runs, their children, block results, loop iterations and
 * logs. Signed-in users authenticate with their session cookie. An API key may read, cancel and list the children of
 * one run (`GET /runs/:id`, `POST /runs/:id/cancel`, `GET /runs/:id/children`) of a workflow and environment it's
 * allowed, which is how async webhook callers follow the run they started. `GET /openapi.json` (M15) describes the
 * webhooks the caller may call, for a session or an API key. Errors are `{ error: { code, message, details? } }`.
 */
export const runsApi: FastifyPluginAsync<{
  db: Db
  keyring: Keyring
  events?: RunEventHub
  publicUrl: string
}> = async (app, { db, keyring, events, publicUrl }) => {
  /**
   * Block data and stored replies leave scrubbed of the environment's secret config values (a code block returning
   * `config.TOKEN`, an API echoing it), as logs and errors are when written. One per request: each environment's
   * secrets are read once.
   */
  const scrubber = () => {
    const byEnvironment = new Map<string, Promise<string[]>>()
    return async <T>(environmentId: string, value: T): Promise<T> => {
      if (value === null || value === undefined) return value
      let secrets = byEnvironment.get(environmentId)
      if (!secrets) {
        secrets = secretConfigValues(db, keyring, environmentId)
        byEnvironment.set(environmentId, secrets)
      }
      const values = await secrets
      return values.length ? scrubSecretsDeep(value, values) : value
    }
  }
  type Scrub = ReturnType<typeof scrubber>
  const runView = async (
    run: WorkflowRun,
    workflow: Workflow,
    environment: string,
    scrub: Scrub = scrubber(),
  ) => plainRunView({ ...run, response: await scrub(run.environmentId, run.response) }, workflow, environment)
  const runViews = (rows: { run: WorkflowRun; workflow: Workflow; environment: string }[]) => {
    const scrub = scrubber()
    return Promise.all(rows.map((r) => runView(r.run, r.workflow, r.environment, scrub)))
  }

  app.decorateRequest('user', null)
  app.decorateRequest('apiKey', null)
  app.addHook('preHandler', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (user) {
      req.user = user
      return
    }
    const presented = presentedApiKey(req.headers)
    if (presented && API_KEY_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) {
      const key = await authenticateApiKey(db, presented.key)
      if (key) {
        req.apiKey = key
        return
      }
    }
    return sendError(reply, new RunRequestError(401, 'unauthorized', 'Not signed in'))
  })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RunRequestError) return sendError(reply, err)
    if ((err as { validation?: unknown }).validation) {
      return sendError(reply, new RunRequestError(400, 'invalid_request', (err as Error).message))
    }
    app.log.error({ err }, 'runs API error')
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } })
  })

  /** Starts a manual run of the draft (default) or the live release; `?environment=` picks the environment. */
  app.post('/workflows/:slug/runs', async (req, reply) => {
    const { slug } = parse(z.object({ slug: z.string() }), req.params)
    const query = parse(z.object({ environment: z.string().optional() }), req.query)
    const body = parse(
      z.object({
        input: z.unknown().optional(),
        version: z.enum(['draft', 'live']).default('draft'),
        /** A Git branch draft of a protected workflow (M11), instead of the main draft. */
        draftId: z.string().uuid().optional(),
      }),
      req.body ?? {},
    )
    const { access, workflow } = await visibleWorkflow(req, slug)
    const environment = await findEnvironment(query.environment)
    const run = await startManualRun(db, access, req.user!, {
      workflow,
      environmentId: environment.id,
      version: body.version,
      input: body.input,
      branchDraftId: body.draftId,
    })
    await recordAudit(db, {
      action: 'workflow.run_started',
      objectType: 'workflow',
      objectId: workflow.id,
      environmentId: environment.id,
      actorUserId: req.user!.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        runId: run.id,
        version: body.version,
        ...(body.draftId ? { branchDraftId: body.draftId } : {}),
      },
    })
    return reply.code(202).send({ run: await runView(run, workflow, environment.slug) })
  })

  /**
   * The editor's "Run block": runs one block of the draft with its ancestors' results reused from an earlier run
   * (`fromRunId`, default the latest finished run in the environment).
   */
  app.post('/workflows/:slug/blocks/:block/runs', async (req, reply) => {
    const { slug, block } = parse(z.object({ slug: z.string(), block: z.string() }), req.params)
    const query = parse(z.object({ environment: z.string().optional() }), req.query)
    const body = parse(
      z.object({
        fromRunId: z.string().uuid().optional(),
        input: z.unknown().optional(),
        testInput: z.unknown().optional(),
        draftId: z.string().uuid().optional(),
      }),
      req.body ?? {},
    )
    const { access, workflow } = await visibleWorkflow(req, slug)
    const environment = await findEnvironment(query.environment)
    const run = await startBlockRun(db, access, req.user!, {
      workflow,
      environmentId: environment.id,
      block,
      fromRunId: body.fromRunId,
      input: body.input,
      // Present (even null): reuse the earlier run only if it ran with this input.
      ...('testInput' in body && { testInput: { value: body.testInput } }),
      branchDraftId: body.draftId,
    })
    await recordAudit(db, {
      action: 'workflow.block_run_started',
      objectType: 'workflow',
      objectId: workflow.id,
      environmentId: environment.id,
      actorUserId: req.user!.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { runId: run.id, block },
    })
    return reply.code(202).send({ run: await runView(run, workflow, environment.slug) })
  })

  /** Runs of a workflow, newest first. `before` is the last run id of the previous page. */
  app.get('/workflows/:slug/runs', async (req) => {
    const { slug } = parse(z.object({ slug: z.string() }), req.params)
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().uuid().optional(),
      }),
      req.query,
    )
    const { workflow } = await visibleWorkflow(req, slug)
    const rows = await db
      .select({ run: workflowRuns, environment: environments.slug })
      .from(workflowRuns)
      .innerJoin(environments, eq(environments.id, workflowRuns.environmentId))
      .where(
        and(
          eq(workflowRuns.workflowId, workflow.id),
          query.before ? lt(workflowRuns.id, query.before) : undefined,
        ),
      )
      .orderBy(desc(workflowRuns.id))
      .limit(query.limit)
    return {
      runs: await runViews(rows.map((r) => ({ ...r, workflow }))),
      next: rows.length === query.limit ? rows.at(-1)!.run.id : null,
    }
  })

  /** Recent runs of every workflow you can see, newest first, optionally only one status. */
  app.get('/runs', async (req) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().uuid().optional(),
        status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']).optional(),
      }),
      req.query,
    )
    const access = await loadAccess(db, req.user!)
    const visible = (await db.select().from(workflows)).filter((w) => access.workflowLevel(w) !== null)
    if (!visible.length) return { runs: [], next: null }
    const byId = new Map(visible.map((w) => [w.id, w]))
    const rows = await db
      .select({ run: workflowRuns, environment: environments.slug })
      .from(workflowRuns)
      .innerJoin(environments, eq(environments.id, workflowRuns.environmentId))
      .where(
        and(
          access.isAdmin ? undefined : inArray(workflowRuns.workflowId, [...byId.keys()]),
          query.status ? eq(workflowRuns.status, query.status) : undefined,
          query.before ? lt(workflowRuns.id, query.before) : undefined,
        ),
      )
      .orderBy(desc(workflowRuns.id))
      .limit(query.limit)
    return {
      runs: await runViews(rows.map((r) => ({ ...r, workflow: byId.get(r.run.workflowId)! }))),
      next: rows.length === query.limit ? rows.at(-1)!.run.id : null,
    }
  })

  /**
   * The OpenAPI document of the webhooks the caller may call (M15): a signed-in user's are the workflows they can
   * see, an API key's the workflows it's limited to.
   */
  app.get('/openapi.json', async (req) => {
    const access = req.user ? await loadAccess(db, req.user) : null
    const key = req.apiKey
    return openApiDocument(db, {
      publicUrl,
      visible: (w) =>
        key ? key.workflowIds === null || key.workflowIds.includes(w.id) : access!.workflowLevel(w) !== null,
    })
  })

  app.get('/runs/:id', async (req) => {
    const { run, workflow, environment } = await visibleRun(req)
    return { run: await runView(run, workflow, environment) }
  })

  /**
   * Cancels a run. A queued or waiting run ends at once (`200`); a running one is stopped by the process holding it,
   * aborting in-flight SQL and fetches (`202`, still `running`; follow it until `cancelled`). Its child workflows
   * are cancelled too. Needs the access starting it took: Edit on the workflow for a draft run, Use for a live one.
   * An API key may cancel the runs it may read.
   */
  app.post('/runs/:id/cancel', async (req, reply) => {
    const { run, workflow, environment } = await visibleRun(req)
    if (req.user) {
      const level = (await loadAccess(db, req.user)).workflowLevel(workflow)
      const needed = run.releaseId ? 'use' : 'edit'
      if (!atLeast(level, needed)) {
        throw new RunRequestError(
          403,
          'forbidden',
          `You need ${needed} access to the workflow to cancel this run`,
        )
      }
    }
    const outcome = await cancelRun(db, run.id)
    if (outcome === 'finished') {
      throw new RunRequestError(
        409,
        'already_finished',
        `The run already ${run.status === 'cancelled' ? 'was cancelled' : run.status}`,
      )
    }
    if (outcome === 'not_found') throw new RunRequestError(404, 'not_found', 'Run not found')
    await recordAudit(db, {
      action: 'workflow.run_cancelled',
      objectType: 'workflow',
      objectId: workflow.id,
      environmentId: run.environmentId,
      actorUserId: req.user?.id ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { runId: run.id, ...(req.apiKey && { apiKeyId: req.apiKey.id }) },
    })
    const [current] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id))
    return reply
      .code(outcome === 'requested' ? 202 : 200)
      .send({ run: await runView(current!, workflow, environment) })
  })

  /** Runs this run started (Workflow blocks, loop workflow runners), oldest first; those of workflows you can't see are left out. */
  app.get('/runs/:id/children', async (req) => {
    const { run } = await visibleRun(req)
    const rows = await db
      .select({ run: workflowRuns, workflow: workflows, environment: environments.slug })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .innerJoin(environments, eq(environments.id, workflowRuns.environmentId))
      .where(eq(workflowRuns.parentRunId, run.id))
      .orderBy(asc(workflowRuns.id))
      .limit(1000)
    const access = req.user ? await loadAccess(db, req.user) : null
    return {
      runs: await runViews(
        rows.filter((r) =>
          access
            ? access.workflowLevel(r.workflow) !== null
            : apiKeyAllows(req.apiKey!, r.workflow.id, r.run.environmentId),
        ),
      ),
    }
  })

  /**
   * A loop's iterations in index order, without data (read one with `GET /runs/:id/blocks/<loop>[<index>]`). Only
   * committed iterations are listed: `succeeded`, `errored` (the loop continued past it) or `failed`.
   */
  app.get('/runs/:id/blocks/:key/iterations', async (req) => {
    const { run } = await visibleRun(req)
    const { key } = parse(z.object({ key: z.string() }), req.params)
    const query = parse(
      z.object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        status: z.enum(['succeeded', 'errored', 'failed']).optional(),
      }),
      req.query,
    )
    const prefix = `${key}[`
    const where = and(
      eq(blockRuns.runId, run.id),
      sql`starts_with(${blockRuns.blockKey}, ${prefix})`,
      query.status ? eq(blockRuns.status, query.status) : undefined,
    )
    const index = sql<number>`substring(${blockRuns.blockKey} from ${prefix.length + 1} for length(${blockRuns.blockKey}) - ${prefix.length + 1})::int`
    const [rows, [count]] = await Promise.all([
      db
        .select({ block: blockRuns, sizeBytes: blockRunPayloads.sizeBytes, index })
        .from(blockRuns)
        .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
        .where(where)
        .orderBy(index)
        .offset(query.offset)
        .limit(query.limit),
      db.select({ n: sql<number>`count(*)::int` }).from(blockRuns).where(where),
    ])
    return {
      iterations: rows.map((r) => {
        const { key: _key, port: _port, ...view } = blockView(r.block, r.sizeBytes)
        return { index: r.index, ...view }
      }),
      total: count!.n,
    }
  })

  /** Every block's status and timing, without data. */
  app.get('/runs/:id/blocks', async (req) => {
    const { run } = await visibleRun(req)
    return { blocks: await blocksOf(run.id) }
  })

  /**
   * Live status as server-sent events: `snapshot` ({ run, blocks }) first, then `block` ({ key, status, attempt,
   * port }) and `run` ({ status }) as they commit, then `end` once the run is final, and the stream closes. Events
   * that race the snapshot may repeat a state it already shows; clients apply them by key and attempt.
   */
  app.get('/runs/:id/events', async (req, reply) => {
    const { run, workflow, environment } = await visibleRun(req)
    if (!events) throw new RunRequestError(503, 'unavailable', 'Live run events are not available')

    const early: RunEvent[] = []
    let live: ((event: RunEvent) => void) | undefined
    // Subscribe before reading the snapshot, so no change between the two is missed.
    const unsubscribe = await events.subscribe(run.id, (event) => (live ? live(event) : early.push(event)))

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let ping: NodeJS.Timeout | undefined
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      unsubscribe()
      raw.end()
    }
    req.raw.on('close', close)
    const send = (name: string, data: unknown) => {
      if (!closed) raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const emit = (event: RunEvent) => {
      if (event.type === 'response') return
      if (event.type === 'iterations') return send('iterations', { key: event.key, count: event.count })
      if (event.type === 'block') {
        const { key, status, attempt, port } = event
        return send('block', { key, status, attempt, port })
      }
      send('run', { status: event.status })
      if (FINAL_RUN_STATUSES.has(event.status)) {
        send('end', {})
        close()
      }
    }

    try {
      const [current] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id))
      send('snapshot', {
        run: await runView(current!, workflow, environment),
        blocks: await blocksOf(run.id),
      })
      if (FINAL_RUN_STATUSES.has(current!.status)) {
        send('end', {})
        return close()
      }
      live = emit
      for (const event of early.splice(0)) emit(event)
      ping = setInterval(() => !closed && raw.write(': ping\n\n'), 15_000)
    } catch (err) {
      app.log.error({ err }, 'run events failed')
      close()
    }
  })

  /** One block with its data. */
  app.get('/runs/:id/blocks/:key', async (req) => {
    const { run } = await visibleRun(req)
    const { key } = parse(z.object({ key: z.string() }), req.params)
    const [row] = await db
      .select({ block: blockRuns, payload: blockRunPayloads })
      .from(blockRuns)
      .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
      .where(and(eq(blockRuns.runId, run.id), eq(blockRuns.blockKey, key)))
    if (!row) throw new RunRequestError(404, 'not_found', `Block "${key}" hasn't run`)
    const data = await scrubber()(run.environmentId, row.payload?.data ?? null)
    return { block: { ...blockView(row.block, row.payload?.sizeBytes ?? null), data } }
  })

  /** Logs in order. Poll with `after` set to the last id seen. */
  app.get('/runs/:id/logs', async (req) => {
    const { run } = await visibleRun(req)
    const query = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      }),
      req.query,
    )
    const logs = await db
      .select({
        id: runLogs.id,
        blockKey: runLogs.blockKey,
        level: runLogs.level,
        message: runLogs.message,
        at: runLogs.at,
      })
      .from(runLogs)
      .where(and(eq(runLogs.runId, run.id), gt(runLogs.id, query.after)))
      .orderBy(asc(runLogs.id))
      .limit(query.limit)
    return { logs, next: logs.at(-1)?.id ?? query.after }
  })

  async function blocksOf(runId: string) {
    const rows = await db
      .select({ block: blockRuns, sizeBytes: blockRunPayloads.sizeBytes })
      .from(blockRuns)
      .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
      // Loop iterations (`loop1[17]`) aren't blocks; a loop can have 100k of them.
      .where(and(eq(blockRuns.runId, runId), notLike(blockRuns.blockKey, '%[%')))
      .orderBy(asc(blockRuns.startedAt), asc(blockRuns.createdAt))
    return rows.map((r) => blockView(r.block, r.sizeBytes))
  }

  async function visibleWorkflow(
    req: FastifyRequest,
    slug: string,
  ): Promise<{ access: Access; workflow: Workflow }> {
    const access = await loadAccess(db, req.user!)
    const [workflow] = await db.select().from(workflows).where(eq(workflows.slug, slug))
    if (!workflow || access.workflowLevel(workflow) === null) {
      throw new RunRequestError(404, 'not_found', 'Workflow not found')
    }
    return { access, workflow }
  }

  async function visibleRun(req: FastifyRequest) {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const [row] = await db
      .select({ run: workflowRuns, workflow: workflows, environment: environments.slug })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .innerJoin(environments, eq(environments.id, workflowRuns.environmentId))
      .where(eq(workflowRuns.id, id))
    const visible =
      row &&
      (req.apiKey
        ? apiKeyAllows(req.apiKey, row.run.workflowId, row.run.environmentId)
        : (await loadAccess(db, req.user!)).workflowLevel(row.workflow) !== null)
    if (!row || !visible) throw new RunRequestError(404, 'not_found', 'Run not found')
    return row
  }

  async function findEnvironment(slug: string | undefined) {
    const rows = await db.select().from(environments)
    const env = slug ? rows.find((e) => e.slug === slug) : rows.find((e) => e.isDefault)
    if (!env) throw new RunRequestError(404, 'not_found', `No environment "${slug}"`)
    return env
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
    /** Set instead of `user` when an API key reads a run. */
    apiKey: ApiKey | null
  }
}

const FINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/** What an API key may call (besides webhooks): following and cancelling a run it may read. */
const API_KEY_ROUTES = new Set([
  'GET /api/v1/openapi.json',
  'GET /api/v1/runs/:id',
  'POST /api/v1/runs/:id/cancel',
  'GET /api/v1/runs/:id/children',
])

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new RunRequestError(400, 'invalid_request', message)
  }
  return parsed.data
}

function sendError(reply: FastifyReply, err: RunRequestError) {
  return reply
    .code(err.status)
    .send({ error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } })
}

function plainRunView(run: WorkflowRun, workflow: Workflow, environment: string) {
  return {
    id: run.id,
    workflow: { id: workflow.id, slug: workflow.slug, name: workflow.name },
    environment,
    version: run.releaseId ? 'live' : 'draft',
    targetBlocks: run.targetBlocks,
    status: run.status,
    triggerType: run.triggerType,
    input: run.input,
    response: run.response,
    error: run.error,
    recoveries: run.recoveries,
    parentRunId: run.parentRunId,
    createdBy: run.createdBy,
    apiKeyId: run.apiKeyId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

function blockView(block: typeof blockRuns.$inferSelect, sizeBytes: number | null) {
  return {
    key: block.blockKey,
    status: block.status,
    attempt: block.attempt,
    port: block.port,
    error: block.error,
    metadata: block.metadata,
    sizeBytes,
    startedAt: block.startedAt,
    finishedAt: block.finishedAt,
  }
}
