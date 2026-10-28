/**
 * The package builder (M23, docs/architecture.md §2.26) against its real container and a local package index: the
 * lock, the env on the volume, installs from a lock, and the limits.
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
  packages: { name: string; version: string; sha256: string }[]
}
interface Answer {
  ok: boolean
  envId?: string
  lock?: Lock
  sizeBytes?: number
  cached?: boolean
  error?: { kind: string; message: string }
  log: string
}

const available = executorAvailable()
let index: TestIndex
let builder: TestBuilder

async function post(path: string, body: unknown, of: TestBuilder = builder, token = of.token) {
  return fetch(`${of.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function call(path: string, body: unknown, of: TestBuilder = builder): Promise<Answer> {
  const res = await post(path, body, of)
  expect(res.status).toBe(200)
  return (await res.json()) as Answer
}
const sh = (of: TestBuilder, command: string) =>
  execFileSync('docker', ['exec', of.container, 'sh', '-c', command]).toString()

describe.skipIf(!available)('the package builder', () => {
  beforeAll(async () => {
    index = await startTestIndex([
      {
        name: 'owtest-a',
        version: '1.0.0',
        requires: ['owtest-b>=1'],
        files: { 'owtest_a/__init__.py': 'from owtest_b import VERSION as B\nNAME = "a"\n' },
      },
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
      { name: 'owtest-b', version: '2.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "2.0.0"\n' } },
      { name: 'owtest-c', version: '1.0.0', sdistOnly: true },
      { name: 'owtest-slow', version: '1.0.0', delayMs: 7000, files: { 'owtest_slow.py': 'X = 1\n' } },
      { name: 'owtest-slow2', version: '1.0.0', delayMs: 3000, files: { 'owtest_slow2.py': 'X = 2\n' } },
    ])
    builder = await startTestBuilder({ indexUrl: index.url })
  })
  afterAll(async () => {
    await builder?.stop()
    await index?.stop()
  })

  it('reports its Python, platform and pip, and needs its token', async () => {
    const health = (await (await fetch(`${builder.url}/health`)).json()) as Record<string, string>
    expect(health).toMatchObject({ ok: true, python: expect.stringMatching(/^3\.12\./), pip: '26.2.1' })
    expect(health.platform).toMatch(/^cp312-linux-(aarch64|x86_64)$/)
    expect((await post('/build', { requirements: [] }, builder, 'wrong-token-wrong-token')).status).toBe(401)
  })

  it('refuses requirements that are more than names and versions', async () => {
    for (const requirements of [
      ['-e git+https://github.com/x/y'],
      ['--index-url=https://evil.example/simple'],
      ['pkg @ https://example.com/pkg.whl'],
      ['pkg; sys_platform == "linux"'],
      ['./local'],
      Array.from({ length: 501 }, (_, i) => `p${i}`),
      'owtest-a',
    ]) {
      expect((await post('/build', { requirements })).status).toBe(400)
    }
  })

  it('resolves into a lock and installs it as an env, once', async () => {
    const built = await call('/build', { requirements: ['owtest-a'] })
    expect(built).toMatchObject({ ok: true, cached: false, envId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(built.lock!.packages).toEqual([
      { name: 'owtest-a', version: '1.0.0', sha256: index.hashes['owtest-a==1.0.0'] },
      { name: 'owtest-b', version: '2.0.0', sha256: index.hashes['owtest-b==2.0.0'] },
    ])
    expect(built.sizeBytes).toBeGreaterThan(0)
    const env = `/envs/${built.envId}`
    expect(sh(builder, `cat ${env}/site/owtest_b/__init__.py`)).toBe('VERSION = "2.0.0"\n')
    expect(JSON.parse(sh(builder, `cat ${env}/lock.json`))).toEqual(built.lock)
    expect(Number(sh(builder, `cat ${env}/size`))).toBe(built.sizeBytes)
    // Readable by the jail's user, writable by nobody but the builder.
    expect(sh(builder, `stat -c %a ${env} ${env}/site/owtest_a/__init__.py`).split('\n')).toEqual([
      '755',
      '644',
      '',
    ])

    const again = await call('/build', { requirements: ['owtest-a'] })
    expect(again).toMatchObject({ ok: true, cached: true, envId: built.envId, lock: built.lock })
    const older = await call('/build', { requirements: ['owtest-a', 'owtest-b<2'] })
    expect(older.lock!.packages.map((p) => `${p.name}==${p.version}`)).toEqual([
      'owtest-a==1.0.0',
      'owtest-b==1.0.0',
    ])
    expect(older.envId).not.toBe(built.envId)
  })

  it('says why pip found nothing to install: no such package, no wheel', async () => {
    const missing = await call('/build', { requirements: ['owtest-nope'] })
    expect(missing).toMatchObject({ ok: false, error: { kind: 'resolve' } })
    expect(missing.error!.message).toMatch(/owtest-nope/)
    const sdist = await call('/build', { requirements: ['owtest-c'] })
    expect(sdist).toMatchObject({ ok: false, error: { kind: 'resolve' } })
    expect(sdist.log).toMatch(/owtest-c/)
    expect(sh(builder, 'ls -A /envs | grep -c "^.tmp-" || true').trim()).toBe('0')
  })

  it('installs a known lock again without resolving, and refuses locks it can not trust', async () => {
    const built = await call('/build', { requirements: ['owtest-a'] })
    sh(builder, `rm -rf /envs/${built.envId}`)
    const installed = await call('/install', { lock: built.lock })
    expect(installed).toMatchObject({ ok: true, cached: false, envId: built.envId })
    expect(sh(builder, `ls /envs/${built.envId}/site`)).toContain('owtest_a')
    expect(await call('/install', { lock: built.lock })).toMatchObject({ ok: true, cached: true })
    // An env from before its size was kept is measured once, then keeps it.
    sh(builder, `rm /envs/${built.envId}/size`)
    const measured = await call('/install', { lock: built.lock })
    expect(Number(sh(builder, `cat /envs/${built.envId}/size`))).toBe(measured.sizeBytes)

    const lock = built.lock!
    expect(await call('/install', { lock: { ...lock, platform: 'cp312-win_amd64' } })).toMatchObject({
      ok: false,
      error: { kind: 'platform' },
    })
    const tampered = {
      ...lock,
      packages: lock.packages.map((p) => (p.name === 'owtest-b' ? { ...p, sha256: '0'.repeat(64) } : p)),
    }
    const refused = await call('/install', { lock: tampered })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'install' } })
    expect(refused.log).toMatch(/hash/i)
    expect(
      await call('/install', { lock: { platform: lock.platform, packages: [{ name: 'x' }] } }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid' },
    })
  })

  it("answers an env that's there without a build slot, and times a build from its slot", async () => {
    const one = await startTestBuilder({
      indexUrl: index.url,
      env: { PYTHON_MAX_BUILDS: '1', PYTHON_BUILD_TIMEOUT_SECONDS: '10' },
    })
    try {
      const built = await call('/build', { requirements: ['owtest-b==1.0.0'] }, one)
      expect(built.ok).toBe(true)
      // The only slot is held for 7 s by a build whose index page answers late; another (itself 3 s) waits for it.
      const slow = call('/build', { requirements: ['owtest-slow'] }, one)
      await new Promise((r) => setTimeout(r, 500))
      const queued = call('/build', { requirements: ['owtest-slow2'] }, one)
      const started = Date.now()
      expect(await call('/install', { lock: built.lock }, one)).toMatchObject({ ok: true, cached: true })
      expect(Date.now() - started).toBeLessThan(1500)
      expect((await slow).error).toBeUndefined()
      // It waited ~7 s for the slot and needs ~3.5: counted from the request it would have ~3 left and time out.
      expect((await queued).error).toBeUndefined()
    } finally {
      await one.stop()
    }
  })

  it('refuses an env over its size, and removes envs unused for PYTHON_ENV_KEEP_DAYS', async () => {
    const small = await startTestBuilder({
      indexUrl: index.url,
      env: { PYTHON_ENV_MAX_MB: '0.00001', PYTHON_ENV_KEEP_DAYS: '1' },
    })
    try {
      expect(await call('/build', { requirements: ['owtest-a'] }, small)).toMatchObject({
        ok: false,
        error: { kind: 'too_big' },
      })
      expect(sh(small, 'ls -A /envs').trim()).toBe('')
      const empty = await call(
        '/install',
        { lock: { platform: (await healthOf(small)).platform, packages: [] } },
        small,
      )
      expect(empty).toMatchObject({ ok: true })
      // Two days unused, then the hourly cleaning (run here at once) removes it; a fresh one stays.
      sh(
        small,
        `touch -d '2 days ago' /envs/${empty.envId}/used && mkdir /envs/fresh && touch /envs/fresh/used`,
      )
      sh(
        small,
        `python3 -I -c 'import sys; sys.path.insert(0, "/opt/builder"); import builder; builder.clean()'`,
      )
      expect(sh(small, 'ls -A /envs').trim()).toBe('fresh')
    } finally {
      await small.stop()
    }
  })
})

async function healthOf(of: TestBuilder): Promise<{ ok: boolean; platform: string }> {
  return (await (await fetch(`${of.url}/health`)).json()) as { ok: boolean; platform: string }
}
