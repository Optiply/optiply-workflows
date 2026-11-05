import type { WorkflowDefinition } from '@ow/definition'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  blockRunPayloads,
  blockRuns,
  createDb,
  type Db,
  environments,
  runLogs,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
  workflows,
  workflowTriggers,
} from '../src'
import { startTestDatabase } from '../src/testing'

let db: Db
let stop: () => Promise<void>
let envId: string

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
  edges: [],
}
const HASH = 'a'.repeat(64)

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = createDb(pg.url, { max: 2 })
  db = conn.db
  stop = async () => {
    await conn.close()
    await pg.stop()
  }
  envId = (await db.select().from(environments).where(eq(environments.slug, 'production')))[0]!.id
})
afterAll(() => stop?.())

/** The Postgres error behind a failed drizzle query (drizzle wraps it as `cause`). */
async function pgError(query: Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await query
  } catch (err) {
    return ((err as { cause?: unknown }).cause ?? err) as { code?: string; constraint_name?: string }
  }
  throw new Error('expected the query to fail')
}

let slugCount = 0
async function workflowWithRelease() {
  const [wf] = await db
    .insert(workflows)
    .values({ slug: `wf_${++slugCount}`, name: 'Sync orders', draftDefinition: definition })
    .returning()
  const [release] = await db
    .insert(workflowReleases)
    .values({ workflowId: wf!.id, version: '1.0.0', definition, definitionHash: HASH })
    .returning()
  return { wf: wf!, release: release! }
}

type RunValues = Partial<typeof workflowRuns.$inferInsert>
const runValues = (workflowId: string, releaseId: string, values: RunValues = {}) => ({
  workflowId,
  releaseId,
  environmentId: envId,
  triggerType: 'manual' as const,
  ...values,
})

describe('workflows', () => {
  it('keeps slugs unique', async () => {
    await db.insert(workflows).values({ slug: 'dup', name: 'A', draftDefinition: definition })
    expect(
      await pgError(db.insert(workflows).values({ slug: 'dup', name: 'B', draftDefinition: definition })),
    ).toMatchObject({ code: '23505', constraint_name: 'workflows_slug_uq' })
  })

  it('keeps one draft snapshot per revision', async () => {
    const { wf } = await workflowWithRelease()
    await db.insert(workflowDraftSnapshots).values({ workflowId: wf.id, revision: 3, definition })
    expect(
      await pgError(db.insert(workflowDraftSnapshots).values({ workflowId: wf.id, revision: 3, definition })),
    ).toMatchObject({ constraint_name: 'workflow_draft_snapshots_revision_uq' })
  })
})

describe('releases', () => {
  it('accepts only SemVer versions, once per workflow', async () => {
    const { wf } = await workflowWithRelease()
    const release = (version: string, definitionHash = HASH) =>
      db.insert(workflowReleases).values({ workflowId: wf.id, version, definition, definitionHash })

    await release('1.10.0')
    await release('0.0.1')
    for (const bad of ['1x2x3', '1.2', 'v1.2.3', '01.2.3', '1.2.3-beta']) {
      expect(await pgError(release(bad)), bad).toMatchObject({
        constraint_name: 'workflow_releases_version_ck',
      })
    }
    expect(await pgError(release('1.0.0'))).toMatchObject({ constraint_name: 'workflow_releases_version_uq' })
    expect(await pgError(release('2.0.0', 'ABC'))).toMatchObject({
      constraint_name: 'workflow_releases_hash_ck',
    })
  })
})

