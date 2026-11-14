import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  executorAvailable,
  startTestBuilder,
  startTestIndex,
  startTestRegistry,
  startTestSdkRunner,
  type TestBuilder,
  type TestIndex,
  type TestRegistry,
  type TestSdkRunner,
  testEnvsVolume,
} from '@ow/code-executor/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forgetSdkEnvs } from '../src/services/sdk-envs'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// SDK resources (M37, docs/architecture.md §2.41) through the API, with the real builder and SDK runner: a JavaScript
// SDK from an npm registry signed in with OAuth client credentials, a Python SDK from an index with a pasted token;
// installed on first use, called, described and run as snippets from the playground; hosts the resource doesn't name
// blocked; the tokens never coming back; the settings checked on save, a private network an admin's choice.

const available =
  executorAvailable() && !process.env.PYTHON_EXECUTOR_TEST_URL && !process.env.SDK_RUNNER_TEST_URL

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberId: string
let prodId: string
let registry: TestRegistry
let index: TestIndex
let builder: TestBuilder
let runner: TestSdkRunner
let volume: ReturnType<typeof testEnvsVolume>
let api: Server
let apiHost: string
let tokenServer: Server
let tokenUrl: string
const seen: string[] = []
const CC_TOKEN = 'cc-Access-Token-4242'
const PASTED = 'pasted-Token-1717'
let tokensIssued = 0

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

async function sdkResource(slug: string, config: unknown, secrets: unknown) {
  const created = data(await admin.mutate('resources.create', { type: 'sdk', name: slug, slug }))
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config,
      secrets,
    }),
  )
  return created.id as string
}

const run = async (resourceId: string, query: Record<string, string>, scope: Record<string, unknown> = {}) =>
  data(await admin.mutate('resources.run', { resourceId, environmentId: prodId, query, scope }))

const JS_SETUP =
  "import { Acme } from 'acme-sdk'\nexport default ({ token, baseUrl }) => new Acme({ token, baseUrl })\n"
const PY_SETUP = 'import acme_py\n\ndef client(token, base_url):\n    return acme_py.Acme(token, base_url)\n'

