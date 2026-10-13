import { postgresConnector } from '@ow/connectors'
import { blockRuns, createDb, type Db, environments, workflowReleases, workflowRuns, workflows } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { sql as dsql, eq } from 'drizzle-orm'
import { enqueueRun, type ResourceProvider } from '../src'

/** Resources for runs: `db` is the test database itself, so queries can count their own executions. */
export function postgresResources(url: string): ResourceProvider {
  const u = new URL(url)
  return {
    async resolve(slug, environmentId) {
      if (slug !== 'db') throw new Error(`unknown resource ${slug}`)
      return {
        connector: postgresConnector,
        resource: {
          id: 'rc-db',
          resourceId: 'r-db',
          environmentId,
          version: '1',
          config: {
            host: u.hostname,
            port: Number(u.port),
            database: u.pathname.slice(1),
            user: decodeURIComponent(u.username),
            ssl: 'disable',
          },
          secrets: { password: decodeURIComponent(u.password) },
        },
      }
    },
  }
}

export function connect(url: string) {
  return createDb(url, { max: 5 })
}

/** A query block against the test database. */
export const sql = (name: string, text: string, settings?: object) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'db', query: { sql: text } },
  ...(settings && { settings }),
})

/** Records that `block` executed for this run (the hits table counts executions). */
export const hit = (name: string) =>
  sql(name, `insert into hits (run_id, block) values ({{ workflowContext.runId }}, '${name}') returning id`)

export function wf(blocks: object[], edges: [string, string, string?][]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
    edges: edges.map(([from, to, port = 'out']) => ({ from, port, to })),
  } as WorkflowDefinition
}

let n = 0
/** Creates a workflow with a 1.0.0 release of `definition` and queues a run of it. */
export async function queueRun(
  db: Db,
  definition: WorkflowDefinition,
  input: Record<string, unknown> = {},
  extra: { idempotencyKey?: string } = {},
) {
  const [env] = await db.select().from(environments).where(eq(environments.slug, 'production'))
  const [workflow] = await db
    .insert(workflows)
    .values({ slug: `wf_${Date.now()}_${++n}`, name: 'Test', draftDefinition: definition })
    .returning()
  const [release] = await db
    .insert(workflowReleases)
    .values({ workflowId: workflow!.id, version: '1.0.0', definition, definitionHash: 'f'.repeat(64) })
    .returning()
  return enqueueRun(db, {
    workflowId: workflow!.id,
    releaseId: release!.id,
    environmentId: env!.id,
    triggerType: 'manual',
    input,
    ...extra,
  })
}

export async function getRun(db: Db, id: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id))
  return run!
}

/** Polls until the run is final (or `until` holds), failing after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

export function waitForFinish(db: Db, id: string, timeoutMs?: number) {
  return waitFor(async () => {
    const run = await getRun(db, id)
    return ['succeeded', 'failed', 'cancelled'].includes(run.status) && run
  }, timeoutMs)
}

export async function blocksOf(db: Db, runId: string) {
  const rows = await db.select().from(blockRuns).where(eq(blockRuns.runId, runId))
  return Object.fromEntries(
    rows.map((r) => [r.blockKey, { status: r.status, epoch: r.epoch, attempt: r.attempt, port: r.port }]),
  )
}

export async function hitsOf(db: Db, runId: string): Promise<Record<string, number>> {
  const rows = await db.execute<{ block: string; n: number }>(
    dsql`select block, count(*)::int as n from hits where run_id = ${runId} group by block`,
  )
  return Object.fromEntries(rows.map((r) => [r.block, r.n]))
}