describe('runs', () => {
  it('runs exactly one of a release or a draft snapshot', async () => {
    const { wf, release } = await workflowWithRelease()
    const [snapshot] = await db
      .insert(workflowDraftSnapshots)
      .values({ workflowId: wf.id, revision: 1, definition })
      .returning()

    await db.insert(workflowRuns).values(runValues(wf.id, release.id))
    await db
      .insert(workflowRuns)
      .values(runValues(wf.id, null as unknown as string, { draftSnapshotId: snapshot!.id }))
    for (const values of [
      runValues(wf.id, null as unknown as string),
      runValues(wf.id, release.id, { draftSnapshotId: snapshot!.id }),
    ]) {
      expect(await pgError(db.insert(workflowRuns).values(values))).toMatchObject({
        constraint_name: 'workflow_runs_source_ck',
      })
    }
  })

  it('needs a lease while running', async () => {
    const { wf, release } = await workflowWithRelease()
    expect(
      await pgError(db.insert(workflowRuns).values(runValues(wf.id, release.id, { status: 'running' }))),
    ).toMatchObject({ constraint_name: 'workflow_runs_lease_ck' })
    await db.insert(workflowRuns).values(
      runValues(wf.id, release.id, {
        status: 'running',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date(Date.now() + 30_000),
        epoch: 1,
      }),
    )
  })

  it('has finishedAt exactly when the run is final', async () => {
    const { wf, release } = await workflowWithRelease()
    const now = new Date()
    expect(
      await pgError(db.insert(workflowRuns).values(runValues(wf.id, release.id, { status: 'succeeded' }))),
    ).toMatchObject({ constraint_name: 'workflow_runs_finished_ck' })
    expect(
      await pgError(db.insert(workflowRuns).values(runValues(wf.id, release.id, { finishedAt: now }))),
    ).toMatchObject({ constraint_name: 'workflow_runs_finished_ck' })
    await db.insert(workflowRuns).values(runValues(wf.id, release.id, { status: 'failed', finishedAt: now }))
  })

  it('rejects unknown statuses and trigger types', async () => {
    const { wf, release } = await workflowWithRelease()
    const bad = <T>(v: T) => v as never
    expect(
      await pgError(db.insert(workflowRuns).values(runValues(wf.id, release.id, { status: bad('done') }))),
    ).toMatchObject({ constraint_name: 'workflow_runs_status_ck' })
    expect(
      await pgError(
        db.insert(workflowRuns).values(runValues(wf.id, release.id, { triggerType: bad('cron') })),
      ),
    ).toMatchObject({ constraint_name: 'workflow_runs_trigger_type_ck' })
  })

  it('accepts an idempotency key once per workflow and environment', async () => {
    const a = await workflowWithRelease()
    const b = await workflowWithRelease()
    const staging = (await db.select().from(environments).where(eq(environments.slug, 'staging')))[0]!.id
    await db.insert(workflowRuns).values(runValues(a.wf.id, a.release.id, { idempotencyKey: 'k1' }))
    await db.insert(workflowRuns).values(runValues(b.wf.id, b.release.id, { idempotencyKey: 'k1' }))
    await db
      .insert(workflowRuns)
      .values({ ...runValues(a.wf.id, a.release.id, { idempotencyKey: 'k1' }), environmentId: staging })
    await db.insert(workflowRuns).values([runValues(a.wf.id, a.release.id), runValues(a.wf.id, a.release.id)])
    expect(
      await pgError(
        db.insert(workflowRuns).values(runValues(a.wf.id, a.release.id, { idempotencyKey: 'k1' })),
      ),
    ).toMatchObject({ constraint_name: 'workflow_runs_idempotency_uq' })
  })

  it('records each schedule fire once, with ON CONFLICT on the partial index', async () => {
    const { wf, release } = await workflowWithRelease()
    const [trigger] = await db
      .insert(workflowTriggers)
      .values({ workflowId: wf.id, releaseId: release.id, kind: 'schedule', name: 'nightly' })
      .returning()
    const fire = () =>
      db.execute(sql`
        insert into workflow_runs (id, workflow_id, release_id, environment_id, trigger_type, trigger_id, scheduled_for)
        values (gen_random_uuid(), ${wf.id}, ${release.id}, ${envId}, 'schedule', ${trigger!.id}, '2026-10-13T03:00:00Z')
        on conflict (trigger_id, scheduled_for) where trigger_id is not null and scheduled_for is not null
        do nothing
        returning id`)
    expect(await fire()).toHaveLength(1)
    expect(await fire()).toHaveLength(0)
  })
})

