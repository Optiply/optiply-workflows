import { expect, type Page, test } from '@playwright/test'
import { fakeSqs, openRail, signIn, testKafka, trpcMutate, trpcQuery } from './helpers'

// M26 step 5b: SQS and Kafka resources set up in the browser, and their triggers in the editor.
const kafka = process.env.E2E_KAFKA_SCRAM
  ? (JSON.parse(process.env.E2E_KAFKA_SCRAM) as {
      broker: string
      username: string
      password: string
      ca: string
    })
  : undefined

async function production(page: Page): Promise<string> {
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  return envs.find((e) => e.slug === 'production')!.id
}

test('set up an SQS resource with an access key, test it, and send from the playground', async ({ page }) => {
  await signIn(page)
  const slug = `queues_${Date.now().toString(36)}`
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'sqs',
    name: 'Queues',
    slug,
  })
  await page.goto(`/resources/${resource.id}`)

  await test.step('an access key, tested as its user', async () => {
    await expect(page.getByTestId('aws-identity')).toHaveValue('key')
    await page.getByTestId('aws-access-key-id').fill(process.env.E2E_AWS_KEY_ID!)
    await page.getByPlaceholder('wJalrXUtnFEMI/K7MDENG/…').fill(process.env.E2E_AWS_SECRET!)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(
      page.getByText(`Connected · SQS in eu-west-1 as ${process.env.E2E_AWS_USER_ARN}`),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText(process.env.E2E_AWS_SECRET!)
  })

  await test.step("this server's credentials are offered to an admin, with whose they are", async () => {
    await page.getByTestId('aws-identity').selectOption('server')
    await expect(page.getByTestId('aws-server-note')).toContainText(
      `Signs in as ${process.env.E2E_AWS_SERVER_ARN}`,
    )
    await expect(page.getByTestId('aws-access-key-id')).toHaveCount(0)
    await page.getByTestId('aws-identity').selectOption('key')
  })

  await test.step('the playground sends to a queue by name', async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByLabel(/^Queue/).fill('m26-sent')
    await page
      .getByLabel(/^Messages/)
      .fill('{"body": {"from": "the playground"}, "attributes": {"by": "e2e"}}')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('messageId')).toBeVisible()
    await expect
      .poll(async () => (await fakeSqs.messages('m26-sent')).map((m) => m.body))
      .toContain('{"from":"the playground"}')
  })
})

test('set up a Kafka resource with SCRAM over TLS, test it, and produce from the playground', async ({
  page,
}) => {
  test.skip(!kafka, 'needs Docker for a Kafka broker')
  await signIn(page)
  const slug = `cluster_${Date.now().toString(36)}`
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'kafka',
    name: 'Cluster',
    slug,
  })
  await page.goto(`/resources/${resource.id}`)

  await test.step('brokers, SCRAM-SHA-256 over TLS with the cluster CA, tested as its user', async () => {
    await page.getByTestId('kafka-brokers').fill(kafka!.broker)
    await page.getByTestId('kafka-auth').selectOption('scram-sha-256')
    await page.getByRole('checkbox', { name: /^TLS/ }).check()
    await page.getByTestId('kafka-username').fill(kafka!.username)
    await page.getByLabel(/^Password/).fill(kafka!.password)
    await page.getByTestId('kafka-ca').fill(kafka!.ca)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText(`as ${kafka!.username} (SCRAM-SHA-256 over TLS)`)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.locator('body')).not.toContainText(kafka!.password)
  })

  await test.step('the playground produces to a topic', async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByLabel(/^Topic/).fill('m26-produced')
    await page.getByLabel(/^Messages/).fill('{"key": "k-1", "value": {"from": "the playground"}}')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('baseOffset')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await testKafka.read('m26-produced')).map((m) => m.value))
      .toContain('{"from":"the playground"}')
  })
})

