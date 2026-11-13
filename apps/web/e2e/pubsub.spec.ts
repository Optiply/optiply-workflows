import { expect, test } from '@playwright/test'
import {
  addBlock,
  block,
  fakePubSub,
  field,
  openRail,
  signIn,
  trpcMutate,
  trpcQuery,
  typeInto,
} from './helpers'

const KEY_EMAIL = 'tunnel@fake-project.iam.gserviceaccount.com'

/** M19 step 5a: a Pub/Sub resource's settings, Test connection, the playground's publish, a workflow's query. */
test('set up a Pub/Sub resource, publish from the playground and from a workflow query', async ({ page }) => {
  await signIn(page)
  const slug = `events_${Date.now().toString(36)}`
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'pubsub',
    name: 'Events',
    slug,
  })
  await page.goto(`/resources/${resource.id}`)

  await test.step('a key, tested as its account in its project', async () => {
    await expect(page.getByTestId('pubsub-identity')).toHaveValue('key')
    await expect(page.getByLabel(/^Host/)).toHaveCount(0)
    await page.getByPlaceholder('{ "type": "service_account", … }').fill(process.env.E2E_IAP_KEY!)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText(`Connected · Pub/Sub project fake-project as ${KEY_EMAIL}`)).toBeVisible()
    await expect(page.locator('body')).not.toContainText('PRIVATE KEY')
  })

  await test.step("the server's identity is offered to an admin, with whose it is", async () => {
    await page.getByTestId('pubsub-identity').selectOption('server')
    await expect(page.getByTestId('pubsub-server-note')).toContainText('Signs in as')
    await expect(page.getByPlaceholder('{ "type": "service_account", … }')).toHaveCount(0)
    await page.getByTestId('pubsub-identity').selectOption('key')
  })

  await test.step('the playground publishes to a topic', async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByLabel(/^Topic/).fill('orders')
    await page
      .getByLabel(/^Messages/)
      .fill('{"data": {"from": "the playground"}, "attributes": {"by": "e2e"}}')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('messageId')).toBeVisible()
    await expect
      .poll(async () => (await fakePubSub.published('orders')).map((m) => m.data))
      .toContain('{"from":"the playground"}')
  })

  await test.step('a workflow query on it is a publish: topic and messages', async () => {
    const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
      slug: `publishes-${Date.now().toString(36)}`,
      name: 'Publishes',
    })
    await page.goto(`/workflows/${flow.id}`)
    await block(page, 'startTrigger').click()
    await addBlock(page, 'resource query')
    await expect(block(page, 'query1')).toBeVisible()
    // From a SQL resource to the Pub/Sub one: the query starts afresh as a publish.
    const resourceSelect = page.getByRole('combobox', { name: 'Resource', exact: true })
    await resourceSelect.selectOption('shop_db')
    await expect(field(page, 'query1', 'query.sql')).toBeVisible()
    await resourceSelect.selectOption(slug)
    await expect(page.getByLabel(/^Topic/)).toHaveValue('')
    await expect(field(page, 'query1', 'messages')).toContainText('{"data": {}}')
    await page.getByLabel(/^Topic/).fill('orders')
    await typeInto(page, field(page, 'query1', 'messages'), '{"data": {{ startTrigger.data }}}')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  })
})

/** M19 step 5b: a Pub/Sub trigger set up in the editor; a published message runs the live release, and shows it. */
test('a Pub/Sub trigger runs the workflow per message, and the editor and run pages show it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const resourceSlug = `refunds_${stamp}`
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'pubsub',
    name: 'Refund events',
    slug: resourceSlug,
  })
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: envs.find((e) => e.slug === 'production')!.id,
    config: { identity: 'key' },
    secrets: { serviceAccountKey: process.env.E2E_IAP_KEY! },
  })
  const slug = `on-refunds-${stamp}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: 'On refunds' })
  const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        {
          name: 'seen',
          type: 'code',
          config: {
            code: 'return { amount: startTrigger.data.amount, kind: startTrigger.message.attributes.kind }',
          },
        },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'seen' }],
    },
  })
  await page.goto(`/workflows/${flow.id}`)

  await test.step('the trigger is set up in the start block: a Pub/Sub resource and its subscription', async () => {
    await openRail(page, 'triggers')
    const section = page.getByTestId('pubsub-triggers')
    await section.getByRole('button', { name: 'Add' }).click()
    const card = page.getByTestId('pubsub-subscription-1')
    await card.getByRole('combobox', { name: 'Resource' }).selectOption(resourceSlug)
    await card.getByPlaceholder('orders-workflow').fill('refunds-sub')
    await expect(card.getByTestId('pubsub-state')).toContainText('Pulls once you publish.')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  })

  await test.step('published: a worker pulls it', async () => {
    const draft = await trpcQuery<{ draftRevision: number }>(page, 'workflows.get', { id: flow.id })
    expect(draft.draftRevision).toBeGreaterThan(saved.revision)
    await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: draft.draftRevision })
    await expect(page.getByTestId('pubsub-state')).toContainText('pulling', { timeout: 30_000 })
  })

  await test.step('a published message runs it, is acked, and is counted', async () => {
    const messageId = await fakePubSub.publish('refunds', '{"amount": 12.5}', { kind: 'refund' })
    await expect
      .poll(
        async () => (await fakePubSub.messages('refunds-sub')).find((m) => m.messageId === messageId)?.acked,
        {
          timeout: 30_000,
        },
      )
      .toBe(true)
    await expect(page.getByTestId('pubsub-state')).toContainText('last day: 1 message, 0 failed', {
      timeout: 15_000,
    })

    await page.goto('/runs')
    const row = page.getByRole('row').filter({ hasText: 'On refunds' }).first()
    await expect(row).toContainText(`pubsub · message ${messageId}`)
    await row.getByRole('link', { name: 'On refunds' }).click()
    await expect(page.getByTestId('run-pubsub')).toContainText(`Pub/Sub message ${messageId} · refunds-sub`)
  })
})
