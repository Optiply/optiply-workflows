import { expect, type Page, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { fakeSqs, signIn, testKafka } from './helpers'

/**
 * M26's done-when (architecture.md §2.7, §2.29), through global setup's fake AWS and Kafka container. SQS: a run per
 * message with its body, attributes and id, each deleted once; a failing run's message comes back and succeeds on its
 * second receive, one always failing lands in the dead-letter queue through the redrive policy; a run longer than the
 * visibility timeout is received once; a FIFO group runs in order; the in-flight limit holds; an access key, an assumed
 * role and the server's own credentials sign in, the server's refused to a non-admin; a send query starts a trigger.
 * Kafka: keys `a, a, b` run a's in order with b alongside; a failing message is retried and succeeds on attempt 2, one
 * always failing goes to the dead-letter topic with its `ow-*` headers and its key moves on; SCRAM over TLS and mTLS
 * connect; a produce query starts a trigger. The secret key and password never appear in an API response. Elsewhere: a
 * worker stopped mid-run handing its messages over (packages/engine/test/{sqs,kafka}-consumer.test.ts; one e2e server
 * has one worker), the instance not opted into the server's credentials (apps/server/test/resources.test.ts), MSK IAM
 * against AWS's own signer (packages/connectors/test/kafka-msk-iam.test.ts), and Pub/Sub's done-when, re-run as is.
 */

const kafka = process.env.E2E_KAFKA_SCRAM
  ? (JSON.parse(process.env.E2E_KAFKA_SCRAM) as {
      broker: string
      username: string
      password: string
      ca: string
      clientCertificate: string
      clientKey: string
      mtls: string
    })
  : undefined
const SECRETS = [
  process.env.E2E_AWS_SECRET!,
  ...(kafka ? [kafka.password, kafka.clientKey.split('\n')[3]!] : []),
]

/** Every API response this spec saw, to scan for secrets. */
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
  input: { data: unknown; message: Record<string, unknown> }
  startedAt: string | null
  finishedAt: string | null
}

const ended = (runs: RunView[]) => runs.filter((r) => ['succeeded', 'failed'].includes(r.status))

/** Sets up a resource; returns its slug. */
async function resource(page: Page, type: string, slug: string, config: object, secrets: object = {}) {
  const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
  const { id } = await call<{ id: string }>(page, 'resources.create', { type, name: slug, slug })
  await call(page, 'resources.saveConfig', {
    resourceId: id,
    environmentId: envs.find((e) => e.slug === 'production')!.id,
    config,
    secrets,
  })
  return { id, slug }
}

