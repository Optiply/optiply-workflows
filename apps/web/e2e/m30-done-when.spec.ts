import { expect, type Page, test } from '@playwright/test'
import { openRail, signIn, trpcMutate, trpcQuery } from './helpers'

// M30's done-when (architecture.md, the M30 row): RabbitMQ and Kafka (with a Schema Registry) in Docker, SNS and
// Kinesis against the fake AWS. A workflow publishes to each, and each delivery starts a run of the workflow listening
// there: an SNS webhook (its subscription confirmed first), a Kinesis stream trigger, a RabbitMQ queue trigger, and a
// Kafka trigger decoding Avro. The RabbitMQ and Kafka resources are made in the UI, the triggers set in the editor.

const control = process.env.E2E_IAP_CONTROL!
const m30 = JSON.parse(process.env.E2E_M30!) as {
  topicArn: string
  registry: { url: string; username: string; password: string; avroSchemaId: number }
}
const rabbit = process.env.E2E_RABBIT
  ? (JSON.parse(process.env.E2E_RABBIT) as { host: string; port: number; username: string; password: string })
  : undefined
const kafka = process.env.E2E_KAFKA

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

async function resourceOf(page: Page, type: string, slug: string, config: unknown, secrets: unknown) {
  const created = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type,
    name: `Test ${slug}`,
    slug,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: created.id,
    environmentId: await production(page),
    config,
    secrets,
  })
}

const query = (name: string, resource: string, q: object) => ({
  name,
  type: 'resourceQuery',
  config: { resource, query: q },
})

/** A workflow of blocks run one after another; triggers as given. */
async function workflow(page: Page, slug: string, blocks: object[], triggers?: object) {
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const names = ['startTrigger', ...blocks.map((b) => (b as { name: string }).name)]
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges: names.slice(1).map((to, i) => ({ from: names[i], port: 'out', to })),
      ...(triggers && { triggers }),
    },
  })
  return flow.id
}

async function publish(page: Page, workflowId: string) {
  const draft = await trpcQuery<{ draftRevision: number }>(page, 'workflows.get', { id: workflowId })
  await trpcMutate(page, 'releases.publish', { workflowId, draftRevision: draft.draftRevision })
}

/** Sets a queue trigger in the editor's Triggers panel, then publishes. */
async function triggerInEditor(
  page: Page,
  workflowId: string,
  kind: 'rabbitmq' | 'kinesis',
  resource: string,
  fill: (card: ReturnType<Page['getByTestId']>) => Promise<void>,
) {
  await page.goto(`/workflows/${workflowId}`)
  await openRail(page, 'triggers')
  await page.getByTestId(`${kind}-triggers`).getByRole('button', { name: 'Add' }).click()
  const card = page.getByTestId(kind === 'rabbitmq' ? 'rabbitmq-queue-1' : 'kinesis-stream-1')
  await card.getByRole('combobox', { name: 'Resource' }).selectOption(resource)
  await fill(card)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await publish(page, workflowId)
  await expect(page.getByTestId(`${kind}-state`)).toContainText(
    kind === 'rabbitmq' ? 'consuming' : 'reading',
    { timeout: 30_000 },
  )
}

/** The workflow's runs, newest first. */
async function runsOf(page: Page, slug: string) {
  const res = await page.request.get(`/api/v1/workflows/${slug}/runs`)
  return (await res.json()).runs as {
    status: string
    triggerType: string
    input: { data: unknown; message?: Record<string, unknown> }
  }[]
}

