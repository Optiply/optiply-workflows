/**
 * Packages without a wheel (M32, docs/architecture.md §2.35): the builder fetches the sdist itself, downloads its
 * declared build requirements as wheels, builds the wheel in nsjail (offline, no token, not the envs volume), keeps
 * it by the sdist's hash, and locks the sdist.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executorAvailable,
  startTestBuilder,
  startTestIndex,
  type TestBuilder,
  type TestIndex,
} from '../src/testing'

interface Lock {
  platform: string
  packages: { name: string; version: string; sha256: string; index?: string; source?: string }[]
}
interface Answer {
  ok: boolean
  envId?: string
  lock?: Lock
  cached?: boolean
  error?: { kind: string; message: string }
  log: string
}

const available = executorAvailable()
let index: TestIndex
let privateIndex: TestIndex
let builder: TestBuilder

async function call(path: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${builder.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${builder.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Answer
}
const sh = (command: string) =>
  execFileSync('docker', ['exec', builder.container, 'sh', '-c', command]).toString()

/**
 * Build-time Python (in the jail) recording what the build could reach, as a module of the wheel. With no network
 * at all (no interface up, no route) a connection fails at once with ENETUNREACH; with one it would time out or be
 * refused (TEST-NET's 192.0.2.1 answers nothing).
 */
const PROBE = `
import errno, os, socket
facts = {"envs": os.path.exists("/envs"), "proc": os.path.exists("/proc/1"), "token": "PYTHON_BUILDER_TOKEN" in os.environ}
try:
    socket.create_connection(("192.0.2.1", 80), timeout=2).close()
    facts["network"] = True
except OSError as e:
    facts["network"] = e.errno != errno.ENETUNREACH
files["owtest_probe.py"] = "FACTS = %r\\n" % facts
`

