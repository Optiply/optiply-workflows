import { expect, test } from '@playwright/test'
import { addBlock, block, fakePubSub, field, signIn, trpcMutate, typeInto } from './helpers'

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