/** Runs a workflow's draft with an input, and returns its reply once it has succeeded. */
async function runDraft(page: Page, slug: string, input: unknown) {
  const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, {
    data: { input, version: 'draft' },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run.id as string
  let run: { status: string; response: { body: unknown } | null; error: unknown } | undefined
  await expect
    .poll(
      async () => {
        run = (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).run
        return run!.status
      },
      { timeout: 60_000 },
    )
    .toMatch(/succeeded|failed/)
  expect(run!.error).toBeNull()
  return run!.response!.body as Record<string, unknown>
}

const seen = { name: 'seen', type: 'code', config: { code: 'return startTrigger.data' } }

test('SNS and Kinesis: one workflow publishes and puts; a webhook and a stream trigger each run per message', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const aws = {
    region: m30.topicArn.split(':')[3],
    identity: 'key',
    accessKeyId: process.env.E2E_AWS_KEY_ID,
  }
  const awsSecrets = { secretAccessKey: process.env.E2E_AWS_SECRET }
  await resourceOf(page, 'sns', `m30_sns_${stamp}`, aws, awsSecrets)
  await resourceOf(page, 'kinesis', `m30_streams_${stamp}`, aws, awsSecrets)
  const hook = `m30-sns-hook-${stamp}`
  const endpoint = `${baseURL}/api/v1/workflows/${hook}/webhook`

  await test.step('an SNS webhook: its subscription confirmed without a run', async () => {
    const id = await workflow(page, hook, [seen], {
      webhook: {
        enabled: true,
        auth: { type: 'signature', preset: 'sns', secret: '', topicArns: [m30.topicArn] },
      },
    })
    await publish(page, id)
    const params = new URLSearchParams({ topicArn: m30.topicArn, endpoint })
    expect((await fetch(`${control}/sns/subscribe?${params}`, { method: 'POST' })).ok).toBe(true)
    await expect
      .poll(async () => (await fetch(`${control}/sns/confirmed?${params}`)).json(), { timeout: 15_000 })
      .toBe(true)
    expect(await runsOf(page, hook)).toHaveLength(0)
  })

  const reader = `m30-clicks-${stamp}`
  await test.step('a Kinesis trigger set in the editor, from the oldest record kept', async () => {
    const id = await workflow(page, reader, [seen])
    await triggerInEditor(page, id, 'kinesis', `m30_streams_${stamp}`, async (card) => {
      await card.getByTestId('kinesis-stream').fill('m30-clicks')
      await card.getByRole('combobox', { name: /starts at/ }).selectOption('trimHorizon')
    })
  })

  await test.step('one workflow publishes to the topic and puts into the stream; each delivery runs', async () => {
    const writer = `m30-aws-out-${stamp}`
    await workflow(page, writer, [
      query('notify', `m30_sns_${stamp}`, {
        action: 'publish',
        topicArn: m30.topicArn,
        messages: '{"message": {"order": {{ startTrigger.data.order }}}, "subject": "New order"}',
      }),
      query('put', `m30_streams_${stamp}`, {
        action: 'putRecords',
        stream: 'm30-clicks',
        records:
          '{"data": {"order": {{ startTrigger.data.order }}}, "partitionKey": "order-{{ startTrigger.data.order }}"}',
      }),
      {
        name: 'reply',
        type: 'response',
        config: {
          status: '200',
          body: '{{ ({ notified: notify.data.length, put: put.data.length }) }}',
        },
      },
    ])
    expect(await runDraft(page, writer, { order: 42 })).toEqual({ notified: 1, put: 1 })

    await expect
      .poll(async () => (await runsOf(page, hook)).map((r) => r.status), { timeout: 30_000 })
      .toEqual(['succeeded'])
    const [notified] = await runsOf(page, hook)
    expect(notified!.triggerType).toBe('webhook')
    expect(notified!.input.data).toMatchObject({
      message: { order: 42 },
      subject: 'New order',
      topicArn: m30.topicArn,
    })

    await expect
      .poll(async () => (await runsOf(page, reader)).map((r) => r.status), { timeout: 45_000 })
      .toEqual(['succeeded'])
    const [read] = await runsOf(page, reader)
    expect(read).toMatchObject({
      triggerType: 'kinesis',
      input: { data: { order: 42 }, message: { stream: 'm30-clicks', partitionKey: 'order-42', attempt: 1 } },
    })
  })

  await test.step('the runs page names the record', async () => {
    await page.goto('/runs')
    const row = page.getByRole('row').filter({ hasText: reader }).first()
    await expect(row).toContainText('kinesis · Kinesis m30-clicks/shardId-')
  })
})

