/**
 * The components CLI (M33, docs/architecture.md §2.36): the real `ow-components` file, built as the server's build
 * makes it, run against a listening test server with a personal access token: login, init, pull, push (the draft
 * revision check, --build's problems, --publish), push --prebuilt, and the file served at /api/cli.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

let env: TestEnv
let registry: TestRegistry
let work: string
let cliFile: string
let url: string
let admin: ReturnType<typeof trpc>
let token: string
let memberToken: string

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

/**
 * Runs the CLI in `cwd`, its config in the test's own directory. Asynchronously: the test server answers it from
 * this very process.
 */
function cli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      cwd: opts.cwd ?? work,
      env: { PATH: process.env.PATH, OW_CONFIG_DIR: join(work, 'config'), ...opts.env },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(opts.input ?? '')
  })
}

const libraryBySlug = async (slug: string) => data(await admin.query('componentLibraries.get', { slug }))

beforeAll(async () => {
  registry = await startTestRegistry([])
  work = await mkdtemp(join(tmpdir(), 'ow-cli-test-'))
  cliFile = join(work, 'ow-components.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../../../packages/components-cli/src/main.ts', import.meta.url))],
    outfile: cliFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  })
  process.env.COMPONENTS_CLI_FILE = cliFile
  env = await startTestApp({ NPM_REGISTRY_URL: registry.url, COMPONENT_BUILD_DIR: join(work, 'builds') })
  await env.app.listen({ port: 0, host: '127.0.0.1' })
  const address = env.app.server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const make = async (as: ReturnType<typeof trpc>) =>
    data(
      await as.mutate('accessTokens.create', {
        name: 'cli',
        scopes: ['component-libraries'],
        expiresAt: null,
      }),
    ).token as string
  token = await make(admin)
  memberToken = await make(member)
}, 120_000)
afterAll(async () => {
  delete process.env.COMPONENTS_CLI_FILE
  await env?.stop()
  await registry?.stop()
  await rm(work, { recursive: true, force: true })
})

