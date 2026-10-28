/**
 * A workflow's packages in the jail (M23, docs/architecture.md §2.26): the builder installs an env on a volume, the
 * executor mounts it read-only for runs that name it, ahead of the image's packages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executorAvailable,
  startTestBuilder,
  startTestExecutor,
  startTestIndex,
  type TestBuilder,
  type TestExecutor,
  type TestIndex,
  testEnvsVolume,
} from '../src/testing'

const available = executorAvailable() && !process.env.PYTHON_EXECUTOR_TEST_URL
let index: TestIndex
let builder: TestBuilder
let executor: TestExecutor
let volume: ReturnType<typeof testEnvsVolume>

interface Outcome {
  ok: boolean
  result?: unknown
  error?: { kind: string; message: string }
  warm?: boolean
}

async function build(requirements: string[]): Promise<string> {
  const res = await fetch(`${builder.url}/build`, {
    method: 'POST',
    headers: { authorization: `Bearer ${builder.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requirements }),
  })
  const answer = (await res.json()) as { ok: boolean; envId?: string; log?: string }
  if (!answer.ok) throw new Error(`The build failed:\n${answer.log}`)
  return answer.envId!
}

async function post(body: Record<string, unknown>) {
  return fetch(`${executor.url}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${executor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: {}, timeoutMs: 10_000, ...body }),
  })
}
async function run(code: string, envId?: string): Promise<Outcome> {
  const res = await post({ code, ...(envId && { envId }) })
  expect(res.status).toBe(200)
  return (await res.json()) as Outcome
}

describe.skipIf(!available)("a workflow's packages", () => {
  beforeAll(async () => {
    index = await startTestIndex([
      {
        name: 'owtest-a',
        version: '1.0.0',
        requires: ['owtest-b'],
        files: { 'owtest_a/__init__.py': 'from owtest_b import VERSION as B\nNAME = "a"\n' },
      },
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
      // Named like one of the image's packages: the env's must win.
      { name: 'pytz', version: '9999.0.0', files: { 'pytz/__init__.py': 'VERSION = "from the env"\n' } },
      {
        name: 'owtest-pth',
        version: '1.0.0',
        files: {
          'owtest_pth.pth': 'owtest_pth_lib\n',
          'owtest_pth_lib/hidden.py': 'X = "through a .pth file"\n',
        },
      },
    ])
    volume = testEnvsVolume()
    builder = await startTestBuilder({ indexUrl: index.url, envsVolume: volume.name }) // first: it owns /envs
    executor = await startTestExecutor({ envsVolume: volume.name, env: { PYTHON_WARM_JAILS: '1' } })
  })
  afterAll(async () => {
    await executor?.stop()
    await builder?.stop()
    await index?.stop()
    volume?.remove()
  })

  it("imports the env's packages, in a cold jail; without the env they aren't there", async () => {
    const envId = await build(['owtest-a'])
    expect(await run('import owtest_a\nreturn [owtest_a.NAME, owtest_a.B]', envId)).toMatchObject({
      ok: true,
      result: ['a', '1.0.0'],
      warm: false,
    })
    const without = await run('import owtest_a\nreturn 1')
    expect(without).toMatchObject({ ok: false, error: { kind: 'runtime' } })
    expect(without.error!.message).toContain("ModuleNotFoundError: No module named 'owtest_a'")
  })

  it("puts the env ahead of the image's packages, keeps the image's for the rest, reads .pth files", async () => {
    const envId = await build(['pytz', 'owtest-pth'])
    expect(
      // numpy, not pandas: pandas reads pytz's version, and this pytz has none (the env's wins, as it should).
      await run('import pytz, numpy, hidden\nreturn [pytz.VERSION, numpy.__name__, hidden.X]', envId),
    ).toMatchObject({ ok: true, result: ['from the env', 'numpy', 'through a .pth file'] })
    // Another run without it has the image's own pytz.
    expect(await run('import pytz\nreturn pytz.VERSION')).toMatchObject({
      ok: true,
      result: expect.stringMatching(/^20\d\d\.\d+$/),
    })
  })

  it('mounts the env read-only', async () => {
    const envId = await build(['owtest-a'])
    const outcome = await run(
      'try:\n    open("/opt/env/owtest_a/x.py", "w")\nexcept OSError as e:\n    return e.errno',
      envId,
    )
    expect(outcome).toMatchObject({ ok: true, result: 30 }) // EROFS
  })

  it("says so when the env isn't installed, and refuses an id that isn't one", async () => {
    expect(await run('return 1', 'f'.repeat(32))).toMatchObject({
      ok: false,
      error: { kind: 'python_packages', message: expect.stringContaining("aren't installed here") },
    })
    expect((await post({ code: 'return 1', envId: '../etc' })).status).toBe(400)
  })
})
