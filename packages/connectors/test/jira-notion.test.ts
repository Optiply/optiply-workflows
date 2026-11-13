import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  jiraConnector,
  notionConnector,
  PoolManager,
  runQuery,
  testResource,
} from '../src'
import { adf, flatIssue } from '../src/services/jira'
import { flatPage, notionBlocks, notionId, notionProperties, plainProperty } from '../src/services/notion'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// Jira and Notion (M29 step 3) against their fakes.
let fake: FakeServices
let pool: PoolManager

beforeAll(async () => {
  fake = await startFakeServices()
  configureServiceUrls(fake.urls)
  pool = new PoolManager()
})
afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
  configureServiceUrls({})
})

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected a failure')
}

describe('jira', () => {
  const cloud = (token = fake.jira.apiToken) =>
    resource(
      {
        siteUrl: fake.urls.jiraCloud,
        deployment: 'cloud',
        email: fake.jira.email,
        allowPrivateNetwork: true,
      },
      { token },
      `c:${token}`,
    )
  const dc = () =>
    resource(
      { siteUrl: fake.urls.jiraDataCenter, deployment: 'datacenter', allowPrivateNetwork: true },
      { token: fake.jira.pat },
      'dc',
    )
  const run = (r: ReturnType<typeof cloud>, query: object, scope: Record<string, unknown> = {}) =>
    runQuery(pool, jiraConnector, r, query, { evaluate: scopeEvaluator(scope) })

  it('turns plain text into an Atlassian Document', () => {
    expect(adf('First line\nsecond\n\nNew paragraph')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'First line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph' }] },
      ],
    })
    const doc = { type: 'doc', version: 1, content: [] }
    expect(adf(doc)).toBe(doc)
    expect(flatIssue({ id: '1', key: 'OPS-1', fields: { summary: 'x' } })).toEqual({
      id: '1',
      key: 'OPS-1',
      summary: 'x',
    })
  })

  it('tests Cloud with an email and API token and Data Center with a PAT, and refuses a wrong token', async () => {
    expect(await testResource(jiraConnector, cloud())).toMatchObject({
      ok: true,
      message: 'Jira Cloud as Ops Bot',
    })
    expect(await testResource(jiraConnector, dc())).toMatchObject({
      ok: true,
      message: 'Jira Data Center as Ops Bot',
    })
    expect(await testResource(jiraConnector, cloud('wrong'))).toMatchObject({ ok: false })
    // Without private network allowed, a site on this machine is refused.
    const blocked = resource(
      { siteUrl: fake.urls.jiraCloud, email: fake.jira.email },
      { token: fake.jira.apiToken },
      'blocked',
    )
    expect(await testResource(jiraConnector, blocked)).toMatchObject({ ok: false })
  })

  it('creates, searches (paged), reads, updates, moves, comments on and assigns issues on Cloud', async () => {
    const r = cloud()
    for (let i = 1; i <= 7; i++)
      await run(
        r,
        {
          action: 'createIssue',
          project: 'OPS',
          issueType: 'Task',
          summary: `Restock ${i}`,
          description: 'Check {{ sku }}\n\nThen order.',
          fields: '{"labels": ["stock"]}',
        },
        { sku: `SKU-${i}` },
      )
    expect(fake.jira.issues.get('OPS-1')?.fields.description).toEqual(adf('Check SKU-1\n\nThen order.'))

    const found = await run(r, { action: 'search', jql: 'project = OPS ORDER BY created DESC', max: '250' })
    expect((found.data as unknown[]).length).toBe(7)
    const paged = await run(r, { action: 'search', jql: 'project = OPS', fieldList: 'summary', max: '5' })
    expect(paged.data).toHaveLength(5)
    expect((paged.data as Record<string, unknown>[])[0]).toEqual({
      id: expect.any(String),
      key: 'OPS-7',
      summary: 'Restock 7',
    })
    expect(paged.metadata).toMatchObject({ more: true })

    await run(r, {
      action: 'updateIssue',
      issue: 'OPS-1',
      summary: 'Restock 1 (urgent)',
      fields: '{"priority": {"name": "High"}}',
    })
    expect(
      (await run(r, { action: 'getIssue', issue: 'OPS-1', fieldList: 'summary,priority' })).data,
    ).toEqual({
      id: expect.any(String),
      key: 'OPS-1',
      summary: 'Restock 1 (urgent)',
      priority: { name: 'High' },
    })
    expect(
      (await run(r, { action: 'transition', issue: 'OPS-1', transition: 'start work', comment: 'On it' }))
        .data,
    ).toEqual({
      issue: 'OPS-1',
      transition: 'Start work',
      to: 'In Progress',
    })
    // By the status it leads to, too.
    await run(r, { action: 'transition', issue: 'OPS-1', transition: 'Done' })
    expect(fake.jira.issues.get('OPS-1')?.fields.status).toEqual({ name: 'Done' })
    expect(
      (await failure(run(r, { action: 'transition', issue: 'OPS-1', transition: 'Start work' }))).message,
    ).toBe('No transition "Start work" from the issue\'s status; available: Reopen')
    await run(r, { action: 'addComment', issue: 'OPS-2', body: 'Ordered {{ n }} pallets' }, { n: 3 })
    expect(fake.jira.issues.get('OPS-2')?.comments.at(-1)).toEqual(adf('Ordered 3 pallets'))
    await run(r, { action: 'assign', issue: 'OPS-2', assignee: 'acc-9' })
    expect(fake.jira.issues.get('OPS-2')?.fields.assignee).toEqual({ accountId: 'acc-9' })
    const open = await run(r, { action: 'search', jql: 'project = OPS AND statusCategory != Done' })
    expect((open.data as unknown[]).length).toBe(6)
  })

  it('uses v2 with text descriptions on Data Center, and explains Jira’s errors', async () => {
    const r = dc()
    const made = await run(r, {
      action: 'createIssue',
      project: 'OPS',
      issueType: 'Bug',
      summary: 'On DC',
      description: 'Plain',
    })
    const key = (made.data as { key: string }).key
    expect(fake.jira.issues.get(key)?.fields.description).toBe('Plain')
    // An object as a Data Center description is written as JSON, not "[object Object]".
    const noted = await run(
      r,
      {
        action: 'createIssue',
        project: 'OPS',
        issueType: 'Bug',
        summary: 'Object',
        description: '{{ note }}',
      },
      { note: { sku: 'A-1', qty: 2 } },
    )
    expect(fake.jira.issues.get((noted.data as { key: string }).key)?.fields.description).toBe(
      '{\n  "sku": "A-1",\n  "qty": 2\n}',
    )
    const listed = await run(r, { action: 'search', jql: 'project = OPS', max: '3' })
    expect(listed.data).toHaveLength(3)
    await run(r, { action: 'assign', issue: key, assignee: 'ada' })
    expect(fake.jira.issues.get(key)?.fields.assignee).toEqual({ name: 'ada' })
    const bad = await failure(
      run(r, { action: 'createIssue', project: 'NOPE', issueType: 'Bug', summary: 'x' }),
    )
    expect(bad.message).toBe('Jira: project: Specify a valid project ID or key')
    expect(bad.details).toMatchObject({
      status: 400,
      errors: { project: 'Specify a valid project ID or key' },
    })
    expect((await failure(run(r, { action: 'getIssue', issue: 'OPS-999' }))).message).toMatch(
      /Issue does not exist/,
    )
    expect((await run(r, { action: 'api', path: '/rest/api/2/project' })).data).toEqual([
      { key: 'OPS', name: 'OPS' },
    ])
    expect((await failure(run(r, { action: 'api', path: '/secure/x' }))).code).toBe('invalid_query')
  })
})

