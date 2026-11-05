import { expect, type Page, test } from '@playwright/test'
import { E2E_EMAIL, E2E_GITHUB_TOKEN, E2E_MEMBER_EMAIL, E2E_SECOND_EMAIL } from './global-setup'
import { editorText, openDebug, openEditorPanel, signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M21's done-when (architecture §2.7, §2.24): library queries in workflows (a pinned block and a library loop runner,
 * `current_user` the person who ran it and null on a schedule, the version in the metadata, Use needed to release,
 * deleting refused); modules three levels deep placed twice in an app, apart, a new live release asking to reload;
 * a fourth level and cycles refused (also through `latest`); two people editing a library query; renaming a module
 * input; a module on a hidden page running nothing until shown; "needs use access"; the publish warning; and a
 * workflow with a Library query block and nested modules deployed from Git in one commit.
 */

type Json = Record<string, unknown>

async function create(
  page: Page,
  kind: 'libraryQueries' | 'modules' | 'apps' | 'workflows',
  slug: string,
  definition: object,
) {
  const { id } = await trpcMutate<{ id: string }>(page, `${kind}.create`, { slug, name: slug })
  const { revision } = await trpcMutate<{ revision: number }>(page, `${kind}.saveDraft`, {
    id,
    revision: 1,
    definition,
  })
  return { id, revision }
}

const publishInput = {
  libraryQueries: (id: string, draftRevision: number) => ({ libraryQueryId: id, draftRevision }),
  modules: (id: string, draftRevision: number) => ({ moduleId: id, draftRevision }),
  apps: (id: string, draftRevision: number) => ({ appId: id, draftRevision }),
  workflows: (id: string, draftRevision: number) => ({ workflowId: id, draftRevision }),
}
const publish = (page: Page, kind: keyof typeof publishInput, id: string, revision: number) =>
  trpcMutate<{ id: string; version: string }>(
    page,
    kind === 'workflows' ? 'releases.publish' : `${kind}.publish`,
    publishInput[kind](id, revision),
  )

/** A tRPC call's refusal: its code and message. */
async function refusal(page: Page, path: string, input: unknown) {
  const res = await page.request.post(`/api/trpc/${path}`, { data: { json: input } })
  const body = await res.json()
  return {
    code: body.error?.json?.data?.code as string | undefined,
    message: body.error?.json?.message as string,
  }
}

async function waitForRun(
  page: Page,
  find: (run: { id: string; triggerType: string; workflow: { slug: string } }) => boolean,
) {
  let found: { id: string } | undefined
  await expect
    .poll(
      async () => {
        found = (await (await page.request.get('/api/v1/runs?limit=50')).json()).runs.find(find)
        if (!found) return 'none'
        return (await (await page.request.get(`/api/v1/runs/${found.id}`)).json()).run.status
      },
      { timeout: 30_000 },
    )
    .toMatch(/succeeded|failed/)
  return (await (await page.request.get(`/api/v1/runs/${found!.id}`)).json()).run
}

/** SQL on the platform's database, through the e2e's shop_db resource (as M9's done-when does). */
async function platformSql(page: Page, sql: string) {
  const { resources } = await trpcQuery<{ resources: { id: string; slug: string }[] }>(
    page,
    'resources.list',
    undefined,
  )
  const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
  const result = await trpcMutate<{ ok: boolean }>(page, 'resources.run', {
    resourceId: resources.find((r) => r.slug === 'shop_db')!.id,
    environmentId: envs.find((e) => e.isDefault)!.id,
    query: { sql },
  })
  expect(result.ok, sql).toBe(true)
}

/** The customers on a plan (`plan1`, from `inputs.plan`), the first one's email shown and out. */
const picker = (heading = 'First') => ({
  schemaVersion: 1,
  components: [
    { name: 'plan1', type: 'textInput', props: { label: 'Plan', defaultValue: '{{ inputs.plan }}' } },
    { name: 'first', type: 'text', props: { value: `${heading}: {{ find.data?.[0]?.email }}` } },
  ],
  queries: [
    {
      name: 'find',
      kind: 'resource',
      resource: 'shop_db',
      query: { sql: 'select email from customers where plan = {{ plan1.value }} order by id' },
      run: 'auto',
    },
  ],
  layout: { plan1: { x: 0, y: 0, w: 12, h: 4 }, first: { x: 0, y: 4, w: 12, h: 2 } },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'firstEmail', value: '{{ find.data?.[0]?.email ?? null }}' }],
    events: [],
  },
})

