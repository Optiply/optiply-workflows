/**
 * npm registries for component libraries (M33, docs/architecture.md §2.36): admins define one per scope with a token
 * in a secret config var; builds install a scoped package from it, the token only in the build's .npmrc (never in
 * the lock, a log or an answer); everything else from the default registry.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyComponentLibrary } from '@ow/app-definition'
import { environments } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

const TOKEN = 'npm-token-for-tests-1234'
let env: TestEnv
let publicRegistry: TestRegistry
let privateRegistry: TestRegistry
let work: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

/** A library whose component imports the scoped package and a public one. */
async function libraryUsing(slug: string, dependencies: Record<string, string>) {
  const lib = data(await admin.mutate('componentLibraries.create', { slug, name: slug, folderId: null }))
  const base = emptyComponentLibrary()
  const definition = {
    ...base,
    dependencies,
    files: [
      {
        path: 'src/Hello.tsx',
        content: [
          ...Object.keys(dependencies).map((d, i) => `import dep${i} from '${d}'`),
          `export default function Hello() { return <b>{${
            Object.keys(dependencies)
              .map((_, i) => `String(dep${i})`)
              .join(' + ') || "''"
          }}</b> }`,
        ].join('\n'),
      },
    ],
  }
  data(await admin.mutate('componentLibraries.saveDraft', { id: lib.id, revision: 1, definition }))
  return lib.id as string
}