describe('notion', () => {
  const DB = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b'
  const key = (token = fake.notion.token) => resource({}, { token }, `n:${token}`)
  const run = (query: object, scope: Record<string, unknown> = {}) =>
    runQuery(pool, notionConnector, key(), query, { evaluate: scopeEvaluator(scope) })

  beforeAll(() => {
    fake.notion.databases.set(DB, {
      id: DB,
      title: 'Purchase orders',
      properties: {
        Name: { id: 'title', type: 'title' },
        Qty: { id: 'q', type: 'number' },
        Status: { id: 's', type: 'status' },
        Tags: { id: 't', type: 'multi_select' },
        Due: { id: 'd', type: 'date' },
        Done: { id: 'x', type: 'checkbox' },
      },
    })
  })

  it('reads ids from URLs, and turns properties into plain values and back', () => {
    expect(notionId('https://www.notion.so/acme/Orders-1f2e3d4c5b6a49788a9b0c1d2e3f4a5b?v=abc')).toBe(DB)
    expect(notionId('1F2E3D4C5B6A49788A9B0C1D2E3F4A5B')).toBe(DB)
    expect(() => notionId('nope')).toThrow(/isn't a Notion id/)
    const schema = {
      Name: { type: 'title' },
      Qty: { type: 'number' },
      Tags: { type: 'multi_select' },
      Due: { type: 'date' },
      Done: { type: 'checkbox' },
      Status: { type: 'status' },
    }
    const props = notionProperties(
      { Name: 'PO 1', Qty: '3', Tags: 'urgent, eu', Due: '2026-11-04', Done: true, Status: 'Open' },
      schema,
    )
    expect(props).toEqual({
      Name: { title: [{ type: 'text', text: { content: 'PO 1' } }] },
      Qty: { number: 3 },
      Tags: { multi_select: [{ name: 'urgent' }, { name: 'eu' }] },
      Due: { date: { start: '2026-11-04' } },
      Done: { checkbox: true },
      Status: { status: { name: 'Open' } },
    })
    expect(() => notionProperties({ Colour: 'red' }, schema)).toThrow(/no property "Colour"/)
    expect(() => notionProperties({ Qty: 'many' }, schema)).toThrow(/isn't a number/)
    expect(plainProperty({ type: 'date', date: { start: 'a', end: 'b' } })).toEqual({ start: 'a', end: 'b' })
    expect(plainProperty({ type: 'formula', formula: { type: 'number', number: 4 } })).toBe(4)
    expect(plainProperty({ type: 'unique_id', unique_id: { prefix: 'PO', number: 7 } })).toBe('PO-7')
    expect(
      flatPage({ id: 'p', url: 'u', properties: { Name: { type: 'title', title: [{ plain_text: 'x' }] } } }),
    ).toMatchObject({ id: 'p', Name: 'x' })
    // A property called id doesn't hide the page's id.
    expect(
      flatPage({ id: 'p', properties: { id: { type: 'rich_text', rich_text: [{ plain_text: 'x' }] } } }).id,
    ).toBe('p')
    expect(notionBlocks('# Title\n- one\n1. first\n[x] done\nText')).toEqual([
      {
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: 'Title' } }] },
      },
      {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'one' } }] },
      },
      {
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ type: 'text', text: { content: 'first' } }] },
      },
      {
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: [{ type: 'text', text: { content: 'done' } }], checked: true },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'Text' } }] },
      },
    ])
  })

  it('tests the token', async () => {
    expect(await testResource(notionConnector, key())).toMatchObject({
      ok: true,
      message: 'Notion as Optiply bot in Optiply',
    })
    expect(await testResource(notionConnector, key('ntn_wrong'))).toMatchObject({ ok: false })
  })

  it('creates pages in a database, queries them (filtered, sorted, paged), updates and archives one', async () => {
    for (let i = 1; i <= 5; i++)
      await run(
        {
          action: 'createPage',
          parent: DB,
          properties: '{"Name": "PO {{ i }}", "Qty": {{ i }}, "Status": "{{ status }}", "Tags": ["eu"]}',
          content: '# Lines\n- pallet',
        },
        { i, status: i % 2 ? 'Open' : 'Sent' },
      )
    const open = await run({
      action: 'queryDatabase',
      id: DB,
      filter: '{"property": "Status", "status": {"equals": "Open"}}',
      sorts: '[{"property": "Qty", "direction": "descending"}]',
    })
    const rows = open.data as Record<string, unknown>[]
    expect(rows.map((r) => r.Name)).toEqual(['PO 5', 'PO 3', 'PO 1'])
    expect(rows[0]).toMatchObject({ Qty: 5, Status: 'Open', Tags: ['eu'] })
    const two = await run({
      action: 'queryDatabase',
      id: `https://www.notion.so/x-${DB.replaceAll('-', '')}`,
      max: '2',
    })
    expect(two.data).toHaveLength(2)
    expect(two.metadata).toMatchObject({ more: true })

    const id = String(rows[0]!.id)
    const updated = await run({
      action: 'updatePage',
      id,
      properties: '{"Status": "Sent", "Done": true, "Due": "2026-11-05"}',
    })
    expect(updated.data).toMatchObject({ Status: 'Sent', Done: true, Due: '2026-11-05' })
    expect((await run({ action: 'getPage', id })).data).toMatchObject({ Name: 'PO 5', Status: 'Sent' })
    await run({ action: 'archivePage', id })
    expect(((await run({ action: 'queryDatabase', id: DB })).data as unknown[]).length).toBe(4)
    expect(
      (await failure(run({ action: 'updatePage', id: String(rows[1]!.id), properties: '{"Colour": "red"}' })))
        .message,
    ).toMatch(/no property "Colour"/)
  })

  it('writes and reads content, makes a page under a page, searches, and explains errors', async () => {
    const parent = await run({ action: 'createPage', parent: DB, properties: '{"Name": "Notes"}' })
    const parentId = String((parent.data as { id: string }).id)
    const lines = Array.from({ length: 150 }, (_, i) => `- line ${i}`).join('\n')
    expect((await run({ action: 'appendBlocks', id: parentId, content: lines })).data).toEqual({ added: 150 })
    const blocks = await run({ action: 'getBlocks', id: parentId, max: '1000' })
    expect((blocks.data as unknown[]).length).toBe(150)
    expect((blocks.data as Record<string, unknown>[])[149]).toMatchObject({
      type: 'bulleted_list_item',
      text: 'line 149',
    })

    const child = await run({ action: 'createPage', parent: parentId, title: 'Child page', content: 'Hello' })
    expect(child.data).toMatchObject({ title: 'Child page' })
    expect(fake.notion.pages.get(String((child.data as { id: string }).id))?.parent).toEqual({
      page_id: parentId,
    })
    const searched = await run({ action: 'search', query: 'purchase', only: 'database' })
    expect(searched.data).toEqual([
      { id: DB, object: 'database', title: 'Purchase orders', url: expect.any(String) },
    ])
    const pages = await run({ action: 'search', query: 'child', only: 'page' })
    expect((pages.data as Record<string, unknown>[]).map((p) => p.title)).toEqual(['Child page'])

    const missing = await failure(run({ action: 'getPage', id: '00000000-0000-4000-8000-000000000000' }))
    expect(missing.message).toMatch(/Could not find page/)
    expect(missing.details).toMatchObject({ status: 404, code: 'object_not_found' })
    expect((await failure(run({ action: 'createPage', parent: parentId }))).message).toBe(
      'A page under a page needs a title',
    )
  })
})