test('RabbitMQ and Kafka with a Schema Registry: resources made in the UI; publishes and Avro run per message', async ({
  page,
}) => {
  test.skip(!rabbit || !kafka, 'needs Docker for RabbitMQ and Kafka')
  test.setTimeout(180_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const broker = `broker_${stamp}`
  const cluster = `cluster_${stamp}`

  await test.step('a RabbitMQ resource made, saved and tested in the UI', async () => {
    await page.goto('/resources')
    await page.getByRole('button', { name: 'New resource' }).click()
    await page.getByRole('combobox', { name: 'Type' }).selectOption('rabbitmq')
    await page.getByLabel('Name').fill(`Broker ${stamp}`)
    await page.getByLabel('Slug').fill(broker)
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByTestId('rabbit-host').fill(rabbit!.host)
    await page.getByTestId('rabbit-port').fill(String(rabbit!.port))
    await page.getByTestId('rabbit-username').fill(rabbit!.username)
    await page.getByPlaceholder('Not set').fill(rabbit!.password)
    await page.getByText('Allow a private network address', { exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText(/RabbitMQ \d+\.\d+\.\d+ at /)).toBeVisible()
  })

  await test.step('a Kafka resource with its Schema Registry, in the UI', async () => {
    await page.goto('/resources')
    await page.getByRole('button', { name: 'New resource' }).click()
    await page.getByRole('combobox', { name: 'Type' }).selectOption('kafka')
    await page.getByLabel('Name').fill(`Cluster ${stamp}`)
    await page.getByLabel('Slug').fill(cluster)
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByTestId('kafka-brokers').fill(kafka!)
    await page.getByTestId('kafka-registry-url').fill(m30.registry.url)
    await page.getByTestId('kafka-registry-username').fill(m30.registry.username)
    // A username without its password is refused on saving.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText("Add the schema registry's password")).toBeVisible()
    await page.getByPlaceholder('Not set').fill(m30.registry.password)
    await page.getByText('Allow a private network address', { exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  })

  const jobs = `m30-jobs-${stamp}`
  const orders = `m30-avro-${stamp}`
  await test.step('a RabbitMQ trigger set in the editor; a Kafka trigger reading from the start', async () => {
    const id = await workflow(page, jobs, [seen])
    await triggerInEditor(page, id, 'rabbitmq', broker, async (card) => {
      await card.getByTestId('rabbitmq-queue').fill('m30-jobs')
    })
    const kafkaId = await workflow(page, orders, [seen], {
      kafka: [
        { name: 'orders', enabled: true, resource: cluster, topics: ['m30-avro'], startAt: 'earliest' },
      ],
    })
    await publish(page, kafkaId)
  })

  await test.step('one workflow publishes to the queue and produces Avro by subject; each message runs', async () => {
    const writer = `m30-out-${stamp}`
    await workflow(page, writer, [
      query('job', broker, {
        action: 'publish',
        exchange: '',
        routingKey: 'm30-jobs',
        messages:
          '{"body": {"order": {{ startTrigger.data.order }}}, "messageId": "order-{{ startTrigger.data.order }}"}',
      }),
      query('event', cluster, {
        topic: 'm30-avro',
        messages:
          '{"key": "order-{{ startTrigger.data.order }}", "subject": "m30-avro-value", "value": {"id": {{ startTrigger.data.order }}, "sku": "A-{{ startTrigger.data.order }}"}}',
      }),
      {
        name: 'reply',
        type: 'response',
        config: { status: '200', body: '{{ ({ published: job.data.published }) }}' },
      },
    ])
    expect(await runDraft(page, writer, { order: 7 })).toEqual({ published: 1 })

    await expect
      .poll(async () => (await runsOf(page, jobs)).map((r) => r.status), { timeout: 30_000 })
      .toEqual(['succeeded'])
    expect((await runsOf(page, jobs))[0]).toMatchObject({
      triggerType: 'rabbitmq',
      input: { data: { order: 7 }, message: { queue: 'm30-jobs', messageId: 'order-7', redelivered: false } },
    })
    // Acked: nothing left in the queue, nothing dead-lettered.
    await expect
      .poll(async () => {
        const left = await (await fetch(`${control}/rabbit/drain?queue=m30-jobs`)).json()
        const dead = await (await fetch(`${control}/rabbit/drain?queue=m30-jobs-dead`)).json()
        return left.length + dead.length
      })
      .toBe(0)

    await expect
      .poll(async () => (await runsOf(page, orders)).map((r) => r.status), { timeout: 45_000 })
      .toEqual(['succeeded'])
    expect((await runsOf(page, orders))[0]).toMatchObject({
      triggerType: 'kafka',
      input: {
        data: { id: 7, sku: 'A-7' },
        message: { key: 'order-7', schemaId: m30.registry.avroSchemaId },
      },
    })
  })

  await test.step('the runs page names the message and the schema', async () => {
    await page.goto('/runs')
    await expect(page.getByRole('row').filter({ hasText: jobs }).first()).toContainText(
      'rabbitmq · RabbitMQ message order-7 · m30-jobs',
    )
    await expect(page.getByRole('row').filter({ hasText: orders }).first()).toContainText(
      `kafka · Kafka m30-avro/0@0 · key order-7 · schema ${m30.registry.avroSchemaId}`,
    )
  })
})
