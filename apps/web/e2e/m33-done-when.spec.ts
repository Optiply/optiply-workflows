import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { publishedApp } from './custom-component-helpers'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M33's done-when (docs/architecture.md §2.36): a token made in Settings → Access tokens signs the CLI in (the CLI
 * fetched from the instance); an admin adds a private npm registry for @acme; the CLI inits a library, adds a
 * component importing @acme/greeting, pushes, builds and publishes it; `dev` sends an edit that the open library
 * editor's Preview shows; in an app, the component on Auto grows with its content, moving the text under it.
 */
test.skip(!process.env.E2E_NPM_PRIVATE_URL, 'needs the e2e setup’s private npm registry')

const GREETING = `import greet from '@acme/greeting'
import { useProp } from '@ow/component-sdk'

export default function Greeting() {
  const lines = useProp<number>('lines') ?? 1
  return (
    <div>
      {Array.from({ length: lines }, (_, i) => (
        <p key={i} style={{ margin: 0, height: 24 }}>{greet('line ' + (i + 1))}</p>
      ))}
    </div>
  )
}
`

let work: string
let cliFile: string
let dev: ChildProcess | null = null

test.afterAll(async () => {
  dev?.kill('SIGTERM')
  if (work) await rm(work, { recursive: true, force: true })
})

