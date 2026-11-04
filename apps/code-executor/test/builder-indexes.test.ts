/**
 * The package builder with named package indexes (M32, docs/architecture.md §2.35): a private index with a sign-in,
 * primary or extra, the lock naming each package's index, installs needing those indexes again, and the
 * credentials kept out of every answer, log and lock.
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
  packages: { name: string; version: string; sha256: string; index?: string }[]
}
interface Answer {
  ok: boolean
  envId?: string
  lock?: Lock
  error?: { kind: string; message: string }
  log: string
}

const available = executorAvailable()
const PASSWORD = 'S3cret pass/word+#%'
let publicIndex: TestIndex
let privateIndex: TestIndex
let builder: TestBuilder

const priv = (mode: 'primary' | 'extra', auth: { username?: string; password?: string } = {}) => ({
  name: 'private',
  url: privateIndex.url,
  mode,
  username: 'ci',
  password: PASSWORD,
  ...auth,
})

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
const expectNoPassword = (text: string) => {
  expect(text).not.toContain(PASSWORD)
  expect(text).not.toContain(encodeURIComponent(PASSWORD))
}

describe.skipIf(!available)("the package builder's indexes", () => {
  beforeAll(async () => {
    publicIndex = await startTestIndex([
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
    ])
    privateIndex = await startTestIndex(
      [
        {
          name: 'owtest-private',
          version: '1.0.0',
          requires: ['owtest-b'],
          files: { 'owtest_private/__init__.py': 'SECRET_SAUCE = 42\n' },
        },
        { name: 'owtest-solo', version: '1.0.0', files: { 'owtest_solo.py': 'X = 1\n' } },
      ],
      { auth: { username: 'ci', password: PASSWORD } },
    )
    builder = await startTestBuilder({ indexUrl: publicIndex.url })
  })
  afterAll(async () => {
    await builder?.stop()
    await privateIndex?.stop()
    await publicIndex?.stop()
  })

  it('resolves from an extra index with its sign-in; the lock names it, and holds no credentials', async () => {
    const built = await call('/build', { requirements: ['owtest-private'], indexes: [priv('extra')] })
    expect(built).toMatchObject({ ok: true })
    expect(built.lock!.packages.map((p) => [p.name, p.index ?? null])).toEqual([
      ['owtest-b', null],
      ['owtest-private', 'private'],
    ])
    expectNoPassword(JSON.stringify(built))
    expectNoPassword(sh(`cat /envs/${built.envId}/lock.json`))
    expect(sh(`ls /envs/${built.envId}/site`)).toContain('owtest_private')
  })

  it('replaces the default index with a primary one', async () => {
    const solo = await call('/build', { requirements: ['owtest-solo'], indexes: [priv('primary')] })
    expect(solo.lock!.packages).toEqual([expect.objectContaining({ name: 'owtest-solo', index: 'private' })])
    // owtest-b is only on the default index, which a primary index replaces.
    const missing = await call('/build', { requirements: ['owtest-private'], indexes: [priv('primary')] })
    expect(missing).toMatchObject({ ok: false, error: { kind: 'resolve' } })
    expect(missing.error!.message).toContain('owtest-b')
  })

  it('says when the index refuses the sign-in, without the password', async () => {
    const none = await call('/build', {
      requirements: ['owtest-private'],
      indexes: [priv('extra', { username: undefined, password: undefined })],
    })
    expect(none).toMatchObject({ ok: false, error: { kind: 'resolve' } })
    const wrong = await call('/build', {
      requirements: ['owtest-private'],
      indexes: [priv('extra', { password: `${PASSWORD}x` })],
    })
    expect(wrong).toMatchObject({
      ok: false,
      error: {
        kind: 'resolve',
        message: expect.stringContaining('Package index private: the index refused the sign-in'),
      },
    })
    expectNoPassword(JSON.stringify(wrong))
  })

  it('installs a lock again from its indexes, and refuses it without them', async () => {
    const built = await call('/build', { requirements: ['owtest-private'], indexes: [priv('extra')] })
    sh(`rm -rf /envs/${built.envId}`)
    expect(await call('/install', { lock: built.lock })).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: expect.stringContaining('package index private') },
    })
    // The mode doesn't matter here: every package is pinned by its hash.
    expect(await call('/install', { lock: built.lock, indexes: [priv('primary')] })).toMatchObject({
      ok: true,
      cached: false,
      envId: built.envId,
    })
    expect(sh(`ls /envs/${built.envId}/site`)).toContain('owtest_private')
  })

  it('tests an index: signed in, wanting a sign-in, refusing it, out of reach', async () => {
    expect(await call('/check-index', { index: priv('extra') })).toMatchObject({ ok: true, status: 200 })
    expect(
      await call('/check-index', { index: priv('extra', { username: undefined, password: undefined }) }),
    ).toMatchObject({ ok: false, status: 401, message: expect.stringContaining('wants a sign-in') })
    const wrong = await call('/check-index', { index: priv('extra', { password: 'nope' }) })
    expect(wrong).toMatchObject({ ok: false, status: 403, message: expect.stringContaining('refused') })
    const away = await call('/check-index', {
      index: { name: 'away', url: 'http://127.0.0.1:9/simple', mode: 'extra' },
    })
    expect(away).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't reach") })
  })

  it('refuses indexes that are not what it expects', async () => {
    const bad = [
      [{ ...priv('extra'), url: `http://ci:pw@${new URL(privateIndex.url).host}/simple` }],
      [{ ...priv('extra'), url: 'ftp://example.com/simple' }],
      [{ ...priv('extra'), mode: 'first' }],
      [{ ...priv('extra'), name: 'Not A Slug' }],
      [{ ...priv('extra'), username: undefined }],
      [priv('primary'), { ...priv('primary'), name: 'other' }],
      [priv('extra'), priv('extra')],
    ]
    for (const indexes of bad)
      expect(await call('/build', { requirements: ['owtest-solo'], indexes })).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
      })
  })

  it("keeps the password out of the builder's own log", () => {
    expectNoPassword(execFileSync('docker', ['logs', builder.container], { stdio: 'pipe' }).toString())
  })
})