beforeAll(async () => {
  publicRegistry = await startTestRegistry([
    { name: 'shout', version: '1.2.0', files: { 'index.js': 'module.exports = "public"' } },
  ])
  privateRegistry = await startTestRegistry(
    [{ name: '@acme/greeting', version: '1.0.0', files: { 'index.js': 'module.exports = "private"' } }],
    { token: TOKEN },
  )
  work = await mkdtemp(join(tmpdir(), 'ow-registries-test-'))
  env = await startTestApp({
    NPM_REGISTRY_URL: publicRegistry.url,
    COMPONENT_BUILD_DIR: work,
    NPM_ALLOW_INSECURE_REGISTRIES: 'true',
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const [defaultEnv] = await env.db.select().from(environments).where(eq(environments.isDefault, true))
  const secret = data(await admin.mutate('configVars.create', { name: 'ACME_NPM_TOKEN', isSecret: true }))
  data(
    await admin.mutate('configVars.setValue', {
      configVarId: secret.id,
      environmentId: defaultEnv!.id,
      value: TOKEN,
    }),
  )
  data(await admin.mutate('configVars.create', { name: 'EMPTY_NPM_TOKEN', isSecret: true }))
}, 120_000)
afterAll(async () => {
  await env?.stop()
  await publicRegistry?.stop()
  await privateRegistry?.stop()
  await rm(work, { recursive: true, force: true })
})

describe('npm registries', () => {
  it('lets admins define one per scope and test its token', async () => {
    const fields = { scope: '@acme', url: privateRegistry.url, tokenConfigVar: 'ACME_NPM_TOKEN' }
    expect((await member.mutate('npmRegistries.create', fields)).status).toBe(403)
    expect(data(await admin.mutate('npmRegistries.test', fields))).toEqual({ ok: true, username: 'ci' })
    expect(data(await admin.mutate('npmRegistries.test', { ...fields, tokenConfigVar: null }))).toMatchObject(
      {
        ok: false,
        message: 'The registry wants a token',
      },
    )
    expect(data(await admin.mutate('npmRegistries.create', fields)).id).toBeTruthy()
    expect((await admin.mutate('npmRegistries.create', fields)).body.error?.message).toContain('already')
    expect((await admin.mutate('npmRegistries.create', { ...fields, scope: 'acme' })).status).toBe(400)
    expect(
      (await admin.mutate('npmRegistries.create', { ...fields, scope: '@other', url: 'ftp://x.example' }))
        .status,
    ).toBe(400)
    const listed = data(await member.query('npmRegistries.list'))
    expect(listed).toEqual([expect.objectContaining({ scope: '@acme', withToken: true })])
    expect(listed[0]).not.toHaveProperty('tokenConfigVar')
  })

  it('builds a library with a scoped package from its registry, the rest from the default, no token kept', async () => {
    const id = await libraryUsing('scoped', { '@acme/greeting': '^1.0.0', shout: '^1.2.0' })
    const built = data(await admin.mutate('componentLibraries.build', { componentLibraryId: id }))
    expect(built).toMatchObject({ ok: true })
    expect(built.lock).toContain(`${privateRegistry.url}/@acme/greeting/-/`)
    expect(built.lock).not.toContain(TOKEN)
    // The private registry got the scoped package with its token; the public one never heard of it.
    const scoped = privateRegistry.requests
      .map((path, i) => [path, privateRegistry.authorizations[i]] as const)
      .filter(([path]) => path.includes('@acme/greeting'))
    expect(scoped.length).toBeGreaterThan(0)
    for (const [, auth] of scoped) expect(auth).toBe(`Bearer ${TOKEN}`)
    expect(publicRegistry.requests.some((p) => p.includes('@acme'))).toBe(false)
    expect(publicRegistry.requests.some((p) => p.includes('shout'))).toBe(true)
    expect(JSON.stringify(built)).not.toContain(TOKEN)
  })

  it("keeps the build's .npmrc out of the library's reach", async () => {
    // The build directory is the bundler's; the token's .npmrc is elsewhere, gone once npm is done.
    const id = await libraryUsing('peeking', { '@acme/greeting': '^1.0.0' })
    const lib = data(await admin.query('componentLibraries.get', { id }))
    const files = [
      ...lib.draftDefinition.files,
      {
        path: 'src/peek.ts',
        content: "import t from '../.home/.npmrc' with { type: 'text' }\nexport default t\n",
      },
    ]
    const hello = files.find((f: { path: string }) => f.path === 'src/Hello.tsx')
    hello.content = `import peek from './peek'\n${hello.content.replace('<b>{', '<b>{peek + ')}`
    data(
      await admin.mutate('componentLibraries.saveDraft', {
        id,
        revision: lib.draftRevision,
        definition: { ...lib.draftDefinition, files },
      }),
    )
    const built = data(await admin.mutate('componentLibraries.build', { componentLibraryId: id }))
    expect(built.ok).toBe(false)
    expect(JSON.stringify(built)).not.toContain(TOKEN)
  })

  it('refuses a token with a line break, and ends registry URLs with a slash', async () => {
    const [registry] = data(await admin.query('npmRegistries.list'))
    const [defaultEnv] = await env.db.select().from(environments).where(eq(environments.isDefault, true))
    const secret = data(await admin.mutate('configVars.create', { name: 'SNEAKY_NPM_TOKEN', isSecret: true }))
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: secret.id,
        environmentId: defaultEnv!.id,
        value: `${TOKEN}\n@acme:registry=https://evil.example/`,
      }),
    )
    data(
      await admin.mutate('npmRegistries.update', {
        id: registry.id,
        scope: '@acme',
        url: `${privateRegistry.url}/some/path`,
        tokenConfigVar: 'SNEAKY_NPM_TOKEN',
      }),
    )
    expect(data(await admin.query('npmRegistries.list'))[0].url).toBe(`${privateRegistry.url}/some/path/`)
    const id = await libraryUsing('sneaky', { '@acme/greeting': '1.0.0' })
    const built = data(await admin.mutate('componentLibraries.build', { componentLibraryId: id }))
    expect(built).toMatchObject({ ok: false, stage: 'install' })
    expect(built.problems[0].message).toContain('line breaks')
    data(
      await admin.mutate('npmRegistries.update', {
        id: registry.id,
        scope: '@acme',
        url: privateRegistry.url,
        tokenConfigVar: 'ACME_NPM_TOKEN',
      }),
    )
  })

  it("fails a build whose registry's token has no value, naming the var", async () => {
    const [registry] = data(await admin.query('npmRegistries.list'))
    data(
      await admin.mutate('npmRegistries.update', {
        id: registry.id,
        scope: '@acme',
        url: privateRegistry.url,
        tokenConfigVar: 'EMPTY_NPM_TOKEN',
      }),
    )
    // Other files: not the cached build of the test before.
    const id = await libraryUsing('scoped-empty', { '@acme/greeting': '1.0.0' })
    const built = data(await admin.mutate('componentLibraries.build', { componentLibraryId: id }))
    expect(built).toMatchObject({ ok: false, stage: 'install' })
    expect(built.problems[0].message).toContain('EMPTY_NPM_TOKEN')
    data(await admin.mutate('npmRegistries.delete', { id: registry.id }))
    expect(data(await admin.query('npmRegistries.list'))).toEqual([])
  })
})