/** A module holding `inner`, passing its `plan` in and the inner instance's `firstEmail` out. */
const holding = (inner: string, extra: object[] = []) => ({
  schemaVersion: 1,
  components: [
    { name: 'inner1', type: 'module', props: { module: inner, plan: '{{ inputs.plan }}' } },
    ...extra,
  ],
  queries: [],
  layout: { inner1: { x: 0, y: 0, w: 12, h: 10 } },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'firstEmail', value: '{{ inner1.firstEmail }}' }],
    events: [],
  },
})

test('M21 done-when: reuse everywhere', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await signIn(page)
  const stamp = Date.now()
  const librarySlug = `m21_label_${stamp}`
  const flowSlug = `m21-flow-${stamp}`
  const pickerSlug = `m21_picker_${stamp}`
  const shellSlug = `m21_shell_${stamp}`
  const topSlug = `m21_top_${stamp}`
  const appSlug = `m21-app-${stamp}`
  const libraryDefinition = {
    schemaVersion: 1,
    resource: 'optiply_db',
    query: {
      sql: "select {{ n }}::int * 10 as x, {{ current_user ? current_user.email : 'nobody' }}::text as who",
    },
    params: [{ name: 'n', testValue: 1 }],
  }
  const lib = await create(page, 'libraryQueries', librarySlug, libraryDefinition)
  await publish(page, 'libraryQueries', lib.id, lib.revision)

  // A member in a group of their own, for the access rules.
  const users = await trpcQuery<{ id: string; email: string }[]>(page, 'users.list', undefined)
  const group = await trpcMutate<{ id: string }>(page, 'groups.create', { name: `M21 ${stamp}` })
  await trpcMutate(page, 'groups.addMember', {
    groupId: group.id,
    userId: users.find((u) => u.email === E2E_MEMBER_EMAIL)!.id,
  })
  const grant = (objectType: string, objectId: string, level: 'use' | 'edit') =>
    trpcMutate(page, 'permissions.set', {
      objectType,
      objectId,
      groupId: group.id,
      environmentId: null,
      level,
    })
  const memberContext = await browser.newContext()
  const member = await memberContext.newPage()
  await signIn(member, E2E_MEMBER_EMAIL)

  const flowDefinition = (enabled: boolean) => ({
    schemaVersion: 1,
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      {
        name: 'pinned',
        type: 'libraryQuery',
        config: { library: librarySlug, version: '1.0.0', params: { n: '{{ startTrigger.data?.n ?? 0 }}' } },
      },
      {
        name: 'each',
        type: 'loop',
        config: {
          input: '{{ [1, 2] }}',
          runner: { kind: 'library', library: librarySlug, version: 'latest', params: { n: '{{ value }}' } },
        },
      },
      {
        name: 'reply',
        type: 'response',
        config: { body: '{"pinned": {{ pinned.data }}, "each": {{ each.data }}}' },
      },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'pinned' },
      { from: 'pinned', port: 'out', to: 'each' },
      { from: 'each', port: 'out', to: 'reply' },
    ],
    triggers: { schedules: [{ name: 'every-minute', intervalMs: 60_000, enabled }] },
  })
  const flow = await create(page, 'workflows', flowSlug, flowDefinition(true))

  await test.step('a workflow runs a pinned library query and a library loop, as the person who ran it', async () => {
    const started = await page.request.post(`/api/v1/workflows/${flowSlug}/runs?environment=production`, {
      data: { input: { n: 4 } },
    })
    expect(started.status()).toBe(202)
    const id = (await started.json()).run.id as string
    const run = await waitForRun(page, (r) => r.id === id)
    expect(run).toMatchObject({
      status: 'succeeded',
      response: {
        body: {
          pinned: [{ x: 40, who: E2E_EMAIL }],
          each: [[{ x: 10, who: E2E_EMAIL }], [{ x: 20, who: E2E_EMAIL }]],
        },
      },
    })
    const block = await (await page.request.get(`/api/v1/runs/${id}/blocks/pinned`)).json()
    expect(block.block.metadata).toMatchObject({ library: { slug: librarySlug, version: '1.0.0' } })
  })

  await test.step('releasing needs Use on the library query; deleting it is refused while the workflow uses it', async () => {
    await grant('workflow', flow.id, 'edit')
    expect(
      await refusal(member, 'releases.publish', { workflowId: flow.id, draftRevision: flow.revision }),
    ).toEqual({
      code: 'FORBIDDEN',
      message: `You need use access to library query "${librarySlug}" to release this workflow, which uses it`,
    })
    expect(await refusal(page, 'libraryQueries.delete', { id: lib.id })).toEqual({
      code: 'CONFLICT',
      message: `Workflows use this library query: "${flowSlug}". Remove it from them first`,
    })
  })

  await test.step('on a schedule, nobody started the run: current_user is null', async () => {
    await publish(page, 'workflows', flow.id, flow.revision)
    await platformSql(
      page,
      `update workflow_triggers set next_fire_at = now() where workflow_id = '${flow.id}'`,
    )
    const scheduled = await waitForRun(
      page,
      (r) => r.triggerType === 'schedule' && r.workflow.slug === flowSlug,
    )
    expect(scheduled).toMatchObject({
      status: 'succeeded',
      response: { body: { pinned: [{ who: 'nobody' }] } },
    })
  })

  await test.step('publishing a release that drops a parameter the workflow passes warns, naming it', async () => {
    await page.goto(`/library/${librarySlug}`)
    await expect(page.getByTestId('save-status')).toHaveText('Saved')
    await page.getByTestId('library-params').getByTitle('Remove n').click()
    // The SQL stops reading it too (otherwise it's a problem, and Publish waits).
    await page.locator('[data-testid^="code-library:"]').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('select 1 as x')
    await expect(page.getByTestId('save-status')).toHaveText('Saved')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByTestId('publish-dropped')).toContainText(`workflow ${flowSlug} passes “n”`)
    await page.getByRole('button', { name: 'Cancel' }).click()
    // Put back for what follows: a save some other way, folded into the open document.
    const current = await trpcQuery<{ draftRevision: number }>(page, 'libraryQueries.get', {
      slug: librarySlug,
    })
    await trpcMutate(page, 'libraryQueries.saveDraft', {
      id: lib.id,
      revision: current.draftRevision,
      definition: libraryDefinition,
    })
    await expect(page.getByLabel('Parameter 1 name')).toHaveValue('n')
    await expect
      .poll(() => editorText(page.locator('[data-testid^="code-library:"]')))
      .toBe(libraryDefinition.query.sql)
  })

  await test.step('two people edit the library query together', async () => {
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    await signIn(other, E2E_SECOND_EMAIL)
    await other.goto(`/library/${librarySlug}`)
    await expect(page.getByTestId('presence-Second')).toBeVisible()
    const mine = page.locator('[data-testid^="code-library:"]')
    const theirs = other.locator('[data-testid^="code-library:"]')
    await mine.click()
    await page.keyboard.press('End')
    await theirs.click()
    await other.keyboard.press('Home')
    await Promise.all([
      page.keyboard.type(' -- a', { delay: 50 }),
      other.keyboard.type('/* b */ ', { delay: 50 }),
    ])
    const merged = `/* b */ ${libraryDefinition.query.sql} -- a`
    await expect.poll(() => editorText(mine)).toBe(merged)
    await expect.poll(() => editorText(theirs)).toBe(merged)
    await expect(other.getByTestId('save-status')).toHaveText('Saved')
    await otherContext.close()
  })

  const ids: Record<string, string> = {}
  let appId = ''
  await test.step('modules three deep, placed twice in an app, run apart; a new live release asks to reload', async () => {
    for (const [slug, definition] of [
      [pickerSlug, picker()],
      [shellSlug, holding(pickerSlug)],
      [topSlug, holding(shellSlug)],
    ] as const) {
      const made = await create(page, 'modules', slug, definition)
      ids[slug] = made.id
      await publish(page, 'modules', made.id, made.revision)
    }
    const app = await create(page, 'apps', appSlug, {
      schemaVersion: 1,
      components: [
        { name: 'topA', type: 'module', props: { module: topSlug, plan: 'free' } },
        { name: 'topB', type: 'module', props: { module: topSlug, plan: 'pro' } },
        { name: 'shown', type: 'text', props: { value: 'Out: {{ topA.firstEmail }}' } },
      ],
      queries: [],
      layout: {
        topA: { x: 0, y: 0, w: 6, h: 14 },
        topB: { x: 6, y: 0, w: 6, h: 14 },
        shown: { x: 0, y: 14, w: 12, h: 2 },
      },
    })
    appId = app.id
    await publish(page, 'apps', app.id, app.revision)
    await page.goto(`/apps/${appSlug}`)
    const innermost = (instance: string) =>
      page.locator(`[data-component="${instance}"] [data-module="${pickerSlug}"]`)
    await expect(innermost('topA').locator('[data-component="first"]')).toHaveText('First: grace@example.com')
    await expect(innermost('topB').locator('[data-component="first"]')).toHaveText('First: ada@example.com')
    await expect(page.locator('[data-component="shown"]')).toHaveText('Out: grace@example.com')

    // The innermost module goes live with a new release while the page runs the old one.
    const draft = await trpcQuery<{ draftRevision: number }>(page, 'modules.get', { slug: pickerSlug })
    const { revision } = await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
      id: ids[pickerSlug],
      revision: draft.draftRevision,
      definition: picker('Top'),
    })
    await publish(page, 'modules', ids[pickerSlug]!, revision)
    await innermost('topA').getByRole('textbox').fill('pro')
    await expect(page.getByText(`Module "${pickerSlug}" has a new version; reload to get it`)).toBeVisible()
    await page.reload()
    await expect(innermost('topA').locator('[data-component="first"]')).toHaveText('Top: grace@example.com')
  })

  await test.step('a fourth level and cycles are refused, also through latest', async () => {
    const problems = async (slug: string) =>
      (await trpcQuery<{ diagnostics: { code: string }[] }>(page, 'modules.get', { slug })).diagnostics.map(
        (d) => d.code,
      )
    const deep = await create(page, 'modules', `m21_deep_${stamp}`, holding(topSlug))
    expect(await problems(`m21_deep_${stamp}`)).toContain('module_depth')
    expect(
      (await refusal(page, 'modules.publish', { moduleId: deep.id, draftRevision: deep.revision })).code,
    ).toBe('BAD_REQUEST')
    // The picker holding the top module would hold itself.
    const draft = await trpcQuery<{ draftRevision: number }>(page, 'modules.get', { slug: pickerSlug })
    let revision = (
      await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
        id: ids[pickerSlug],
        revision: draft.draftRevision,
        definition: holding(topSlug),
      })
    ).revision
    expect(await problems(pickerSlug)).toContain('module_cycle')
    // Holding a new module is fine for the picker itself, but the app follows it on latest four deep.
    const tiny = await create(page, 'modules', `m21_tiny_${stamp}`, picker())
    await publish(page, 'modules', tiny.id, tiny.revision)
    revision = (
      await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
        id: ids[pickerSlug],
        revision,
        definition: holding(`m21_tiny_${stamp}`),
      })
    ).revision
    const refused = await refusal(page, 'modules.publish', {
      moduleId: ids[pickerSlug],
      draftRevision: revision,
    })
    expect(refused.code).toBe('BAD_REQUEST')
    expect(refused.message).toContain('would nest modules more than 3 deep')
    expect(refused.message).toContain(`app "${appSlug}"`)
  })

  await test.step('renaming a module input rewrites the module’s reads of it', async () => {
    await page.goto(`/modules/${shellSlug}`)
    await openEditorPanel(page, 'Module')
    await page
      .getByRole('region', { name: 'Module' })
      .getByRole('button', { name: 'plan', exact: true })
      .click()
    const name = page.getByLabel('Input name')
    await name.fill('region')
    await name.press('Enter')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => {
        const shell = await trpcQuery<{ draftDefinition: { components: { name: string; props: Json }[] } }>(
          page,
          'modules.get',
          { slug: shellSlug },
        )
        return shell.draftDefinition.components.find((c) => c.name === 'inner1')?.props.plan
      })
      .toBe('{{ inputs.region }}')
  })

  const pagedSlug = `m21-paged-${stamp}`
  await test.step('a module on a page not shown runs nothing until the page is', async () => {
    const paged = await create(page, 'apps', pagedSlug, {
      schemaVersion: 1,
      pages: [{ name: 'home' }, { name: 'more' }],
      components: [
        { name: 'title', type: 'text', props: { value: 'Home' }, page: 'home' },
        { name: 'pick', type: 'module', props: { module: shellSlug, plan: 'free' }, page: 'more' },
      ],
      queries: [],
      layout: { title: { x: 0, y: 0, w: 6, h: 2 }, pick: { x: 0, y: 0, w: 12, h: 12 } },
    })
    await publish(page, 'apps', paged.id, paged.revision)
    const instanceQueries: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('apps.runQuery') && request.postData()?.includes('"instance":"pick"')) {
        instanceQueries.push(request.url())
      }
    })
    await page.goto(`/apps/${pagedSlug}`)
    await expect(page.locator('[data-component="title"]')).toHaveText('Home')
    await page.waitForTimeout(1000)
    expect(instanceQueries).toEqual([])
    await page.goto(`/apps/${pagedSlug}/more`)
    await expect(page.locator(`[data-module="${pickerSlug}"] [data-component="first"]`)).toContainText(
      'grace',
    )
    expect(instanceQueries.length).toBeGreaterThan(0)
    await grant('app', paged.id, 'edit')
  })

  await test.step('an editor without Use on a module is told they need it', async () => {
    await member.goto(`/apps/${pagedSlug}/edit`)
    await openDebug(member, 'Problems')
    await expect(member.getByText(`You need use access to module "${shellSlug}"`)).toBeVisible()
  })
  await memberContext.close()

  await test.step('a workflow with a Library query block and an app with nested modules deploy from Git in one commit', async () => {
    const repoUrl = process.env.E2E_GIT_REPO_URL!
    const github = process.env.E2E_FAKE_GITHUB!
    const info = await trpcQuery<{ configured: boolean }>(page, 'git.info', {})
    if (!info.configured) await trpcMutate(page, 'git.saveSettings', { repoUrl, token: E2E_GITHUB_TOKEN })
    const objects = [
      { kind: 'library_query', id: lib.id },
      { kind: 'workflow', id: flow.id },
      { kind: 'module', id: ids[topSlug]! },
      { kind: 'app', id: appId },
    ] as const
    const pulls = async () =>
      (await (await fetch(`${github}/_test/pulls`)).json()) as {
        number: number
        head: string
        state: string
      }[]
    for (const o of objects) await trpcMutate(page, 'git.protect', { kind: o.kind, id: o.id })
    for (const pull of (await pulls()).filter((p) => p.state === 'open' && p.head.startsWith('protect/'))) {
      expect((await fetch(`${github}/_test/pulls/${pull.number}/merge`, { method: 'POST' })).ok).toBe(true)
    }

    const branch = `m21/all-${stamp}`
    const edits: Record<(typeof objects)[number]['kind'], (def: Json) => object> = {
      library_query: (def) => ({ ...def, query: { sql: `${libraryDefinition.query.sql} -- v2` } }),
      // No more scheduled runs.
      workflow: () => flowDefinition(false),
      module: () => holding(shellSlug, [{ name: 'note', type: 'text', props: { value: 'v2' } }]),
      app: (def) => ({
        ...def,
        components: (def.components as { name: string; props: Json }[]).map((c) =>
          c.name === 'shown' ? { ...c, props: { value: 'Then: {{ topA.firstEmail }}' } } : c,
        ),
      }),
    }
    for (const o of objects) {
      const draft = await trpcMutate<{ id: string; revision: number; definition: Json }>(
        page,
        'branchDrafts.open',
        {
          kind: o.kind,
          id: o.id,
          branch,
          create: true,
        },
      )
      const saved = await trpcMutate<{ revision: number }>(page, 'branchDrafts.save', {
        id: draft.id,
        revision: draft.revision,
        definition: edits[o.kind](draft.definition),
      })
      await trpcMutate(page, 'branchDrafts.commit', {
        id: draft.id,
        revision: saved.revision,
        message: `M21 ${o.kind}`,
      })
    }
    await trpcMutate(page, 'git.openPullRequest', { branch, title: 'M21: all four' })
    const pr = (await pulls()).find((p) => p.head === branch && p.state === 'open')!
    const { commit } = (await (
      await fetch(`${github}/_test/pulls/${pr.number}/merge`, { method: 'POST' })
    ).json()) as {
      commit: string
    }
    await trpcMutate(page, 'git.deployNow', {}).catch(() => {})
    await expect
      .poll(
        async () =>
          (await trpcQuery<{ settings: { deployedCommit: string } }>(page, 'git.status', undefined)).settings
            .deployedCommit,
        { timeout: 30_000 },
      )
      .toBe(commit)
    const liveOf = async (path: string, input: object) =>
      (await trpcQuery<{ live: boolean; gitCommit: string | null }[]>(page, path, input)).find((r) => r.live)
    expect(await liveOf('libraryQueries.releases', { libraryQueryId: lib.id })).toMatchObject({
      gitCommit: commit,
    })
    expect(await liveOf('releases.list', { workflowId: flow.id })).toMatchObject({ gitCommit: commit })
    expect(await liveOf('modules.releases', { moduleId: ids[topSlug] })).toMatchObject({ gitCommit: commit })
    expect(await liveOf('apps.releases', { appId })).toMatchObject({ gitCommit: commit })
  })
})
