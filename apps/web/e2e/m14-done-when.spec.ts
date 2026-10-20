import { expect, type Page, test } from '@playwright/test'
import { E2E_GITHUB_TOKEN, E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M14's done-when (architecture §2.7):
 * - a library query with a `customerId` parameter is published and used by two apps, one pinned to 1.0.0 and one on
 *   `latest`; publishing 1.1.0 changes what the second runs and not the first; a viewer with Use on the app only
 *   runs it, and an editor without Use on the library query can't publish an app that uses it;
 * - a module with an input, an output, an event and a query of its own is placed twice in one app: each instance
 *   keeps its own state, the app reads `customerPicker1.selectedId` and handles its `picked` event, and the server
 *   refuses to run a query the referenced module release doesn't have;
 * - a library query, a module and an app using both are protected, edited on one branch and deployed by one merge.
 */

const lookup = (version: string) => ({
  name: 'lookup',
  kind: 'library',
  library: '',
  version,
  params: { customerId: '1' },
  run: 'auto',
})

const textApp = (library: string, version: string) => ({
  schemaVersion: 1,
  components: [{ name: 'email', type: 'text', props: { value: 'Email: {{ lookup.data[0].email }}' } }],
  queries: [{ ...lookup(version), library }],
  layout: { email: { x: 0, y: 0, w: 6, h: 2 } },
})

/** A customer picker: the customers on a plan (an input), the first one's id out, `picked` from a button. */
const picker = (prefix = 'First') => ({
  schemaVersion: 1,
  components: [
    { name: 'plan1', type: 'textInput', props: { label: 'Plan', defaultValue: '{{ inputs.plan }}' } },
    { name: 'first', type: 'text', props: { value: `${prefix}: {{ find.data?.[0]?.email }}` } },
    {
      name: 'pick',
      type: 'button',
      props: { text: 'Pick' },
      events: [{ id: 'a', event: 'click', action: { type: 'moduleEvent', event: 'picked' } }],
    },
  ],
  queries: [
    {
      name: 'find',
      kind: 'resource',
      resource: 'shop_db',
      query: { sql: 'select id, email from customers where plan = {{ plan1.value }} order by id' },
      run: 'auto',
    },
  ],
  layout: {
    plan1: { x: 0, y: 0, w: 6, h: 4 },
    first: { x: 0, y: 4, w: 12, h: 2 },
    pick: { x: 0, y: 6, w: 3, h: 3 },
  },
  module: {
    inputs: [{ name: 'plan', default: 'pro' }],
    outputs: [{ name: 'selectedId', value: '{{ find.data?.[0]?.id ?? null }}' }],
    events: [{ name: 'picked' }],
  },
})

async function create(
  page: Page,
  kind: 'libraryQueries' | 'modules' | 'apps',
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

const publish = (page: Page, kind: 'libraryQueries' | 'modules' | 'apps', id: string, revision: number) =>
  trpcMutate<{ id: string; version: string }>(page, `${kind}.publish`, {
    [kind === 'libraryQueries' ? 'libraryQueryId' : kind === 'modules' ? 'moduleId' : 'appId']: id,
    draftRevision: revision,
  })

test('M14 done-when: library queries, modules, and both in Git', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => void d.accept())
  await signIn(page)
  const stamp = Date.now()
  const librarySlug = `customer_email_${stamp}`
  const moduleSlug = `customer_picker_${stamp}`

  // A group with the member in it.
  const users = await trpcQuery<{ id: string; email: string }[]>(page, 'users.list', undefined)
  const memberId = users.find((u) => u.email === E2E_MEMBER_EMAIL)!.id
  const group = await trpcMutate<{ id: string }>(page, 'groups.create', { name: `M14 ${stamp}` })
  await trpcMutate(page, 'groups.addMember', { groupId: group.id, userId: memberId })
  const grant = (objectType: string, objectId: string, level: 'use' | 'edit') =>
    trpcMutate(page, 'permissions.set', {
      objectType,
      objectId,
      groupId: group.id,
      environmentId: null,
      level,
    })

  const pinnedSlug = `m14-pinned-${stamp}`
  const latestSlug = `m14-latest-${stamp}`
  let latestApp = { id: '', revision: 0 }

  await test.step('a library query used by two apps, pinned and latest', async () => {
    const lib = await create(page, 'libraryQueries', librarySlug, {
      schemaVersion: 1,
      resource: 'shop_db',
      query: { sql: 'select email from customers where id = {{ customerId }}::int' },
      params: [{ name: 'customerId', testValue: 1 }],
    })
    expect((await publish(page, 'libraryQueries', lib.id, lib.revision)).version).toBe('1.0.0')
    const pinned = await create(page, 'apps', pinnedSlug, textApp(librarySlug, '1.0.0'))
    await publish(page, 'apps', pinned.id, pinned.revision)
    latestApp = await create(page, 'apps', latestSlug, textApp(librarySlug, 'latest'))
    await publish(page, 'apps', latestApp.id, latestApp.revision)

    // 1.1.0: what `latest` runs changes; the pinned app keeps 1.0.0.
    const { revision } = await trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
      id: lib.id,
      revision: lib.revision,
      definition: {
        schemaVersion: 1,
        resource: 'shop_db',
        query: { sql: 'select upper(email) as email from customers where id = {{ customerId }}::int' },
        params: [{ name: 'customerId', testValue: 1 }],
      },
    })
    const minor = await trpcMutate<{ version: string }>(page, 'libraryQueries.publish', {
      libraryQueryId: lib.id,
      draftRevision: revision,
      bump: 'minor',
    })
    expect(minor.version).toBe('1.1.0')

    // A viewer with Use on the apps only (nothing on the library query or its resource) runs them.
    await grant('app', pinned.id, 'use')
    await grant('app', latestApp.id, 'edit')
    const context = await browser.newContext()
    const viewer = await context.newPage()
    viewer.on('dialog', (d) => void d.accept())
    await signIn(viewer, E2E_MEMBER_EMAIL)
    await viewer.goto(`/apps/${pinnedSlug}`)
    await expect(viewer.locator('[data-component="email"]')).toHaveText('Email: ada@example.com')
    await viewer.goto(`/apps/${latestSlug}`)
    await expect(viewer.locator('[data-component="email"]')).toHaveText('Email: ADA@EXAMPLE.COM')

    // Edit on the app isn't enough to publish it: it needs Use on the library query too.
    const changed = textApp(librarySlug, 'latest')
    changed.components[0]!.props.value = 'Address: {{ lookup.data[0].email }}'
    latestApp.revision = (
      await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
        id: latestApp.id,
        revision: latestApp.revision,
        definition: changed,
      })
    ).revision
    // In the editor the library query isn't theirs to see: a problem, and Publish waits.
    await viewer.goto(`/apps/${latestSlug}/edit`)
    await viewer.getByRole('tab', { name: /^Problems/ }).click()
    await expect(viewer.getByText(`No library query has the slug "${librarySlug}"`)).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
    // And the server refuses it.
    const refused = await viewer.request.post('/api/trpc/apps.publish', {
      data: { json: { appId: latestApp.id, draftRevision: latestApp.revision } },
    })
    expect((await refused.json()).error.json).toMatchObject({
      message: `You need use access to library query "${librarySlug}" to release this app, which uses it`,
      data: { code: 'FORBIDDEN' },
    })
    await context.close()
  })

  await test.step('a module placed twice in one app', async () => {
    const mod = await create(page, 'modules', moduleSlug, picker())
    const release = await publish(page, 'modules', mod.id, mod.revision)
    const appSlug = `m14-pickers-${stamp}`
    const app = await create(page, 'apps', appSlug, {
      schemaVersion: 1,
      components: [
        {
          name: 'customerPicker1',
          type: 'module',
          props: { module: moduleSlug, plan: 'free' },
          events: [
            {
              id: 'h',
              event: 'picked',
              action: { type: 'setVariable', variable: 'chosen', value: '{{ customerPicker1.selectedId }}' },
            },
          ],
        },
        { name: 'customerPicker2', type: 'module', props: { module: moduleSlug } },
        { name: 'selected', type: 'text', props: { value: 'Selected {{ customerPicker1.selectedId }}' } },
        { name: 'picked', type: 'text', props: { value: 'Picked {{ chosen.value }}' } },
      ],
      queries: [],
      variables: [{ name: 'chosen', initialValue: 'nobody' }],
      layout: {
        customerPicker1: { x: 0, y: 0, w: 6, h: 12 },
        customerPicker2: { x: 6, y: 0, w: 6, h: 12 },
        selected: { x: 0, y: 12, w: 6, h: 2 },
        picked: { x: 6, y: 12, w: 6, h: 2 },
      },
    })
    const live = await publish(page, 'apps', app.id, app.revision)
    await page.goto(`/apps/${appSlug}`)
    const one = page.locator('[data-component="customerPicker1"]')
    const two = page.locator('[data-component="customerPicker2"]')
    // Their own inputs, queries and state: the free plan's first customer is Grace (2), the pro plan's Ada.
    await expect(one.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
    await expect(two.locator('[data-component="first"]')).toHaveText('First: ada@example.com')
    await expect(page.locator('[data-component="selected"]')).toHaveText('Selected 2')
    await two.getByRole('textbox').fill('free')
    await expect(two.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
    await two.getByRole('textbox').fill('nobody')
    await expect(two.locator('[data-component="first"]')).toHaveText('First:')
    await expect(one.locator('[data-component="first"]')).toHaveText('First: grace@example.com')
    // Its event, handled by the app.
    await expect(page.locator('[data-component="picked"]')).toHaveText('Picked nobody')
    await one.getByRole('button', { name: 'Pick' }).click()
    await expect(page.locator('[data-component="picked"]')).toHaveText('Picked 2')

    // The server runs only the queries the module release has.
    const res = await page.request.post('/api/trpc/apps.runQuery', {
      data: {
        json: {
          appId: app.id,
          releaseId: live.id,
          query: 'drop_everything',
          module: { instance: 'customerPicker1', releaseId: release.id },
          environmentId: (
            await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
          ).find((e) => e.isDefault)!.id,
          values: {},
        },
      },
    })
    const body = await res.json()
    expect(body.error.json).toMatchObject({
      message: 'The module has no query named "drop_everything"',
      data: { code: 'NOT_FOUND' },
    })
  })

  await test.step('a library query, a module and an app using both: protected, one branch, one merge', async () => {
    const repoUrl = process.env.E2E_GIT_REPO_URL!
    const github = process.env.E2E_FAKE_GITHUB!
    const info = await trpcQuery<{ configured: boolean }>(page, 'git.info', {})
    if (!info.configured) await trpcMutate(page, 'git.saveSettings', { repoUrl, token: E2E_GITHUB_TOKEN })
    const bothSlug = `m14-both-${stamp}`
    const both = await create(page, 'apps', bothSlug, {
      schemaVersion: 1,
      components: [
        { name: 'title', type: 'text', props: { value: 'Both v1' } },
        { name: 'email', type: 'text', props: { value: 'Email: {{ lookup.data[0].email }}' } },
        { name: 'customerPicker1', type: 'module', props: { module: moduleSlug, plan: 'free' } },
      ],
      queries: [{ ...lookup('latest'), library: librarySlug }],
      layout: {
        title: { x: 0, y: 0, w: 6, h: 2 },
        email: { x: 0, y: 2, w: 6, h: 2 },
        customerPicker1: { x: 0, y: 4, w: 6, h: 12 },
      },
    })
    await publish(page, 'apps', both.id, both.revision)
    const lib = await trpcQuery<{ id: string }>(page, 'libraryQueries.get', { slug: librarySlug })
    const mod = await trpcQuery<{ id: string }>(page, 'modules.get', { slug: moduleSlug })
    const objects = [
      { kind: 'library_query', id: lib.id },
      { kind: 'module', id: mod.id },
      { kind: 'app', id: both.id },
    ] as const

    // Protected; their protect pull requests merge (what's live, so nothing new deploys).
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

    // All three edited on one branch, each committed there.
    const branch = `m14/all-${stamp}`
    const edits: Record<(typeof objects)[number]['kind'], (def: Record<string, unknown>) => object> = {
      library_query: (def) => ({
        ...def,
        query: { sql: "select lower(email) || '!' as email from customers where id = {{ customerId }}::int" },
      }),
      module: () => picker('Top'),
      app: (def) => ({
        ...def,
        components: (def.components as { name: string; props: object }[]).map((c) =>
          c.name === 'title' ? { ...c, props: { value: 'Both v2' } } : c,
        ),
      }),
    }
    for (const o of objects) {
      const draft = await trpcMutate<{ id: string; revision: number; definition: Record<string, unknown> }>(
        page,
        'branchDrafts.open',
        { kind: o.kind, id: o.id, branch, create: true },
      )
      const saved = await trpcMutate<{ revision: number }>(page, 'branchDrafts.save', {
        id: draft.id,
        revision: draft.revision,
        definition: edits[o.kind](draft.definition),
      })
      await trpcMutate(page, 'branchDrafts.commit', {
        id: draft.id,
        revision: saved.revision,
        message: `Change the ${o.kind}`,
      })
    }

    // One pull request, one merge: all three deploy.
    await trpcMutate(page, 'git.openPullRequest', { branch, title: 'Louder emails, a new title' })
    const pr = (await pulls()).find((p) => p.head === branch && p.state === 'open')!
    const merged = await fetch(`${github}/_test/pulls/${pr.number}/merge`, { method: 'POST' })
    const { commit } = (await merged.json()) as { commit: string }
    await trpcMutate(page, 'git.deployNow', {}).catch(() => {})
    await expect
      .poll(
        async () =>
          (await trpcQuery<{ settings: { deployedCommit: string } }>(page, 'git.status', undefined)).settings
            .deployedCommit,
        { timeout: 20_000 },
      )
      .toBe(commit)
    const liveOf = async (path: string, input: object) =>
      (
        await trpcQuery<{ version: string; live: boolean; gitCommit: string | null }[]>(page, path, input)
      ).find((r) => r.live)
    expect(await liveOf('libraryQueries.releases', { libraryQueryId: lib.id })).toMatchObject({
      version: '1.1.1',
      gitCommit: commit,
    })
    expect(await liveOf('modules.releases', { moduleId: mod.id })).toMatchObject({
      version: '1.0.1',
      gitCommit: commit,
    })
    expect(await liveOf('apps.releases', { appId: both.id })).toMatchObject({
      version: '1.0.1',
      gitCommit: commit,
    })

    // The app's live release runs all three changes.
    await page.goto(`/apps/${bothSlug}`)
    await expect(page.locator('[data-component="title"]')).toHaveText('Both v2')
    await expect(page.locator('[data-component="email"]')).toHaveText('Email: ada@example.com!')
    await expect(
      page.locator('[data-component="customerPicker1"]').locator('[data-component="first"]'),
    ).toHaveText('Top: grace@example.com')
  })

  expect(errors).toEqual([])
})