/** Runs the CLI (signed in through the config in `work`), resolving with its exit code and output. */
function cli(args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      cwd,
      env: { PATH: process.env.PATH, OW_CONFIG_DIR: join(work, 'config') },
    })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stderr.on('data', (c) => {
      out += c
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

const box = async (page: Page, name: string) =>
  (await page.locator(`[data-component="${name}"]`).boundingBox())!

test("M33's done-when", async ({ page, baseURL }) => {
  test.setTimeout(300_000)
  const stamp = Date.now().toString(36)
  const slug = `cli-lib-${stamp}`
  work = await mkdtemp(join(tmpdir(), 'ow-m33-'))
  await signIn(page)

  let token = ''
  await test.step('a token from Settings → Access tokens signs in the CLI fetched from the instance', async () => {
    await page.goto('/settings/access-tokens')
    await page.getByRole('button', { name: 'New token' }).click()
    await page.getByLabel('Name').fill(`CLI ${stamp}`)
    await page.getByRole('button', { name: 'Create token' }).click()
    token = (await page.getByTestId('new-access-token-value').textContent())!.trim()
    expect(token).toMatch(/^owpat_/)
    const res = await page.request.get('/api/cli/ow-components.mjs')
    expect(res.ok()).toBe(true)
    cliFile = join(work, 'ow-components.mjs')
    await writeFile(cliFile, await res.body())
    const login = await cli(['login', baseURL!, '--token', token], work)
    expect(login.out).toContain(`Signed in to ${baseURL}`)
    expect(login.code).toBe(0)
  })

  await test.step('an admin adds a private npm registry for @acme', async () => {
    const name = `ACME_NPM_${stamp.toUpperCase()}`
    const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
    const secret = await trpcMutate<{ id: string }>(page, 'configVars.create', { name, isSecret: true })
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: secret.id,
      environmentId: envs.find((e) => e.isDefault)!.id,
      value: process.env.E2E_NPM_PRIVATE_TOKEN,
    })
    // A run before this one (the spec repeated) made it already: edited then.
    const registries = await trpcQuery<{ scope: string | null }[]>(page, 'npmRegistries.list', undefined)
    await page.goto('/settings/components')
    const existing = page.getByTestId('npm-registry-@acme')
    if (registries.some((r) => r.scope === '@acme'))
      await existing.getByRole('button', { name: 'Edit' }).click()
    else {
      await page.getByRole('button', { name: 'New registry' }).click()
      await page.getByPlaceholder('@acme').fill('@acme')
    }
    await page.getByPlaceholder('https://npm.pkg.github.com/').fill(process.env.E2E_NPM_PRIVATE_URL!)
    await page.getByLabel('Token config var').selectOption(name)
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await expect(page.getByTestId('npm-registry-test')).toContainText('signed in as ci')
    await page.getByRole('button', { name: /Add registry|Save/ }).click()
    await expect(page.getByTestId('npm-registry-@acme')).toContainText(name)
  })

  const dir = join(work, slug)
  await test.step('the CLI makes a library using @acme/greeting, builds and publishes it', async () => {
    const init = await cli(['init', slug, '--name', 'Greetings'], work)
    expect(init.code, init.out).toBe(0)
    await writeFile(join(dir, 'src/Greeting.tsx'), GREETING)
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ private: true, dependencies: { '@acme/greeting': '^1.0.0' } }, null, 2),
    )
    const library = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))
    library.components.push({
      name: 'Greeting',
      label: 'Greeting',
      entry: 'src/Greeting.tsx',
      props: { lines: { type: 'number', default: 1, label: 'Lines' } },
      state: {},
      events: [],
      methods: {},
      defaultSize: { w: 6, h: 4 },
      autoHeight: true,
    })
    await writeFile(join(dir, 'library.json'), JSON.stringify(library, null, 2))
    const pushed = await cli(['push', '--build', '--publish', '1.0.0'], dir)
    expect(pushed.out).toContain('Published')
    expect(pushed.code, pushed.out).toBe(0)
  })

  await test.step('dev sends an edit that the open library editor’s Preview shows', async () => {
    await page.goto(`/component-libraries/${slug}`)
    await expect(page.getByTestId('library-build')).toBeVisible()
    dev = spawn(process.execPath, [cliFile, 'dev'], {
      cwd: dir,
      env: { PATH: process.env.PATH, OW_CONFIG_DIR: join(work, 'config') },
    })
    let output = ''
    dev.stdout?.on('data', (c) => {
      output += c
    })
    dev.stderr?.on('data', (c) => {
      output += c
    })
    // Its first push saves the same draft (nothing for the editor to follow); then an edit.
    await expect.poll(() => output, { timeout: 60_000 }).toContain('Built')
    const preview = page.getByTestId('library-preview').frameLocator('iframe')
    const hello = await readFile(join(dir, 'src/Hello.tsx'), 'utf8')
    await writeFile(join(dir, 'src/Hello.tsx'), hello.replace('Hello {name}', 'Edited in my editor, {name}'))
    await expect(preview.getByRole('button')).toContainText('Edited in my editor', { timeout: 60_000 })
    await expect(page.getByTestId('library-last-push')).toContainText('Pushed from the CLI by')
    dev.kill('SIGTERM')
    dev = null
  })

  await test.step('in an app, the component on Auto grows with its content', async () => {
    await publishedApp(page, `${slug}-app`, {
      schemaVersion: 1,
      queries: [],
      components: [
        { name: 'input1', type: 'numberInput', props: { label: 'Lines', defaultValue: 1 } },
        {
          name: 'greeting1',
          type: 'custom',
          props: { library: slug, component: 'Greeting', lines: '{{ input1.value }}' },
        },
        { name: 'under1', type: 'text', props: { value: 'Under the greeting' } },
      ],
      layout: {
        input1: { x: 0, y: 0, w: 4, h: 4 },
        greeting1: { x: 0, y: 4, w: 6, h: 4 },
        under1: { x: 0, y: 8, w: 6, h: 2 },
      },
    })
    await page.goto(`/apps/${slug}-app`)
    const frame = page.frameLocator('[data-component="greeting1"] iframe')
    await expect(frame.getByText('Hello from @acme, line 1')).toBeVisible()
    const before = (await box(page, 'under1')).y
    await page.getByLabel('Lines').fill('10')
    await expect(frame.getByText('Hello from @acme, line 10')).toBeVisible()
    await expect
      .poll(async () => (await box(page, 'greeting1')).height, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(240)
    await expect.poll(async () => (await box(page, 'under1')).y).toBeGreaterThan(before + 150)
  })
})