/** A workflow whose live release runs `code` per message of its trigger (`kind`: sqs or kafka). */
async function triggered(
  page: Page,
  slug: string,
  kind: 'sqs' | 'kafka',
  trigger: Record<string, unknown>,
  code: string,
  waitSeconds = 0,
) {
  const flow = await call<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const saved = await call<{ revision: number }>(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
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
      triggers: { [kind]: [{ name: 'in', enabled: true, ...trigger }] },
    },
  })
  await call(page, 'releases.publish', { workflowId: flow.id, draftRevision: saved.revision })
  await expect
    .poll(
      async () => {
        const triggers = await call<{ kind: string; queue?: { worker: string | null } }[]>(
          page,
          'workflows.triggers',
          { id: flow.id },
          'query',
        )
        return triggers.find((t) => t.kind === kind)?.queue?.worker ?? null
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
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
  return { flow, runs, output }
}

/** Runs' spans, in start order: whether each started after the one before ended. */
const spans = (runs: RunView[]) =>
  runs.map((r) => [Date.parse(r.startedAt!), Date.parse(r.finishedAt!)] as const).sort((a, b) => a[0] - b[0])

test('SQS triggers: a run per message, deleted on success, handed back on failure', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) seen.push(await res.text().catch(() => ''))
  })
  await signIn(page)
  const stamp = Date.now().toString(36)
  const key = { region: 'eu-west-1', identity: 'key', accessKeyId: process.env.E2E_AWS_KEY_ID }
  const queues = await resource(page, 'sqs', `m26_queues_${stamp}`, key, {
    secretAccessKey: process.env.E2E_AWS_SECRET,
  })

  await test.step('a run per message with its body, attributes and id; each deleted once', async () => {
    const wf = await triggered(
      page,
      `m26-sqs-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26' },
      'return { data: startTrigger.data, kind: startTrigger.message.messageAttributes.kind, id: startTrigger.message.messageId }',
    )
    const ids = [
      await fakeSqs.send('m26', '{"order": 1}', { attributes: { kind: 'created' } }),
      await fakeSqs.send('m26', '{"order": 2}', { attributes: { kind: 'paid' } }),
      await fakeSqs.send('m26', 'plain text', { attributes: { kind: 'note' } }),
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
      .poll(async () => (await fakeSqs.messages('m26')).every((m) => m.deleted && m.receiveCount === 1))
      .toBe(true)
  })

  await test.step('a failing run is handed back and succeeds on its second receive; one always failing reaches the DLQ', async () => {
    const wf = await triggered(
      page,
      `m26-sqs-flaky-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26-flaky' },
      `if (startTrigger.data.failAlways || startTrigger.message.receiveCount < 2) throw new Error('not yet')
return startTrigger.message.receiveCount`,
    )
    const once = await fakeSqs.send('m26-flaky', '{}')
    await expect
      .poll(async () => (await fakeSqs.messages('m26-flaky')).find((m) => m.messageId === once)?.deleted, {
        timeout: 30_000,
      })
      .toBe(true)
    const runs = (await wf.runs()).filter((r) => r.input.message.messageId === once)
    expect(runs.map((r) => [r.status, r.input.message.receiveCount])).toEqual([
      ['failed', 1],
      ['succeeded', 2],
    ])
    const poison = await fakeSqs.send('m26-flaky', '{"failAlways": true}')
    await expect
      .poll(async () => (await fakeSqs.messages('m26-dlq')).map((m) => m.body), { timeout: 30_000 })
      .toContain('{"failAlways": true}')
    expect(
      (await wf.runs()).filter((r) => r.input.message.messageId === poison).map((r) => r.status),
    ).toEqual(['failed', 'failed'])
  })

  await test.step('a run longer than the visibility timeout is received once', async () => {
    const wf = await triggered(
      page,
      `m26-sqs-slow-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26-slow' },
      "return 'done'",
      4,
    )
    const id = await fakeSqs.send('m26-slow', '{}')
    await expect
      .poll(async () => (await fakeSqs.messages('m26-slow')).find((m) => m.messageId === id)?.deleted, {
        timeout: 30_000,
      })
      .toBe(true)
    const [run] = await wf.runs()
    expect(Date.parse(run!.finishedAt!) - Date.parse(run!.startedAt!)).toBeGreaterThanOrEqual(4000)
    expect((await fakeSqs.messages('m26-slow')).find((m) => m.messageId === id)?.receiveCount).toBe(1)
    expect(await wf.runs()).toHaveLength(1)
  })

  await test.step('a FIFO group runs in order, one at a time; another group alongside', async () => {
    const wf = await triggered(
      page,
      `m26-sqs-fifo-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26-groups.fifo' },
      'return startTrigger.data',
      1,
    )
    for (const [body, groupId] of [
      ['"a1"', 'a'],
      ['"a2"', 'a'],
      ['"a3"', 'a'],
      ['"b1"', 'b'],
    ] as const)
      await fakeSqs.send('m26-groups.fifo', body, { groupId })
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 60_000 }).toBe(4)
    const runs = await wf.runs()
    const group = (g: string) => runs.filter((r) => String(r.input.data).startsWith(g))
    const a = group('a').sort((x, y) => Date.parse(x.startedAt!) - Date.parse(y.startedAt!))
    expect(a.map((r) => r.input.data)).toEqual(['a1', 'a2', 'a3'])
    const aSpans = spans(a)
    for (let i = 1; i < aSpans.length; i++) expect(aSpans[i]![0]).toBeGreaterThanOrEqual(aSpans[i - 1]![1])
    // b1 didn't wait for group a.
    expect(Date.parse(group('b')[0]!.startedAt!)).toBeLessThan(aSpans[2]![0])
  })

  await test.step('the in-flight limit holds: one at a time', async () => {
    const wf = await triggered(
      page,
      `m26-sqs-busy-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26-busy', maxInFlight: 1 },
      'return 1',
      1,
    )
    for (let i = 0; i < 3; i++) await fakeSqs.send('m26-busy', `{"n": ${i}}`)
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 60_000 }).toBe(3)
    const s = spans(await wf.runs())
    for (let i = 1; i < s.length; i++) expect(s[i]![0]).toBeGreaterThanOrEqual(s[i - 1]![1])
  })

  await test.step('a workflow sends to a queue, and the trigger on it runs', async () => {
    const listener = await triggered(
      page,
      `m26-sqs-listener-${stamp}`,
      'sqs',
      { resource: queues.slug, queue: 'm26-sent' },
      'return startTrigger.data',
    )
    const senderSlug = `m26-sender-${stamp}`
    const sender = await call<{ id: string }>(page, 'workflows.create', {
      slug: senderSlug,
      name: senderSlug,
    })
    const saved = await call<{ revision: number }>(page, 'workflows.saveDraft', {
      id: sender.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'send',
            type: 'resourceQuery',
            config: {
              resource: queues.slug,
              query: { queue: 'm26-sent', messages: '{"body": {"from": {{ startTrigger.data.who }}}}' },
            },
          },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'send' }],
      },
    })
    await call(page, 'releases.publish', { workflowId: sender.id, draftRevision: saved.revision })
    const started = await page.request.post(`/api/v1/workflows/${senderSlug}/runs`, {
      data: { version: 'live', input: { who: 'the sender' } },
    })
    expect(started.status()).toBe(202)
    await expect
      .poll(
        async () => {
          const runs = ended(await listener.runs())
          return runs.length ? listener.output(runs[0]!.id) : null
        },
        { timeout: 30_000 },
      )
      .toEqual({ from: 'the sender' })
  })

  await test.step("an assumed role and the server's own credentials sign in; a non-admin can't choose the server's", async () => {
    const assumed = await resource(
      page,
      'sqs',
      `m26_role_${stamp}`,
      {
        ...key,
        roleArn: process.env.E2E_AWS_ROLE,
        externalId: 'optiply-e2e',
      },
      { secretAccessKey: process.env.E2E_AWS_SECRET },
    )
    const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
    const environmentId = envs.find((e) => e.slug === 'production')!.id
    expect(await call(page, 'resources.test', { resourceId: assumed.id, environmentId })).toMatchObject({
      ok: true,
      message: expect.stringContaining('assumed-role/m26-reader/optiply-workflows'),
    })
    const server = await resource(page, 'sqs', `m26_server_${stamp}`, {
      region: 'eu-west-1',
      identity: 'server',
    })
    expect(await call(page, 'resources.test', { resourceId: server.id, environmentId })).toMatchObject({
      ok: true,
      message: `SQS in eu-west-1 as ${process.env.E2E_AWS_SERVER_ARN}`,
    })
    // A member with Edit on a keyed resource can't switch it to the server's credentials.
    const groups = await call<{ id: string; systemKind: string | null }[]>(
      page,
      'groups.list',
      undefined,
      'query',
    )
    await call(page, 'permissions.set', {
      objectType: 'resource',
      objectId: queues.id,
      groupId: groups.find((g) => g.systemKind === 'all_users')!.id,
      environmentId: null,
      level: 'edit',
    })
    const context = await browser.newContext({ baseURL: page.url() })
    const member = await context.newPage()
    await signIn(member, E2E_MEMBER_EMAIL)
    const refused = await member.request.post('/api/trpc/resources.saveConfig', {
      data: {
        json: { resourceId: queues.id, environmentId, config: { region: 'eu-west-1', identity: 'server' } },
      },
    })
    expect(refused.status()).toBe(403)
    expect(await refused.text()).toContain("Only admins can use this server's own AWS credentials")
    await context.close()
  })

  await test.step('the secret access key never appears in an API response', async () => {
    for (const text of seen) expect(text).not.toContain(SECRETS[0])
  })
})

test('Kafka triggers: in order per key, retried, dead-lettered, and signed in every way', async ({
  page,
}) => {
  test.skip(!kafka, 'needs Docker for a Kafka broker')
  test.setTimeout(240_000)
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) seen.push(await res.text().catch(() => ''))
  })
  await signIn(page)
  const stamp = Date.now().toString(36)
  const cluster = await resource(
    page,
    'kafka',
    `m26_cluster_${stamp}`,
    {
      brokers: [kafka!.broker],
      auth: 'scram-sha-256',
      tls: true,
      username: kafka!.username,
      caCertificate: kafka!.ca,
    },
    { password: kafka!.password },
  )

  await test.step("keys a, a, b: a's run one after the other, in order, b alongside", async () => {
    const wf = await triggered(
      page,
      `m26-kafka-keys-${stamp}`,
      'kafka',
      { resource: cluster.slug, topics: ['m26-keys'], startAt: 'earliest' },
      'return { value: startTrigger.data, key: startTrigger.message.key, offset: startTrigger.message.offset }',
      1,
    )
    await testKafka.produce('m26-keys', '"a1"', 'a')
    await testKafka.produce('m26-keys', '"a2"', 'a')
    await testKafka.produce('m26-keys', '"b1"', 'b')
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 60_000 }).toBe(3)
    const runs = await wf.runs()
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true)
    const byValue = (v: string) => runs.find((r) => r.input.data === v)!
    const [a1, a2, b1] = [byValue('a1'), byValue('a2'), byValue('b1')]
    expect(Date.parse(a2.startedAt!)).toBeGreaterThanOrEqual(Date.parse(a1.finishedAt!))
    expect(Date.parse(b1.startedAt!)).toBeLessThan(Date.parse(a1.finishedAt!))
    expect(await wf.output(a2.id)).toEqual({ value: 'a2', key: 'a', offset: '1' })
  })

  await test.step('a failing message is retried and succeeds on attempt 2; one always failing is dead-lettered and its key moves on', async () => {
    const wf = await triggered(
      page,
      `m26-kafka-retry-${stamp}`,
      'kafka',
      {
        resource: cluster.slug,
        topics: ['m26-retry'],
        startAt: 'earliest',
        maxAttempts: 2,
        retryBackoffSeconds: 1,
        deadLetterTopic: 'm26-retry-dlt',
      },
      `if (startTrigger.data.failAlways || startTrigger.message.attempt < 2) throw new Error('not yet: ' + startTrigger.message.attempt)
return startTrigger.message.attempt`,
    )
    await testKafka.produce('m26-retry', '{"n": 1}', 'k')
    await testKafka.produce('m26-retry', '{"failAlways": true}', 'k', { trace: 't-1' })
    await testKafka.produce('m26-retry', '{"n": 3}', 'k')
    await expect.poll(async () => ended(await wf.runs()).length, { timeout: 60_000 }).toBe(6)
    const runs = await wf.runs()
    expect(runs.map((r) => [JSON.stringify(r.input.data), r.input.message.attempt, r.status])).toEqual([
      ['{"n":1}', 1, 'failed'],
      ['{"n":1}', 2, 'succeeded'],
      ['{"failAlways":true}', 1, 'failed'],
      ['{"failAlways":true}', 2, 'failed'],
      ['{"n":3}', 1, 'failed'],
      ['{"n":3}', 2, 'succeeded'],
    ])
    const [letter] = await testKafka.read('m26-retry-dlt')
    expect(letter).toMatchObject({ key: 'k', value: '{"failAlways": true}' })
    expect(letter!.headers).toMatchObject({
      trace: 't-1',
      'ow-error': 'not yet: 2',
      'ow-source-topic': 'm26-retry',
      'ow-source-partition': '0',
      'ow-source-offset': '1',
      'ow-attempts': '2',
      'ow-run-id': runs[3]!.id,
      'ow-workflow': wf.flow.id,
    })
  })

  await test.step('a workflow produces to a topic, and the trigger on it runs', async () => {
    const listener = await triggered(
      page,
      `m26-kafka-listener-${stamp}`,
      'kafka',
      { resource: cluster.slug, topics: ['m26-takeover'], startAt: 'earliest' },
      'return { data: startTrigger.data, key: startTrigger.message.key }',
    )
    const producerSlug = `m26-producer-${stamp}`
    const producer = await call<{ id: string }>(page, 'workflows.create', {
      slug: producerSlug,
      name: producerSlug,
    })
    const saved = await call<{ revision: number }>(page, 'workflows.saveDraft', {
      id: producer.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          {
            name: 'produce',
            type: 'resourceQuery',
            config: {
              resource: cluster.slug,
              query: {
                topic: 'm26-takeover',
                messages: '{"key": "p-1", "value": {"from": {{ startTrigger.data.who }}}}',
              },
            },
          },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'produce' }],
      },
    })
    await call(page, 'releases.publish', { workflowId: producer.id, draftRevision: saved.revision })
    const started = await page.request.post(`/api/v1/workflows/${producerSlug}/runs`, {
      data: { version: 'live', input: { who: 'the producer' } },
    })
    expect(started.status()).toBe(202)
    await expect
      .poll(
        async () => {
          const runs = ended(await listener.runs())
          return runs.length ? listener.output(runs[0]!.id) : null
        },
        { timeout: 45_000 },
      )
      .toEqual({ data: { from: 'the producer' }, key: 'p-1' })
  })

  await test.step('SCRAM over TLS (above) and a client certificate connect', async () => {
    const mtls = await resource(
      page,
      'kafka',
      `m26_mtls_${stamp}`,
      {
        brokers: [kafka!.mtls],
        auth: 'mtls',
        caCertificate: kafka!.ca,
        clientCertificate: kafka!.clientCertificate,
      },
      { clientKey: kafka!.clientKey },
    )
    const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
    const environmentId = envs.find((e) => e.slug === 'production')!.id
    expect(await call(page, 'resources.test', { resourceId: mtls.id, environmentId })).toMatchObject({
      ok: true,
      message: expect.stringContaining('as client certificate CN=ow-workflows-client'),
    })
    expect(await call(page, 'resources.test', { resourceId: cluster.id, environmentId })).toMatchObject({
      ok: true,
      message: expect.stringContaining(`as ${kafka!.username} (SCRAM-SHA-256 over TLS)`),
    })
  })

  await test.step('the password and the client key never appear in an API response', async () => {
    for (const text of seen) for (const secret of SECRETS) expect(text).not.toContain(secret)
  })
})
