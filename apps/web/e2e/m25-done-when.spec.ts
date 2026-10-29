import { expect, test } from '@playwright/test'
import { COUNTER, counterLibrary, publishedApp, publishedLibrary } from './custom-component-helpers'
import { e2eRepo, type Json, mergeOpenPulls, useE2eRepo } from './git-helpers'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M25's done-when (architecture §2.28): custom components. (1) A library using an npm package builds, previews and
 * publishes; (2) in an app its prop follows a query, its state and event reach the app, and a method answers; (3) a
 * fetch to an origin not allowed is blocked and works once an admin allows it, and a frame navigating away is
 * stopped; (4) a release dropping a prop warns, Compare shows the file, the library round-trips through Git (a
 * deploy rebuilds it), and a module placing the component works in an app.
 */

const stamp = Date.now().toString(36)

/** A JS query's result through a button (`name`) and a Text (`text1`) showing it. */
const button = (name: string, text: string, query: string) => ({
  name,
  type: 'button',
  props: { text },
  events: [{ id: `${name}h`, event: 'click', action: { type: 'controlQuery', query, method: 'trigger' } }],
})

test('M25 (1): a library with an npm package builds, previews and publishes', async ({ page }) => {
  await signIn(page)
  const slug = `dw-build-${stamp}`
  const { id } = await trpcMutate<{ id: string }>(page, 'componentLibraries.create', {
    slug,
    name: 'DW build',
  })
  await trpcMutate(page, 'componentLibraries.saveDraft', { id, revision: 1, definition: counterLibrary() })
  await page.goto(`/component-libraries/${slug}`)
  await page.getByTestId('build-library').click()
  await expect(page.getByTestId('library-build').getByText(/^Built/)).toBeVisible({ timeout: 60_000 })
  const preview = page.frameLocator('[data-testid="library-preview"] iframe')
  await expect(preview.getByTestId('label')).toHaveText('Preview')
  await expect(preview.getByRole('button')).toHaveText('#000')
  await preview.getByRole('button').click()
  await expect(page.getByTestId('preview-state')).toContainText('count: 1')
  await expect(page.getByTestId('preview-log')).toContainText('event bump')
  await page.getByLabel('Arguments of highlight').fill('2')
  await page.getByTestId('library-build').getByRole('button', { name: 'highlight', exact: true }).click()
  await expect(page.getByTestId('preview-log')).toContainText('highlight → "highlighted 2"')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0', { timeout: 60_000 })
})