describe.skipIf(!available)("the package builder's sdists", () => {
  beforeAll(async () => {
    index = await startTestIndex([
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
      {
        name: 'owtest-src',
        version: '1.0.0',
        requires: ['owtest-b'],
        files: { 'owtest_src/__init__.py': 'from owtest_b import VERSION as B\nNAME = "src"\n' },
        sdist: {},
      },
      { name: 'owtest-probe', version: '1.0.0', sdist: { hook: PROBE } },
      { name: 'owtest-boom', version: '1.0.0', sdist: { hook: 'raise RuntimeError("boom at build time")' } },
      { name: 'owtest-greedy', version: '1.0.0', sdist: { dynamicRequires: ['owtest-hidden'] } },
      {
        name: 'owtest-buildtool',
        version: '1.0.0',
        files: { 'owtest_buildtool.py': 'TOOL = "made with it"\n' },
      },
      {
        name: 'owtest-tooled',
        version: '1.0.0',
        sdist: {
          buildRequires: ['owtest-buildtool'],
          hook: 'import owtest_buildtool\nfiles["owtest_tooled.py"] = "TOOL = %r\\n" % owtest_buildtool.TOOL',
        },
      },
      { name: 'owtest-untooled', version: '1.0.0', sdist: { buildRequires: ['owtest-absent'] } },
    ])
    privateIndex = await startTestIndex(
      [{ name: 'owtest-psrc', version: '2.0.0', files: { 'owtest_psrc.py': 'P = 2\n' }, sdist: {} }],
      { auth: { username: 'ci', password: 'pw-for-sdists' } },
    )
    builder = await startTestBuilder({ indexUrl: index.url })
  })
  afterAll(async () => {
    await builder?.stop()
    await privateIndex?.stop()
    await index?.stop()
  })

  it('builds a package that has only an sdist, resolves its dependencies as wheels, and locks the sdist', async () => {
    const built = await call('/build', { requirements: ['owtest-src'] })
    expect(built).toMatchObject({ ok: true })
    expect(built.lock!.packages).toEqual([
      { name: 'owtest-b', version: '1.0.0', sha256: index.hashes['owtest-b==1.0.0'] },
      { name: 'owtest-src', version: '1.0.0', sha256: index.hashes['owtest-src==1.0.0'], source: 'sdist' },
    ])
    expect(built.log).toContain('owtest-src 1.0.0: no wheel, building owtest_src-1.0.0.tar.gz from source')
    expect(sh(`ls /envs/${built.envId}/site`)).toContain('owtest_src')
    expect(sh(`ls /envs/.wheels/${index.hashes['owtest-src==1.0.0']}`).trim()).toBe(
      'owtest_src-1.0.0-py3-none-any.whl',
    )
    // Kept: the next build of it doesn't build again.
    const again = await call('/build', { requirements: ['owtest-src==1.0.0'] })
    expect(again.log).toContain('owtest-src 1.0.0: built from source before')
  })

  it('installs a lock with an sdist again, building it again when its wheel is gone', async () => {
    const built = await call('/build', { requirements: ['owtest-src'] })
    sh(`rm -rf /envs/${built.envId} /envs/.wheels/${index.hashes['owtest-src==1.0.0']}`)
    const installed = await call('/install', { lock: built.lock })
    expect(installed).toMatchObject({ ok: true, cached: false, envId: built.envId })
    expect(installed.log).toContain('building owtest_src-1.0.0.tar.gz from source')
    expect(sh(`ls /envs/${built.envId}/site`)).toContain('owtest_src')
  })

  it('builds in a jail: no network, no envs volume, no token, no other processes', async () => {
    const built = await call('/build', { requirements: ['owtest-probe'] })
    expect(built).toMatchObject({ ok: true })
    const probe = sh(`cat /envs/${built.envId}/site/owtest_probe.py`)
    expect(probe).toContain("'envs': False")
    expect(probe).toContain("'proc': False")
    expect(probe).toContain("'token': False")
    expect(probe).toContain("'network': False")
  })

  it('gives the build its declared build requirements, as wheels', async () => {
    const built = await call('/build', { requirements: ['owtest-tooled'] })
    expect(built).toMatchObject({ ok: true })
    expect(sh(`cat /envs/${built.envId}/site/owtest_tooled.py`)).toContain('made with it')
  })

  it("says why an sdist didn't build: its error, an undeclared build requirement, a missing one", async () => {
    const boom = await call('/build', { requirements: ['owtest-boom'] })
    expect(boom).toMatchObject({
      ok: false,
      error: {
        kind: 'sdist',
        message: expect.stringContaining('Building owtest-boom 1.0.0 from source failed'),
      },
    })
    expect(boom.log).toContain('boom at build time')
    const greedy = await call('/build', { requirements: ['owtest-greedy'] })
    expect(greedy).toMatchObject({
      ok: false,
      error: { kind: 'sdist', message: expect.stringContaining('asked for owtest-hidden') },
    })
    const untooled = await call('/build', { requirements: ['owtest-untooled'] })
    expect(untooled).toMatchObject({
      ok: false,
      error: { kind: 'sdist', message: expect.stringContaining("(owtest-absent) couldn't be downloaded") },
    })
    expect(sh('ls -A /envs/.wheels | grep -c "^.tmp-" || true').trim()).toBe('0')
  })

  it('fetches an sdist from a private index with its sign-in, and names the index in the lock', async () => {
    const indexes = [
      { name: 'private', url: privateIndex.url, mode: 'extra', username: 'ci', password: 'pw-for-sdists' },
    ]
    const built = await call('/build', { requirements: ['owtest-psrc'], indexes })
    expect(built).toMatchObject({ ok: true })
    expect(built.lock!.packages).toEqual([
      {
        name: 'owtest-psrc',
        version: '2.0.0',
        sha256: privateIndex.hashes['owtest-psrc==2.0.0'],
        index: 'private',
        source: 'sdist',
      },
    ])
    expect(JSON.stringify(built)).not.toContain('pw-for-sdists')
  })
})
