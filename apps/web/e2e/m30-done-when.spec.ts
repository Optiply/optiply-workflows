import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

// M30's done-when, as far as it outlives session 54 (architecture.md, the M30 row): a webhook with the Amazon SNS
// signature preset, against the fake AWS's SNS. Its subscription is confirmed first, without a run; then each message
// published to the topic is delivered as a signed notification and starts a run. (Kafka, RabbitMQ, Kinesis and the
// SNS resource were removed in session 54; the fake publishes to the topic itself.)

const control = process.env.E2E_IAP_CONTROL!
const m30 = JSON.parse(process.env.E2E_M30!) as { topicArn: string }

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

/** The workflow's runs, newest first. */
async function runsOf(page: Page, slug: string) {
  const res = await page.request.get(`/api/v1/workflows/${slug}/runs`)
  return (await res.json()).runs as { status: string; triggerType: string; input: { data: unknown } }[]
}

const seen = { name: 'seen', type: 'code', config: { code: 'return startTrigger.data' } }

test('SNS webhook: its subscription is confirmed without a run, and each published message runs it', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000)
  await signIn(page)
  const stamp = Date.now().toString(36)
  const hook = `m30-sns-hook-${stamp}`
  const endpoint = `${baseURL}/api/v1/workflows/${hook}/webhook`
  const params = new URLSearchParams({ topicArn: m30.topicArn, endpoint })

  await test.step('an SNS webhook: its subscription confirmed without a run', async () => {
    const id = await workflow(page, hook, [seen], {
      webhook: {
        enabled: true,
        auth: { type: 'signature', preset: 'sns', secret: '', topicArns: [m30.topicArn] },
      },
    })
    await publish(page, id)
    expect((await fetch(`${control}/sns/subscribe?${params}`, { method: 'POST' })).ok).toBe(true)
    await expect
      .poll(async () => (await fetch(`${control}/sns/confirmed?${params}`)).json(), { timeout: 15_000 })
      .toBe(true)
    expect(await runsOf(page, hook)).toHaveLength(0)
  })

  await test.step('a message published to the topic runs the workflow with it', async () => {
    const publishParams = new URLSearchParams({
      topicArn: m30.topicArn,
      message: JSON.stringify({ order: 42 }),
      subject: 'New order',
    })
    expect((await fetch(`${control}/sns/publish?${publishParams}`, { method: 'POST' })).ok).toBe(true)
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
  })
})
