import {
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
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions'
import { type Access, loadAccess } from '../services/permissions'
import { RunRequestError, startBlockRun, startManualRun } from '../services/workflow-runs'

/**
 * The runs API: start a manual run and read runs, block results and logs. Signed-in users authenticate with their
 * session cookie; API keys arrive with webhooks in M4. Errors are `{ error: { code, message, details? } }`.
 */
export const runsApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.decorateRequest('user', null)
  app.addHook('preHandler', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return sendError(reply, new RunRequestError(401, 'unauthorized', 'Not signed in'))
    req.user = user
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
      z.object({ input: z.unknown().optional(), version: z.enum(['draft', 'live']).default('draft') }),
      req.body ?? {},
    )
    const { access, workflow } = await visibleWorkflow(req, slug)
    const environment = await findEnvironment(query.environment)
    const run = await startManualRun(db, access, req.user!, {
      workflow,
      environmentId: environment.id,
      version: body.version,
      input: body.input,
    })
    await recordAudit(db, {
      action: 'workflow.run_started',
      objectType: 'workflow',
      objectId: workflow.id,
      environmentId: environment.id,
      actorUserId: req.user!.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { runId: run.id, version: body.version },
    })
    return reply.code(202).send({ run: runView(run, workflow, environment.slug) })
  })

  /**
   * The editor's "Run block": runs one block of the draft with its ancestors' results reused from an earlier run
   * (`fromRunId`, default the latest finished run in the environment).
   */
  app.post('/workflows/:slug/blocks/:block/runs', async (req, reply) => {
    const { slug, block } = parse(z.object({ slug: z.string(), block: z.string() }), req.params)
    const query = parse(z.object({ environment: z.string().optional() }), req.query)
    const body = parse(
      z.object({ fromRunId: z.string().uuid().optional(), input: z.unknown().optional() }),
      req.body ?? {},
    )
    const { access, workflow } = await visibleWorkflow(req, slug)
    const environment = await findEnvironment(query.environment)
    const run = await startBlockRun(db, access, req.user!, {
      workflow,
      environmentId: environment.id,
      block,
      ...body,
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
    return reply.code(202).send({ run: runView(run, workflow, environment.slug) })
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
      runs: rows.map((r) => runView(r.run, workflow, r.environment)),
      next: rows.length === query.limit ? rows.at(-1)!.run.id : null,
    }
  })

  app.get('/runs/:id', async (req) => {
    const { run, workflow, environment } = await visibleRun(req)
    return { run: runView(run, workflow, environment) }
  })

  /** Every block's status and timing, without data. */
  app.get('/runs/:id/blocks', async (req) => {
    const { run } = await visibleRun(req)
    const rows = await db
      .select({ block: blockRuns, sizeBytes: blockRunPayloads.sizeBytes })
      .from(blockRuns)
      .leftJoin(blockRunPayloads, eq(blockRunPayloads.blockRunId, blockRuns.id))
      .where(eq(blockRuns.runId, run.id))
      .orderBy(asc(blockRuns.startedAt), asc(blockRuns.createdAt))
    return { blocks: rows.map((r) => blockView(r.block, r.sizeBytes)) }
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
    return {
      block: { ...blockView(row.block, row.payload?.sizeBytes ?? null), data: row.payload?.data ?? null },
    }
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
    const access = await loadAccess(db, req.user!)
    if (!row || access.workflowLevel(row.workflow) === null) {
      throw new RunRequestError(404, 'not_found', 'Run not found')
    }
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
  }
}

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

function runView(run: WorkflowRun, workflow: Workflow, environment: string) {
  return {
    id: run.id,
    workflow: { id: workflow.id, slug: workflow.slug },
    environment,
    version: run.releaseId ? 'live' : 'draft',
    targetBlocks: run.targetBlocks,
    status: run.status,
    triggerType: run.triggerType,
    input: run.input,
    response: run.response,
    error: run.error,
    recoveries: run.recoveries,
    createdBy: run.createdBy,
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