describe('the components CLI', () => {
  it('is served by the instance', async () => {
    const res = await fetch(`${url}/api/cli/ow-components.mjs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain('ow-components: work on Optiply Workflows component libraries')
  })

  it('signs in with a token, kept readable by its owner only, and refuses a bad one', async () => {
    const bad = await cli(['login', url, '--token', `owpat_${'x'.repeat(43)}`])
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('refused the token')
    // From stdin, as when it's piped (a terminal is asked).
    const ok = await cli(['login', url], { input: `${token}\n` })
    expect(ok.err).toBe('')
    expect(ok.out).toContain(`Signed in to ${url} as admin@optiply.nl`)
    const config = join(work, 'config', 'config.json')
    expect((await stat(config)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ url, token })
  })

  it('inits a library and its folder, pushes local changes, and builds and publishes them', async () => {
    const init = await cli(['init', 'cli-lib', '--name', 'CLI library'])
    expect(init.err).toBe('')
    const dir = join(work, 'cli-lib')
    expect(JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))).toMatchObject({
      name: 'CLI library',
    })
    expect(await readFile(join(dir, 'src/Hello.tsx'), 'utf8')).toContain('export default')
    const state = JSON.parse(await readFile(join(dir, '.ow-components.json'), 'utf8'))
    expect(state).toMatchObject({ url, slug: 'cli-lib', revision: 1 })

    const source = await readFile(join(dir, 'src/Hello.tsx'), 'utf8')
    await writeFile(join(dir, 'src/Hello.tsx'), `${source}\n// edited locally\n`)
    await writeFile(join(dir, 'src/extra.ts'), 'export const EXTRA = 1\n')
    const pushed = await cli(['push', '--build', '--publish', '1.0.0', '--notes', 'From the CLI'], {
      cwd: dir,
    })
    expect(pushed.err).toBe('')
    expect(pushed.out).toContain('Pushed')
    expect(pushed.out).toContain('Built')
    expect(pushed.out).toContain('Published cli-lib 1.0.0')
    const lib = await libraryBySlug('cli-lib')
    expect(lib.draftRevision).toBe(2)
    const files = Object.fromEntries(
      lib.draftDefinition.files.map((f: { path: string; content: string }) => [f.path, f.content]),
    )
    expect(files['src/Hello.tsx']).toContain('// edited locally')
    expect(files['src/extra.ts']).toBe('export const EXTRA = 1\n')
    expect(lib.liveRelease).toMatchObject({ version: '1.0.0' })
    // Open editors learn of the push (and rebuild their Preview).
    expect(
      data(await admin.query('componentLibraries.lastPush', { componentLibraryId: lib.id })),
    ).toMatchObject({
      by: expect.any(String),
      revision: 2,
    })
  })

  it('refuses to push over a draft someone changed since, unless --force', async () => {
    const dir = join(work, 'cli-lib')
    const lib = await libraryBySlug('cli-lib')
    // Someone edits the draft in the browser.
    data(
      await admin.mutate('componentLibraries.saveDraft', {
        id: lib.id,
        revision: lib.draftRevision,
        definition: { ...lib.draftDefinition, allowedOrigins: [] },
      }),
    )
    const refused = await cli(['push'], { cwd: dir })
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('The draft changed')
    const forced = await cli(['push', '--force'], { cwd: dir })
    expect(forced.code).toBe(0)
  })

  it('pulls the draft, keeping local changes unless --force, and removes files the draft dropped', async () => {
    const dir = join(work, 'cli-lib')
    const lib = await libraryBySlug('cli-lib')
    data(
      await admin.mutate('componentLibraries.saveDraft', {
        id: lib.id,
        revision: lib.draftRevision,
        definition: {
          ...lib.draftDefinition,
          files: lib.draftDefinition.files.filter((f: { path: string }) => f.path !== 'src/extra.ts'),
        },
      }),
    )
    await writeFile(join(dir, 'src/Hello.tsx'), 'export default () => null // unsaved\n')
    const kept = await cli(['pull'], { cwd: dir })
    expect(kept.code).toBe(1)
    expect(kept.err).toContain('has changes since the last pull or push')
    const pulled = await cli(['pull', '--force'], { cwd: dir })
    expect(pulled.code).toBe(0)
    expect(await readFile(join(dir, 'src/Hello.tsx'), 'utf8')).toContain('// edited locally')
    await expect(stat(join(dir, 'src/extra.ts'))).rejects.toThrow()
  })

  it("shows a build's problems as file:line:column, and the folder's own problems", async () => {
    const dir = join(work, 'cli-lib')
    await writeFile(join(dir, 'src/Hello.tsx'), 'export default function Hello() {\n  return <div>\n}\n')
    const broken = await cli(['push', '--build'], { cwd: dir })
    expect(broken.code).toBe(1)
    expect(broken.err).toMatch(/src\/Hello\.tsx:\d+:\d+: /)
    await writeFile(join(dir, 'library.json'), '{ not json')
    const invalid = await cli(['push'], { cwd: dir })
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain("The folder's library isn't valid")
  })

  it('uploads a prebuilt bundle as a release', async () => {
    const out = join(work, 'prebuilt')
    await rm(out, { recursive: true, force: true })
    await import('node:fs/promises').then((fs) => fs.mkdir(out))
    await writeFile(
      join(out, 'manifest.json'),
      JSON.stringify({
        components: [
          { name: 'Badge', label: 'Badge', entry: 'src/Badge.tsx', props: {}, defaultSize: { w: 2, h: 2 } },
        ],
      }),
    )
    await writeFile(join(out, 'bundle.js'), 'export const Badge = () => null\n')
    const uploaded = await cli(['push', '--prebuilt', out, '--slug', 'cli-lib', '--version', '2.0.0'])
    expect(uploaded.err).toBe('')
    expect(uploaded.out).toContain('Uploaded cli-lib 2.0.0')
  })

  it("acts with its user's permissions, and through OW_URL and OW_TOKEN", async () => {
    const denied = await cli(['init', 'member-lib'], { env: { OW_URL: url, OW_TOKEN: memberToken } })
    expect(denied.code).toBe(1)
    expect(denied.err).toContain('You need edit access')
    const unsigned = await cli(['pull', 'cli-lib'], { env: { OW_CONFIG_DIR: join(work, 'nowhere') } })
    expect(unsigned.code).toBe(1)
    expect(unsigned.err).toContain('Not signed in')
  })

  it('dev pushes a saved change into the draft', async () => {
    const dir = join(work, 'dev-lib')
    expect((await cli(['init', 'dev-lib'])).code).toBe(0)
    const child = spawn(process.execPath, [cliFile, 'dev'], {
      cwd: dir,
      env: { PATH: process.env.PATH, OW_CONFIG_DIR: join(work, 'config') },
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    try {
      await expect.poll(() => output, { timeout: 60_000 }).toContain('Built')
      await writeFile(
        join(dir, 'src/Hello.tsx'),
        'export default function Hello() {\n  return <b>from dev</b>\n}\n',
      )
      await expect
        .poll(
          async () =>
            (await libraryBySlug('dev-lib')).draftDefinition.files.find(
              (f: { path: string }) => f.path === 'src/Hello.tsx',
            )?.content,
          { timeout: 60_000 },
        )
        .toContain('from dev')
    } finally {
      child.kill('SIGTERM')
    }
  })
})