/** A workflow whose code block reads its message; returns it, published from the editor once its trigger is set. */
async function triggeredWorkflow(page: Page, name: string, code: string) {
  const slug = `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now().toString(36)}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'seen', type: 'code', config: { code } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'seen' }],
    },
  })
  return flow
}

async function publishFromEditor(page: Page, workflowId: string) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const draft = await trpcQuery<{ draftRevision: number }>(page, 'workflows.get', { id: workflowId })
  await trpcMutate(page, 'releases.publish', { workflowId, draftRevision: draft.draftRevision })
}

test('an SQS trigger runs the workflow per message; the editor and run pages show it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'sqs',
    name: 'Order queues',
    slug: `order_queues_${stamp}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: await production(page),
    config: { region: 'eu-west-1', identity: 'key', accessKeyId: process.env.E2E_AWS_KEY_ID },
    secrets: { secretAccessKey: process.env.E2E_AWS_SECRET },
  })
  const flow = await triggeredWorkflow(
    page,
    'On orders',
    'return { order: startTrigger.data.order, kind: startTrigger.message.messageAttributes.kind }',
  )
  await page.goto(`/workflows/${flow.id}`)

  await test.step('set up in the start block: the resource and its queue', async () => {
    await openRail(page, 'triggers')
    await page.getByTestId('sqs-triggers').getByRole('button', { name: 'Add' }).click()
    const card = page.getByTestId('sqs-queue-1')
    await card.getByRole('combobox', { name: 'Resource' }).selectOption(`order_queues_${stamp}`)
    await card.getByTestId('sqs-queue').fill('orders')
    await expect(card.getByTestId('sqs-state')).toContainText('Receives once you publish.')
    await publishFromEditor(page, flow.id)
    await expect(page.getByTestId('sqs-state')).toContainText('receiving', { timeout: 30_000 })
  })

  await test.step('a message runs it, is deleted, and is counted; the run pages name it', async () => {
    const messageId = await fakeSqs.send('orders', '{"order": 7}', { attributes: { kind: 'created' } })
    await expect
      .poll(async () => (await fakeSqs.messages('orders')).find((m) => m.messageId === messageId)?.deleted, {
        timeout: 30_000,
      })
      .toBe(true)
    await expect(page.getByTestId('sqs-state')).toContainText('last day: 1 message, 0 failed', {
      timeout: 15_000,
    })
    await page.goto('/runs')
    const row = page.getByRole('row').filter({ hasText: 'On orders' }).first()
    await expect(row).toContainText(`sqs · SQS message ${messageId} · orders`)
    await row.getByRole('link', { name: 'On orders' }).click()
    await expect(page.getByTestId('run-queue')).toContainText(`SQS message ${messageId} · orders`)
  })
})

test('a Kafka trigger runs the workflow per message; the editor and run pages show it', async ({ page }) => {
  test.skip(!kafka, 'needs Docker for a Kafka broker')
  test.setTimeout(120_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'kafka',
    name: 'Event cluster',
    slug: `event_cluster_${stamp}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: await production(page),
    config: { brokers: [process.env.E2E_KAFKA], auth: 'none' },
  })
  const flow = await triggeredWorkflow(
    page,
    'On events',
    'return { n: startTrigger.data.n, key: startTrigger.message.key }',
  )
  await page.goto(`/workflows/${flow.id}`)

  await test.step('set up in the start block: the resource, its topic, retries and a dead-letter topic', async () => {
    await openRail(page, 'triggers')
    await page.getByTestId('kafka-triggers').getByRole('button', { name: 'Add' }).click()
    const card = page.getByTestId('kafka-topic-1')
    await card.getByRole('combobox', { name: 'Resource' }).selectOption(`event_cluster_${stamp}`)
    await card.getByTestId('kafka-topics').fill('kafka-ui')
    await card.getByRole('combobox', { name: /starts at/ }).selectOption('earliest')
    await card.getByTestId('kafka-maxAttempts').fill('2')
    // A dead-letter topic it reads is refused.
    await card.getByTestId('kafka-deadLetterTopic').fill('kafka-ui')
    await expect(card).toContainText("the dead-letter topic can't be one it reads")
    await card.getByTestId('kafka-deadLetterTopic').fill('kafka-ui.dlt')
    await expect(card).not.toContainText("the dead-letter topic can't be one it reads")
    await publishFromEditor(page, flow.id)
    await expect(page.getByTestId('kafka-state')).toContainText('consuming', { timeout: 30_000 })
  })

  await test.step('a message runs it and is counted; the run pages name its topic, partition, offset and key', async () => {
    await testKafka.produce('kafka-ui', '{"n": 7}', 'order-7')
    await expect(page.getByTestId('kafka-state')).toContainText('last day: 1 message, 0 failed', {
      timeout: 45_000,
    })
    await page.goto('/runs')
    const row = page.getByRole('row').filter({ hasText: 'On events' }).first()
    await expect(row).toContainText('kafka · Kafka kafka-ui/0@0 · key order-7')
    await row.getByRole('link', { name: 'On events' }).click()
    await expect(page.getByTestId('run-queue')).toContainText('Kafka kafka-ui/0@0 · key order-7')
  })
})