describe('block runs', () => {
  async function run() {
    const { wf, release } = await workflowWithRelease()
    const [r] = await db.insert(workflowRuns).values(runValues(wf.id, release.id)).returning()
    return { wf, release, run: r! }
  }

  it('commits one result per block key', async () => {
    const { run: r } = await run()
    await db.insert(blockRuns).values({ runId: r.id, blockKey: 'query1', status: 'succeeded', epoch: 1 })
    expect(
      await pgError(
        db.insert(blockRuns).values({ runId: r.id, blockKey: 'query1', status: 'succeeded', epoch: 2 }),
      ),
    ).toMatchObject({ constraint_name: 'block_runs_key_uq' })
  })

  it('checks status, attempt and payload size', async () => {
    const { run: r } = await run()
    expect(
      await pgError(
        db.insert(blockRuns).values({ runId: r.id, blockKey: 'a', status: 'ok' as never, epoch: 1 }),
      ),
    ).toMatchObject({ constraint_name: 'block_runs_status_ck' })
    expect(
      await pgError(
        db.insert(blockRuns).values({ runId: r.id, blockKey: 'a', status: 'running', epoch: 1, attempt: 0 }),
      ),
    ).toMatchObject({ constraint_name: 'block_runs_attempt_ck' })

    const [b] = await db
      .insert(blockRuns)
      .values({ runId: r.id, blockKey: 'a', status: 'succeeded', epoch: 1 })
      .returning()
    expect(
      await pgError(db.insert(blockRunPayloads).values({ blockRunId: b!.id, data: [], sizeBytes: 10485761 })),
    ).toMatchObject({ constraint_name: 'block_run_payloads_size_ck' })
    await db.insert(blockRunPayloads).values({ blockRunId: b!.id, data: [{ id: 1 }], sizeBytes: 10 })
  })

  it('goes away with its run, payloads and logs included', async () => {
    const { run: r } = await run()
    const [b] = await db
      .insert(blockRuns)
      .values({ runId: r.id, blockKey: 'a', status: 'succeeded', epoch: 1 })
      .returning()
    await db.insert(blockRunPayloads).values({ blockRunId: b!.id, data: 1, sizeBytes: 1 })
    await db.insert(runLogs).values({ runId: r.id, blockKey: 'a', level: 'log', message: 'hi' })

    await db.delete(workflowRuns).where(eq(workflowRuns.id, r.id))
    expect(await db.select().from(blockRuns).where(eq(blockRuns.runId, r.id))).toEqual([])
    expect(await db.select().from(blockRunPayloads).where(eq(blockRunPayloads.blockRunId, b!.id))).toEqual([])
    expect(await db.select().from(runLogs).where(eq(runLogs.runId, r.id))).toEqual([])
  })
})

describe('deleting a workflow', () => {
  it('removes its releases, snapshots, triggers and runs, even when they reference each other', async () => {
    const { wf, release } = await workflowWithRelease()
    await db.update(workflows).set({ liveReleaseId: release.id }).where(eq(workflows.id, wf.id))
    const [snapshot] = await db
      .insert(workflowDraftSnapshots)
      .values({ workflowId: wf.id, revision: 1, definition })
      .returning()
    const [trigger] = await db
      .insert(workflowTriggers)
      .values({ workflowId: wf.id, releaseId: release.id, kind: 'webhook', name: 'webhook' })
      .returning()
    const [parent] = await db
      .insert(workflowRuns)
      .values(runValues(wf.id, release.id, { triggerType: 'webhook', triggerId: trigger!.id }))
      .returning()
    await db.insert(workflowRuns).values(
      runValues(wf.id, null as unknown as string, {
        draftSnapshotId: snapshot!.id,
        parentRunId: parent!.id,
      }),
    )

    await db.delete(workflows).where(eq(workflows.id, wf.id))
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id))).toEqual([])
    expect(await db.select().from(workflowReleases).where(eq(workflowReleases.workflowId, wf.id))).toEqual([])
    expect(await db.select().from(workflowTriggers).where(eq(workflowTriggers.workflowId, wf.id))).toEqual([])
  })
})