describe.skipIf(!available)('SDK resources', () => {
  beforeAll(async () => {
    // The company's API: who's calling, by their token.
    api = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${CC_TOKEN}` && auth !== `Bearer ${PASTED}`) {
        res.writeHead(401)
        return res.end('{"error":"unauthorized"}')
      }
      res.end(JSON.stringify({ path: req.url, caller: auth === `Bearer ${CC_TOKEN}` ? 'cc' : 'pasted' }))
    })
    await new Promise<void>((resolve) => api.listen(0, '0.0.0.0', resolve))
    apiHost = `host.docker.internal:${(api.address() as AddressInfo).port}`
    // Its OAuth token endpoint (client credentials), reached by the server itself.
    tokenServer = createServer((_req, res) => {
      tokensIssued++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: CC_TOKEN, token_type: 'Bearer', expires_in: 3600 }))
    })
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve))
    tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`

    registry = await startTestRegistry(
      [
        {
          name: 'acme-sdk',
          version: '2.1.0',
          files: {
            'index.js': [
              'class Acme {',
              '  #token',
              '  constructor({ token, baseUrl }) { this.#token = token; this.baseUrl = baseUrl }',
              "  async get(path) { const r = await fetch(this.baseUrl + path, { headers: { authorization: 'Bearer ' + this.#token } }); if (!r.ok) { const e = new Error('Acme said ' + r.status); e.status = r.status; throw e } return r.json() }",
              '}',
              'module.exports = { Acme }',
            ].join('\n'),
          },
        },
      ],
      { forContainers: true },
    )
    index = await startTestIndex([
      {
        name: 'acme-py',
        version: '3.0.0',
        files: {
          'acme_py/__init__.py': [
            'import json, urllib.request',
            'class Acme:',
            '    def __init__(self, token, base_url):',
            '        self._token, self.base_url = token, base_url',
            '    def get(self, path):',
            '        """Fetches a path."""',
            '        print("getting", path)',
            '        req = urllib.request.Request(self.base_url + path, headers={"Authorization": "Bearer " + self._token})',
            '        return json.loads(urllib.request.urlopen(req, timeout=10).read())',
          ].join('\n'),
        },
      },
    ])
    volume = testEnvsVolume()
    builder = await startTestBuilder({
      indexUrl: index.url,
      envsVolume: volume.name,
      env: { NPM_ALLOW_INSECURE_REGISTRIES: '1' },
    })
    runner = await startTestSdkRunner({ envsVolume: volume.name })
    env = await startTestApp({
      PYTHON_BUILDER_URL: builder.url,
      PYTHON_BUILDER_TOKEN: builder.token,
      SDK_RUNNER_URL: runner.url,
      SDK_RUNNER_TOKEN: runner.token,
      NPM_REGISTRY_URL: `${registry.url}/`,
    })
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    memberId = (await createLocalUser(env.db, 'member@example.com')).id
    admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'), { record: seen })
    member = trpc(env.app, await login(env.app, 'member@example.com'))
    prodId = data(await admin.query('environments.list')).find(
      (e: { slug: string }) => e.slug === 'production',
    ).id
  })
  afterAll(async () => {
    forgetSdkEnvs()
    await env?.stop()
    await runner?.stop()
    await builder?.stop()
    volume?.remove()
    await registry?.stop()
    await index?.stop()
    await new Promise((r) => api?.close(r))
    await new Promise((r) => tokenServer?.close(r))
  })

  it('a JavaScript SDK with client credentials: installed on first use, tested, called, its token never back', async () => {
    const id = await sdkResource(
      'acme_js',
      {
        language: 'javascript',
        packages: ['acme-sdk@^2'],
        baseUrl: `http://${apiHost}`,
        allowPrivateNetwork: true,
        setup: JS_SETUP,
        auth: { type: 'oauth2ClientCredentials', tokenUrl, clientId: 'acme-app', clientAuth: 'body' },
      },
      { clientSecret: 'cc-secret' },
    )
    const tested = data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId }))
    expect(tested).toMatchObject({ ok: true, message: expect.stringContaining('installed acme-sdk 2.1.0') })
    const called = await run(id, { action: 'call', method: 'get', args: '["/orders/{{ n }}"]' }, { n: 7 })
    // Test connection's client is its own; the queries' pooled client then keeps its token.
    const issued = tokensIssued
    expect(called).toMatchObject({
      ok: true,
      data: { path: '/orders/7', caller: 'cc' },
      metadata: { language: 'javascript', packages: { 'acme-sdk': '2.1.0' }, connections: 1 },
    })
    // The token the setup code got never comes back, even returned on purpose.
    const leaked = await run(id, { action: 'code', code: 'return { token, again: token }' })
    expect(JSON.stringify(leaked)).not.toContain(CC_TOKEN)
    const described = await run(id, { action: 'describe' })
    expect(described.data).toMatchObject({
      type: 'Acme',
      members: expect.arrayContaining([{ path: 'get', kind: 'method', signature: '(path)' }]),
    })
    // Another host than the base URL's is blocked, and said so.
    const blocked = await run(id, {
      action: 'code',
      code: "return (await fetch('https://example.com')).status",
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.error.message).toContain('Blocked: example.com:443')
    expect(tokensIssued).toBe(issued)
    expect(seen.join('\n')).not.toContain(CC_TOKEN)
  })

  it('a Python SDK with a pasted token: its prints, its errors with their status, a missing method', async () => {
    const id = await sdkResource(
      'acme_py',
      {
        language: 'python',
        packages: ['acme-py==3.0.0'],
        baseUrl: `http://${apiHost}`,
        allowPrivateNetwork: true,
        setup: PY_SETUP,
        auth: { type: 'bearer' },
      },
      { bearerToken: PASTED },
    )
    const called = await run(id, { action: 'call', method: 'get', args: '["/me"]' })
    expect(called).toMatchObject({
      ok: true,
      data: { path: '/me', caller: 'pasted' },
      metadata: { packages: { 'acme-py': '3.0.0' } },
    })
    const missing = await run(id, { action: 'call', method: 'nope' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'sdk_method' } })
    const snippet = await run(id, {
      action: 'code',
      code: 'return client.get(params["path"])',
      params: '{"path": "/x"}',
    })
    expect(snippet.data).toEqual({ path: '/x', caller: 'pasted' })
    expect(seen.join('\n')).not.toContain(PASTED)
  })

  it('checks the settings on save; a private network is an admin’s choice', async () => {
    const created = data(
      await admin.mutate('resources.create', { type: 'sdk', name: 'Bad', slug: 'bad_sdk' }),
    )
    const save = (as: ReturnType<typeof trpc>, config: unknown, secrets: unknown = { bearerToken: 'x' }) =>
      as.mutate('resources.saveConfig', { resourceId: created.id, environmentId: prodId, config, secrets })
    expect((await save(admin, { language: 'python', setup: '' })).body.error?.message).toContain('setup code')
    expect(
      (await save(admin, { language: 'python', setup: 'x', packages: ['git+https://x'] })).body.error
        ?.message,
    ).toContain('Packages')
    expect(
      (await save(admin, { language: 'javascript', setup: 'x', packages: ['acme-sdk@^2'] }, {})).body.error
        ?.message,
    ).toContain('Add the token')
    // OAuth sign-in may be a public (PKCE) client: no secret needed; client credentials need one.
    const oauth = {
      type: 'oauth2AuthorizationCode',
      authorizeUrl: 'https://auth.acme.com/a',
      tokenUrl: 'https://auth.acme.com/t',
      clientId: 'c',
    }
    expect((await save(admin, { language: 'python', setup: 'x', auth: oauth }, {})).status).toBe(200)
    const cc = { type: 'oauth2ClientCredentials', tokenUrl: 'https://auth.acme.com/t', clientId: 'c' }
    expect(
      (await save(admin, { language: 'python', setup: 'x', auth: cc }, {})).body.error?.message,
    ).toContain('client secret')
    const groupId = data(await admin.mutate('groups.create', { name: 'SDK editors' })).id
    await admin.mutate('groups.addMember', { groupId, userId: memberId })
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: created.id,
        groupId,
        environmentId: null,
        level: 'edit',
      }),
    )
    const ok = { language: 'python', setup: 'def client():\n    return 1\n', baseUrl: 'https://api.acme.com' }
    expect((await save(member, ok)).status).toBe(200)
    expect((await save(member, { ...ok, allowPrivateNetwork: true })).status).toBe(403)
    expect((await save(admin, { ...ok, allowPrivateNetwork: true })).status).toBe(200)
  })
})
