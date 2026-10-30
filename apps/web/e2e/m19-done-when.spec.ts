import { expect, type Page, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { fakePubSub, signIn } from './helpers'

/**
 * M19's done-when (architecture.md §2.7), through global setup's fake Pub/Sub: a workflow with a Pub/Sub trigger runs
 * once per published message with its data, attributes and id; a failing run is nacked and redelivered and succeeds on
 * a later delivery (one that always fails is dead-lettered); a run longer than the ack deadline keeps its message; the
 * in-flight limit holds; a redelivered message that already succeeded is acked without a run; a workflow publishes to a
 * topic and a trigger runs on it; disabling the trigger, or a release without it, stops pulling; the key never appears
 * in an API response; a non-admin can't save a Pub/Sub resource on the server's identity. Elsewhere: a worker stopped
 * mid-run handing its message over (packages/engine/test/pubsub-consumer.test.ts; one e2e server has one worker), and
 * a real topic and subscription (the Compose check, by hand).
 */

const IAP_KEY = process.env.E2E_IAP_KEY!
const KEY_LINE = (JSON.parse(IAP_KEY).private_key as string).split('\n')[5]!

/** Every API response this spec saw, to scan for the key. */
const seen: string[] = []

async function call<T>(
  page: Page,
  path: string,
  input: unknown,
  method: 'mutate' | 'query' = 'mutate',
): Promise<T> {
  const res =
    method === 'mutate'
      ? await page.request.post(`/api/trpc/${path}`, { data: { json: input } })
      : await page.request.get(
          `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        )
  const text = await res.text()
  seen.push(text)
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${text}`)
  return JSON.parse(text).result.data.json as T
}

interface RunView {
  id: string
  status: string
  input: { data: unknown; message: { messageId: string; deliveryAttempt?: number } }
  startedAt: string | null
  finishedAt: string | null
}

test('Pub/Sub triggers: a run per message, acked on success, redelivered on failure', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) seen.push(await res.text().catch(() => ''))
  })
  await signIn(page)
  const stamp = Date.now().toString(36)
  const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
  const environmentId = envs.find((e) => e.slug === 'production')!.id
  const resourceSlug = `m19_events_${stamp}`
  const { id: resourceId } = await call<{ id: string }>(page, 'resources.create', {
    type: 'pubsub',
    name: 'M19 events',
    slug: resourceSlug,
  })
  await call(page, 'resources.saveConfig', {
    resourceId,
    environmentId,
    config: { identity: 'key' },
    secrets: { serviceAccountKey: IAP_KEY },
  })

  /** A workflow whose live release runs `code` per message of `<topic>-sub`. */
  async function subscribed(
    topic: string,
    code: string,
    trigger: Record<string, unknown> = {},
    waitSeconds = 0,
  ) {
    const slug = `m19-${topic}-${stamp}`
    const flow = await call<{ id: string }>(page, 'workflows.create', { slug, name: slug })
    const definition = (triggers?: object) => ({
      schemaVersion: 1,
      // A durable Wait first makes a run last (code has no timers); a waiting run counts as under way.
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        ...(waitSeconds
          ? [
              {
                name: 'pause',
                type: 'wait',
                config: { kind: 'duration', amount: String(waitSeconds), unit: 'seconds' },
              },
            ]
          : []),
        { name: 'handle', type: 'code', config: { code } },
      ],
      edges: waitSeconds
        ? [
            { from: 'startTrigger', port: 'out', to: 'pause' },
            { from: 'pause', port: 'out', to: 'handle' },
          ]
        : [{ from: 'startTrigger', port: 'out', to: 'handle' }],
      ...(triggers && { triggers }),
    })
    const pubsub = (over: object = {}) => [
      {
        name: topic,
        enabled: true,
        resource: resourceSlug,
        subscription: `${topic}-sub`,
        ...trigger,
        ...over,
      },
    ]
    let revision = 1
    const release = async (triggers: object | undefined) => {
      revision = (
        await call<{ revision: number }>(page, 'workflows.saveDraft', {
          id: flow.id,
          revision,
          definition: definition(triggers),
        })
      ).revision
      await call(page, 'releases.publish', { workflowId: flow.id, draftRevision: revision })
    }
    await release({ pubsub: pubsub() })
    const pulling = async () => {
      const triggers = await call<{ kind: string; queue?: { worker: string | null } }[]>(
        page,
        'workflows.triggers',
        { id: flow.id },
        'query',
      )
      return triggers.find((t) => t.kind === 'pubsub')?.queue?.worker ?? null
    }
    await expect.poll(pulling, { timeout: 30_000 }).not.toBeNull()
    const runs = async () => {
      const text = await (await page.request.get(`/api/v1/workflows/${slug}/runs?limit=100`)).text()
      seen.push(text)
      return (JSON.parse(text).runs as RunView[]).reverse()
    }
    const output = async (runId: string) => {
      const text = await (await page.request.get(`/api/v1/runs/${runId}/blocks/handle`)).text()
      seen.push(text)
      return JSON.parse(text).block.data
    }
    return { flow, slug, runs, output, pulling, release, pubsub }
  }
  const ended = (runs: RunView[]) => runs.filter((r) => ['succeeded', 'failed'].includes(r.status))

  let first: { messageId: string; runs: () => Promise<RunView[]> } | undefined
  await test.step('a run per published message, with its data, attributes and id; each acked', async () => {
    const wf = await subscribed(
      'm19',
      'return { data: startTrigger.data, kind: startTrigger.message.attributes.kind, id: startTrigger.message.messageId }',
    )
    const ids = [
      await fakePubSub.publish('m19', '{"order": 1}', { kind: 'created' }),
      await fakePubSub.publish('m19', '{"order": 2}', { kind: 'paid' }),
      await fakePubSub.publish('m19', 'plain text', { kind: 'note' }),
    ]
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 30_000 }).toBe(3)
    const runs = await wf.runs()
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true)
    const outputs = await Promise.all(runs.map((r) => wf.output(r.id)))
    expect(outputs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))).toEqual([
      { data: { order: 1 }, kind: 'created', id: ids[0] },
      { data: { order: 2 }, kind: 'paid', id: ids[1] },
      { data: 'plain text', kind: 'note', id: ids[2] },
    ])
    await expect
      .poll(async () => (await fakePubSub.messages('m19-sub')).every((m) => m.acked && m.deliveries === 1))
      .toBe(true)
    first = { messageId: ids[0]!, runs: wf.runs }
  })

  await test.step('a redelivery of a message that already succeeded is acked without a run', async () => {
    await fakePubSub.redeliver('m19-sub', first!.messageId)
    await expect
      .poll(async () => (await fakePubSub.messages('m19-sub')).find((m) => m.messageId === first!.messageId))
      .toMatchObject({ deliveries: 2, acked: true })
    expect(await first!.runs()).toHaveLength(3)
  })

  await test.step('a failing run is nacked and redelivered, and succeeds later; one that always fails is dead-lettered', async () => {
    const wf = await subscribed(
      'flaky',
      `if (startTrigger.data.failAlways || startTrigger.message.deliveryAttempt < 2) throw new Error('not yet')
return startTrigger.message.deliveryAttempt`,
    )
    const once = await fakePubSub.publish('flaky', '{}')
    await expect
      .poll(async () => (await fakePubSub.messages('flaky-sub')).find((m) => m.messageId === once)?.acked, {
        timeout: 30_000,
      })
      .toBe(true)
    const runs = (await wf.runs()).filter((r) => r.input.message.messageId === once)
    expect(runs.map((r) => [r.status, r.input.message.deliveryAttempt])).toEqual([
      ['failed', 1],
      ['succeeded', 2],
    ])
    expect(await wf.output(runs[1]!.id)).toBe(2)

    const poison = await fakePubSub.publish('flaky', '{"failAlways": true}')
    await expect
      .poll(async () => (await fakePubSub.published('flaky-dead')).map((m) => m.data), { timeout: 30_000 })
      .toContain('{"failAlways": true}')
    const poisonRuns = (await wf.runs()).filter((r) => r.input.message.messageId === poison)
    expect(poisonRuns.map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
  })

  await test.step("a run longer than the subscription's ack deadline keeps its message", async () => {
    const wf = await subscribed('slow', "return 'done'", {}, 4)
    const id = await fakePubSub.publish('slow', '{}')
    await expect
      .poll(async () => (await fakePubSub.messages('slow-sub')).find((m) => m.messageId === id)?.acked, {
        timeout: 30_000,
      })
      .toBe(true)
    const [run] = await wf.runs()
    expect(run).toMatchObject({ status: 'succeeded' })
    expect(Date.parse(run!.finishedAt!) - Date.parse(run!.startedAt!)).toBeGreaterThanOrEqual(4000)
    // Its deadline is 2 s: held past it, it was never delivered again.
    expect((await fakePubSub.messages('slow-sub')).find((m) => m.messageId === id)?.deliveries).toBe(1)
    expect(await wf.runs()).toHaveLength(1)
  })

  await test.step('the in-flight limit holds: one at a time', async () => {
    const wf = await subscribed('busy', 'return 1', { maxInFlight: 1 }, 1)
    for (let i = 0; i < 3; i++) await fakePubSub.publish('busy', `{"n": ${i}}`)
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 60_000 }).toBe(3)
    const spans = (await wf.runs())
      .map((r) => [Date.parse(r.startedAt!), Date.parse(r.finishedAt!)] as const)
      .sort((a, b) => a[0] - b[0])
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1])
  })

  await test.step('a workflow publishes to a topic, and the trigger on it runs', async () => {
    const listener = await subscribed('chain', 'return startTrigger.data')
    const publisherSlug = `m19-publisher-${stamp}`
    const publisher = await call<{ id: string }>(page, 'workflows.create', {
      slug: publisherSlug,
      name: publisherSlug,
    })
    const saved = await call<{ revision: number }>(page, 'workflows.saveDraft', {
      id: publisher.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'announce',
            type: 'resourceQuery',
            config: {
              resource: resourceSlug,
              query: { topic: 'chain', messages: '{"data": {"from": {{ startTrigger.data.who }}}}' },
            },
          },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'announce' }],
      },
    })
    await call(page, 'releases.publish', { workflowId: publisher.id, draftRevision: saved.revision })
    const started = await page.request.post(`/api/v1/workflows/${publisherSlug}/runs`, {
      data: { version: 'live', input: { who: 'the publisher' } },
    })
    expect(started.status()).toBe(202)
    await expect.poll(async () => ended(await listener.runs()).length, { timeout: 30_000 }).toBe(1)
    const [run] = await listener.runs()
    expect(await listener.output(run!.id)).toEqual({ from: 'the publisher' })
  })

  await test.step('turned off, or dropped by a release, a trigger stops pulling', async () => {
    const wf = await subscribed('paused', 'return 1')
    await wf.release({ pubsub: wf.pubsub({ enabled: false }) })
    await expect.poll(wf.pulling, { timeout: 30_000 }).toBeNull()
    const id = await fakePubSub.publish('paused', '{}')
    await new Promise((r) => setTimeout(r, 3000))
    expect((await fakePubSub.messages('paused-sub')).find((m) => m.messageId === id)?.deliveries).toBe(0)
    await wf.release(undefined)
    expect(await call<unknown[]>(page, 'workflows.triggers', { id: wf.flow.id }, 'query')).toEqual([])
    expect(await wf.runs()).toHaveLength(0)
  })

  await test.step("a non-admin can't save a Pub/Sub resource on the server's identity", async () => {
    const groups = await call<{ id: string; systemKind: string | null }[]>(
      page,
      'groups.list',
      undefined,
      'query',
    )
    const everyone = groups.find((g) => g.systemKind === 'all_users')!
    await call(page, 'permissions.set', {
      objectType: 'resource',
      objectId: resourceId,
      groupId: everyone.id,
      environmentId: null,
      level: 'edit',
    })
    const context = await browser.newContext()
    const member = await context.newPage()
    await signIn(member, E2E_MEMBER_EMAIL)
    const res = await member.request.post('/api/trpc/resources.saveConfig', {
      data: { json: { resourceId, environmentId, config: { identity: 'server', project: 'fake-project' } } },
    })
    seen.push(await res.text())
    expect(res.status()).toBe(403)
    await context.close()
  })

  await test.step('no line of the key in anything the API sent', async () => {
    await call(page, 'resources.get', { id: resourceId }, 'query')
    expect(seen.length).toBeGreaterThan(20)
    for (const body of seen) expect(body).not.toContain(KEY_LINE)
  })
})
