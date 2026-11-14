/**
 * SDK resources' packages (M37, docs/architecture.md §2.41): the builder installs a JavaScript SDK from npm registries
 * (`/build-npm`: no install scripts, a private registry's token never in its answer) and a Python SDK from an index
 * (`/build`), into the envs volume; the SDK runner imports them from there.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
} from '../src/testing'

const available =
  executorAvailable() && !process.env.PYTHON_EXECUTOR_TEST_URL && !process.env.SDK_RUNNER_TEST_URL
const TOKEN = 'npm-Private-Token-77'
let index: TestIndex
let registry: TestRegistry
let privateRegistry: TestRegistry
let builder: TestBuilder
let runner: TestSdkRunner
let volume: ReturnType<typeof testEnvsVolume>

interface NpmAnswer {
  ok: boolean
  envId?: string
  lock?: { node: string; dependencies: Record<string, string>; packages: Record<string, string> }
  cached?: boolean
  log?: string
  error?: { kind: string; message: string }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${builder.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${builder.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function buildNpm(
  dependencies: Record<string, string>,
  registries: unknown[] = [],
): Promise<NpmAnswer> {
  const res = await post('/build-npm', {
    dependencies,
    registries: [{ scope: null, url: `${registry.url}/` }, ...registries],
  })
  expect(res.status).toBe(200)
  return (await res.json()) as NpmAnswer
}

async function call(body: Record<string, unknown>) {
  const res = await fetch(`${runner.url}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      context: { token: 't', baseUrl: null, options: {}, secrets: {} },
      allowedHosts: [],
      timeoutMs: 20_000,
      ...body,
    }),
  })
  return (await res.json()) as { ok: boolean; result?: unknown; error?: { kind: string; message: string } }
}

describe.skipIf(!available)('SDK packages', () => {
  beforeAll(async () => {
    registry = await startTestRegistry(
      [
        {
          name: 'acme-sdk',
          version: '2.1.0',
          dependencies: { 'acme-util': '^1.0.0' },
          files: {
            'index.js':
              "const { shout } = require('acme-util')\nclass Client { constructor(o) { this.o = o } hello(n) { return shout('hello ' + n) } }\nmodule.exports = { Client }\n",
          },
          // Never run: npm installs with --ignore-scripts.
          scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran-postinstall', '1')\"" },
        },
        { name: 'acme-sdk', version: '1.0.0', files: { 'index.js': 'module.exports = {}\n' } },
        {
          name: 'acme-util',
          version: '1.2.0',
          files: { 'index.js': 'exports.shout = (s) => s.toUpperCase()\n' },
        },
      ],
      { forContainers: true },
    )
    privateRegistry = await startTestRegistry(
      [
        {
          name: '@acme/private',
          version: '0.3.0',
          files: { 'index.js': "exports.secret = () => 'only for acme'\n" },
        },
      ],
      { forContainers: true, token: TOKEN },
    )
    index = await startTestIndex([
      {
        name: 'acme-py',
        version: '3.0.0',
        files: {
          'acme_py/__init__.py':
            'class Client:\n    def __init__(self, token):\n        self.token = token\n    def whoami(self):\n        return {"token_length": len(self.token)}\n',
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
  })
  afterAll(async () => {
    await runner?.stop()
    await builder?.stop()
    volume?.remove()
    await registry?.stop()
    await privateRegistry?.stop()
    await index?.stop()
  })

  it('installs a JavaScript SDK with its dependencies, no install scripts; the second time from the env', async () => {
    const first = await buildNpm({ 'acme-sdk': '^2.0.0' })
    expect(first).toMatchObject({
      ok: true,
      envId: expect.stringMatching(/^[0-9a-f]{32}$/),
      cached: false,
      lock: {
        dependencies: { 'acme-sdk': '^2.0.0' },
        packages: { 'acme-sdk': '2.1.0', 'acme-util': '1.2.0' },
        node: expect.stringMatching(/^v24/),
      },
    })
    const again = await buildNpm({ 'acme-sdk': '^2.0.0' })
    expect(again).toMatchObject({ ok: true, envId: first.envId, cached: true })
    const files = execFileSync('docker', [
      'exec',
      builder.container,
      'find',
      `/envs/node/${first.envId}`,
      '-name',
      'ran-postinstall',
    ]).toString()
    expect(files.trim()).toBe('')
    // The runner imports it from the env.
    const called = await call({
      language: 'javascript',
      envId: first.envId,
      mode: 'call',
      method: 'hello',
      args: ['ada'],
      setup: "import { Client } from 'acme-sdk'\nexport default ({ token }) => new Client({ token })\n",
    })
    expect(called).toEqual({ ok: true, result: 'HELLO ADA', logs: [], blocked: [], connections: 0 })
  })

  it('takes a scoped package from a private registry with its token, and never says the token', async () => {
    const answer = await buildNpm({ '@acme/private': '0.3.0' }, [
      { scope: '@acme', url: privateRegistry.url, token: TOKEN },
    ])
    expect(answer).toMatchObject({ ok: true, lock: { packages: { '@acme/private': '0.3.0' } } })
    expect(privateRegistry.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true)
    // Another range: the same one would come from the env already installed (tokens aren't part of its key).
    const refused = await buildNpm({ '@acme/private': '^0.3.0' }, [
      { scope: '@acme', url: privateRegistry.url, token: 'wrong-token' },
    ])
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).not.toContain('wrong-token')
  })

  it('says what is wrong: no such version, a git URL, a bad name, an http registry without leave', async () => {
    const missing = await buildNpm({ 'acme-sdk': '^9.0.0' })
    expect(missing).toMatchObject({ ok: false, error: { kind: 'resolve' } })
    const bad: Record<string, string>[] = [
      { 'acme-sdk': 'git+https://evil/x.git' },
      { 'Not A Name': '1' },
      {},
    ]
    for (const deps of bad) {
      expect((await buildNpm(deps)).error?.kind).toBe('invalid')
    }
  })

  it('installs a Python SDK with /build; the runner imports it', async () => {
    const res = await post('/build', { requirements: ['acme-py==3.0.0'] })
    const built = (await res.json()) as { ok: boolean; envId: string }
    expect(built.ok).toBe(true)
    const called = await call({
      language: 'python',
      envId: built.envId,
      mode: 'call',
      method: 'whoami',
      setup: 'import acme_py\ndef client(token):\n    return acme_py.Client(token)\n',
    })
    expect(called).toMatchObject({ ok: true, result: { token_length: 1 } })
  })
})