test('M25 (2): in an app, a prop follows a query, state and an event reach the app, a method answers', async ({
  page,
}) => {
  await signIn(page)
  const library = `dw-app-${stamp}`
  await publishedLibrary(page, library, counterLibrary())
  const app = `dw-counter-app-${stamp}`
  await publishedApp(page, app, {
    schemaVersion: 1,
    components: [
      {
        name: 'counter1',
        type: 'custom',
        props: { library, component: 'Counter', label: '{{ q1.data[0].label }}' },
        events: [
          { id: 'b1', event: 'bump', action: { type: 'controlQuery', query: 'q2', method: 'trigger' } },
        ],
      },
      { name: 'text1', type: 'text', props: { value: 'Count {{ counter1.count }}' } },
      { name: 'text2', type: 'text', props: { value: 'Times ten {{ q2.data?.[0]?.x }}' } },
      button('button1', 'Highlight', 'hl'),
      { name: 'text3', type: 'text', props: { value: 'Answer {{ hl.data }}' } },
    ],
    queries: [
      {
        name: 'q1',
        kind: 'resource',
        resource: 'optiply_db',
        query: { sql: "select 'From SQL' as label" },
        run: 'auto',
      },
      {
        name: 'q2',
        kind: 'resource',
        resource: 'optiply_db',
        query: { sql: 'select {{ counter1.count }}::int * 10 as x' },
        run: 'manual',
      },
      { name: 'hl', kind: 'js', code: 'return await counter1.highlight(2)' },
    ],
    layout: {
      counter1: { x: 0, y: 0, w: 6, h: 6 },
      text1: { x: 6, y: 0, w: 6, h: 2 },
      text2: { x: 6, y: 2, w: 6, h: 2 },
      button1: { x: 6, y: 4, w: 3, h: 2 },
      text3: { x: 6, y: 6, w: 6, h: 2 },
    },
  })
  await page.goto(`/apps/${app}`)
  const frame = page.frameLocator('[data-custom-component="Counter"] iframe')
  await expect(frame.getByTestId('label')).toHaveText('From SQL')
  await frame.getByRole('button').click()
  await frame.getByRole('button').click()
  await expect(page.getByText('Count 2', { exact: true })).toBeVisible()
  // Each bump ran q2 with the count it had then.
  await expect(page.getByText('Times ten 20', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Highlight' }).click()
  await expect(page.getByText('Answer highlighted 2', { exact: true })).toBeVisible()
  await expect(frame.getByTestId('mark')).toHaveText('row 2')
})

const FETCHER = `import { useMethod, useStateValue } from '@ow/component-sdk'

export default function Fetcher() {
  const [last, setLast] = useStateValue<string>('last')
  useMethod('load', async (url: string) => {
    try {
      const response = await fetch(url)
      const body = await response.json()
      setLast(body.from)
      return body.from
    } catch {
      setLast('blocked')
      return 'blocked'
    }
  })
  useMethod('leave', (url: string) => {
    window.location.href = url
  })
  return <span data-testid="last">{last}</span>
}
`

test('M25 (3): a fetch is blocked until an admin allows its origin; a frame leaving is stopped', async ({
  page,
}) => {
  await signIn(page)
  const allowed = process.env.E2E_ORIGIN_ALLOWED!
  const other = process.env.E2E_ORIGIN_OTHER!
  const library = `dw-fetch-${stamp}`
  await publishedLibrary(page, library, {
    schemaVersion: 1,
    files: [{ path: 'src/Fetcher.tsx', content: FETCHER }],
    dependencies: {},
    allowedOrigins: [],
    components: [
      {
        name: 'Fetcher',
        label: 'Fetcher',
        entry: 'src/Fetcher.tsx',
        props: {},
        state: { last: { default: 'nothing yet' } },
        events: [],
        methods: { load: { params: ['url'] }, leave: { params: ['url'] } },
        defaultSize: { w: 6, h: 4 },
      },
    ],
  })
  const app = `dw-fetch-app-${stamp}`
  await publishedApp(page, app, {
    schemaVersion: 1,
    components: [
      { name: 'fetcher1', type: 'custom', props: { library, component: 'Fetcher' } },
      button('loadAllowed', 'Load allowed', 'qa'),
      button('loadOther', 'Load other', 'qo'),
      button('leave', 'Leave', 'ql'),
      { name: 'text1', type: 'text', props: { value: 'Last: {{ fetcher1.last }}' } },
    ],
    queries: [
      { name: 'qa', kind: 'js', code: `return await fetcher1.load(${JSON.stringify(`${allowed}/data`)})` },
      { name: 'qo', kind: 'js', code: `return await fetcher1.load(${JSON.stringify(`${other}/data`)})` },
      { name: 'ql', kind: 'js', code: `return await fetcher1.leave(${JSON.stringify(`${other}/away`)})` },
    ],
    layout: {
      fetcher1: { x: 0, y: 0, w: 6, h: 4 },
      loadAllowed: { x: 6, y: 0, w: 2, h: 2 },
      loadOther: { x: 8, y: 0, w: 2, h: 2 },
      leave: { x: 10, y: 0, w: 2, h: 2 },
      text1: { x: 6, y: 2, w: 6, h: 2 },
    },
  })

  await page.goto(`/apps/${app}`)
  await expect(page.locator('[data-custom-component="Fetcher"]')).toHaveAttribute(
    'data-frame-status',
    'ready',
  )
  await page.getByRole('button', { name: 'Load allowed' }).click()
  await expect(page.getByText('Last: blocked', { exact: true })).toBeVisible()

  // An admin allows the origin in the library's editor and publishes it.
  await page.goto(`/component-libraries/${library}`)
  const origins = page.getByTestId('library-origins')
  await origins.getByLabel('Origin').fill(allowed)
  await origins.getByRole('button', { name: 'Add' }).click()
  await expect(origins.getByText('An admin publishes this')).toBeVisible()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByTestId('publish-origins')).toContainText('As an admin, you approve them')
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.1', { timeout: 60_000 })

  await page.goto(`/apps/${app}`)
  await expect(page.locator('[data-custom-component="Fetcher"]')).toHaveAttribute(
    'data-frame-status',
    'ready',
  )
  await page.getByRole('button', { name: 'Load allowed' }).click()
  await expect(page.getByText('Last: allowed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load other' }).click()
  await expect(page.getByText('Last: blocked', { exact: true })).toBeVisible()

  // A component navigating its frame away is stopped.
  await page.getByRole('button', { name: 'Leave' }).click()
  await expect(page.locator('[data-custom-component="Fetcher"]')).toHaveAttribute(
    'data-frame-status',
    'failed',
  )
  await expect(page.getByText('The component tried to leave its frame, so it was stopped')).toBeVisible()
})

test('M25 (4): releases warn and compare, Git round-trips and rebuilds, a module places the component', async ({
  page,
}) => {
  await signIn(page)
  const library = `dw-git-${stamp}`
  const id = await publishedLibrary(page, library, counterLibrary())
  const app = `dw-latest-app-${stamp}`
  await publishedApp(page, app, {
    schemaVersion: 1,
    components: [
      { name: 'counter1', type: 'custom', props: { library, component: 'Counter', label: 'Set here' } },
    ],
    queries: [],
    layout: { counter1: { x: 0, y: 0, w: 6, h: 6 } },
  })

  // A draft dropping the label prop (and changing the file): publishing warns about the app on latest.
  const draft = await trpcQuery<{ draftRevision: number; draftDefinition: Json }>(
    page,
    'componentLibraries.get',
    { id },
  )
  const next = structuredClone(draft.draftDefinition)
  next.components[0]!.props = {}
  next.files[0]!.content = COUNTER.replace("useProp<string>('label')", "'No label'")
  await trpcMutate(page, 'componentLibraries.saveDraft', {
    id,
    revision: draft.draftRevision,
    definition: next,
  })
  await page.goto(`/component-libraries/${library}`)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByTestId('publish-dropped')).toContainText('Counter.label')
  await expect(page.getByTestId('publish-dropped')).toContainText(app)
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.1', { timeout: 60_000 })

  // Compare: the file's change and the prop gone.
  await page.getByTestId('release-status').click()
  await page.getByTestId('releases').getByRole('button', { name: 'Compare' }).first().click()
  const compare = page.getByRole('dialog')
  await expect(compare).toContainText('src/Counter.tsx')
  await expect(compare).toContainText("'No label'")
  await page.keyboard.press('Escape')

  // Git: protected, edited on a branch, merged: the deploy builds and releases it.
  await useE2eRepo(page)
  const { github } = e2eRepo()
  await trpcMutate(page, 'git.protect', { kind: 'component_library', id })
  await mergeOpenPulls(github, `protect/component_library-${library}`)
  const branch = `m25/${stamp}`
  const opened = await trpcMutate<{ id: string; revision: number; definition: Json }>(
    page,
    'branchDrafts.open',
    { kind: 'component_library', id, branch, create: true },
  )
  const fromGit = structuredClone(opened.definition)
  fromGit.components[0]!.label = 'Counter from Git'
  const saved = await trpcMutate<{ revision: number }>(page, 'branchDrafts.save', {
    id: opened.id,
    revision: opened.revision,
    definition: fromGit,
  })
  await trpcMutate(page, 'branchDrafts.commit', {
    id: opened.id,
    revision: saved.revision,
    message: 'Rename it',
  })
  await trpcMutate(page, 'git.openPullRequest', { branch, title: 'Rename the counter' })
  await mergeOpenPulls(github, branch)
  await trpcMutate(page, 'git.deployNow', {}).catch(() => {})
  await expect
    .poll(
      async () => {
        const releases = await trpcQuery<{ version: string; live: boolean; gitCommit: string | null }[]>(
          page,
          'componentLibraries.releases',
          { componentLibraryId: id },
        )
        return releases.find((r) => r.live && r.gitCommit)?.version ?? null
      },
      { timeout: 90_000 },
    )
    .toBe('1.0.2')
  const releases = await trpcQuery<{ components: Record<string, { label: string }>; live: boolean }[]>(
    page,
    'componentLibraries.releases',
    { componentLibraryId: id },
  )
  expect(releases.find((r) => r.live)?.components.Counter?.label).toBe('Counter from Git')

  // A module placing the component, in an app.
  const moduleSlug = `dw-counter-module-${stamp}`
  const mod = await trpcMutate<{ id: string }>(page, 'modules.create', {
    slug: moduleSlug,
    name: 'Counter module',
  })
  await trpcMutate(page, 'modules.saveDraft', {
    id: mod.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'c1', type: 'custom', props: { library, component: 'Counter' } }],
      queries: [],
      layout: { c1: { x: 0, y: 0, w: 12, h: 6 } },
      module: { inputs: [], outputs: [], events: [] },
    },
  })
  await trpcMutate(page, 'modules.publish', { moduleId: mod.id, draftRevision: 2 })
  const withModule = `dw-module-app-${stamp}`
  await publishedApp(page, withModule, {
    schemaVersion: 1,
    components: [{ name: 'mod1', type: 'module', props: { module: moduleSlug } }],
    queries: [],
    layout: { mod1: { x: 0, y: 0, w: 6, h: 12 } },
  })
  await page.goto(`/apps/${withModule}`)
  const inModule = page.frameLocator('[data-module] [data-custom-component="Counter"] iframe')
  await expect(inModule.getByTestId('label')).toHaveText('No label')
  await inModule.getByRole('button').click()
  await expect(inModule.getByRole('button')).toHaveText('#001')
})
