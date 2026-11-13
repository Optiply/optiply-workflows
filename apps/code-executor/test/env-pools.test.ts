/**
 * The warm pool per env (M32, docs/architecture.md §2.35): after an env's first run, the executor keeps a warm jail
 * for it (its env mounted, its roots imported), for a few envs at a time.
 */
import { execFileSync } from 'node:child_process'
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
interface EnvPoolStats {
  size: number
  envs: Record<string, { ready: boolean; starting: boolean; tooBig: boolean; warm: number; cold: number }>
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

async function run(code: string, envId: string, on: TestExecutor = executor): Promise<Outcome> {
  const res = await fetch(`${on.url}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${on.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code, scope: {}, timeoutMs: 10_000, envId }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Outcome
}

async function envPools(on: TestExecutor = executor): Promise<EnvPoolStats> {
  return ((await (await fetch(`${on.url}/health`)).json()) as { envPools: EnvPoolStats }).envPools
}

/** Waits until the env has a warm jail ready. */
async function ready(envId: string, on: TestExecutor = executor) {
  const deadline = Date.now() + 60_000
  while (!(await envPools(on)).envs[envId]?.ready) {
    if (Date.now() > deadline)
      throw new Error(`No warm jail for ${envId}: ${JSON.stringify(await envPools(on))}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe.skipIf(!available)('the warm pool per env', () => {
  beforeAll(async () => {
    index = await startTestIndex([
      {
        name: 'owtest-a',
        version: '1.0.0',
        requires: ['owtest-b'],
        files: { 'owtest_a/__init__.py': 'from owtest_b import VERSION as B\nNAME = "a"\n' },
      },
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
      { name: 'owtest-c', version: '1.0.0', files: { 'owtest_c.py': 'C = 3\n' } },
      { name: 'owtest-d', version: '1.0.0', files: { 'owtest_d/__init__.py': 'D = 4\n' } },
      // Its import ends Python: a warm jail must still come up (the code's own import then fails).
      {
        name: 'owtest-broken',
        version: '1.0.0',
        files: { 'owtest_broken/__init__.py': 'raise SystemExit(5)\n' },
      },
    ])
    volume = testEnvsVolume()
    builder = await startTestBuilder({ indexUrl: index.url, envsVolume: volume.name })
    executor = await startTestExecutor({
      envsVolume: volume.name,
      env: { PYTHON_WARM_JAILS: '0', PYTHON_WARM_ENV_JAILS: '2' },
    })
  })
  afterAll(async () => {
    await executor?.stop()
    await builder?.stop()
    await index?.stop()
    volume?.remove()
  })

  it("serves an env's second run warm, its roots imported, nothing carried over", async () => {
    const envId = await build(['owtest-a'])
    const first = await run('import sys\nreturn "owtest_a" in sys.modules', envId)
    expect(first).toMatchObject({ ok: true, result: false, warm: false })
    await ready(envId)
    // The root (owtest-a) is imported ahead, and with it what it imports; this run leaves its marks.
    const warm = await run(
      [
        'import sys',
        'before = ["owtest_a" in sys.modules, "owtest_b" in sys.modules]',
        'import owtest_a',
        'owtest_a.MARK = 1',
        'open("/tmp/mark", "w").write("x")',
        'return before + [owtest_a.B]',
      ].join('\n'),
      envId,
    )
    expect(warm).toMatchObject({ ok: true, result: [true, true, '1.0.0'], warm: true })
    await ready(envId)
    const next = await run(
      'import os, owtest_a\nreturn [hasattr(owtest_a, "MARK"), os.path.exists("/tmp/mark")]',
      envId,
    )
    expect(next).toMatchObject({ ok: true, result: [false, false], warm: true })
    expect((await envPools()).envs[envId]).toMatchObject({ warm: 2, cold: 1 })
  })

  it('keeps warm jails for the most recently run envs only', async () => {
    const [a, c, d] = [await build(['owtest-a']), await build(['owtest-c']), await build(['owtest-d'])]
    await run('return 1', a)
    await run('return 1', c)
    await run('return 1', d)
    const envs = Object.keys((await envPools()).envs)
    expect(envs).toEqual([c, d]) // a was run longest ago: dropped
    await ready(c)
    await ready(d)
    expect(await run('import owtest_c\nreturn owtest_c.C', c)).toMatchObject({
      ok: true,
      result: 3,
      warm: true,
    })
    expect(await run('import owtest_d\nreturn owtest_d.D', d)).toMatchObject({
      ok: true,
      result: 4,
      warm: true,
    })
    // a again: cold (and c, now the least recent, gives way).
    expect(await run('import owtest_a\nreturn owtest_a.NAME', a)).toMatchObject({ ok: true, warm: false })
    expect(Object.keys((await envPools()).envs)).toEqual([d, a])
  })

  it("still serves warm when an env's root fails to import", async () => {
    const envId = await build(['owtest-broken', 'owtest-c'])
    await run('return 1', envId)
    await ready(envId)
    expect(await run('import owtest_c\nreturn owtest_c.C', envId)).toMatchObject({
      ok: true,
      result: 3,
      warm: true,
    })
    await ready(envId)
    const broken = await run('import owtest_broken\nreturn 1', envId)
    expect(broken).toMatchObject({ ok: false, warm: true })
  })

  it('drops the jail of an env not run for a while, keeps none too big, and none with PYTHON_WARM_ENV_JAILS=0', async () => {
    const envId = await build(['owtest-c'])
    const quick = await startTestExecutor({
      envsVolume: volume.name,
      env: { PYTHON_WARM_JAILS: '0', PYTHON_WARM_ENV_IDLE_SECONDS: '3' },
    })
    const none = await startTestExecutor({
      envsVolume: volume.name,
      env: { PYTHON_WARM_JAILS: '0', PYTHON_WARM_ENV_JAILS: '0' },
    })
    // An env's warm jail holding more than PYTHON_WARM_ENV_MAX_MB once ready isn't kept: its env runs cold.
    const small = await startTestExecutor({
      envsVolume: volume.name,
      env: { PYTHON_WARM_JAILS: '0', PYTHON_WARM_ENV_MAX_MB: '1' },
    })
    try {
      await run('return 1', envId, quick)
      await ready(envId, quick)
      const deadline = Date.now() + 15_000
      while ((await envPools(quick)).envs[envId]) {
        if (Date.now() > deadline) throw new Error('The idle env kept its jail')
        await new Promise((r) => setTimeout(r, 250))
      }
      // Its jail is gone from the container too.
      const jails = execFileSync('docker', ['top', quick.container!])
        .toString()
        .split('\n')
        .filter((line) => line.includes('nsjail'))
      expect(jails).toEqual([])
      await run('return 1', envId, none)
      await run('return 1', envId, none)
      expect(await run('return 1', envId, none)).toMatchObject({ ok: true, warm: false })
      expect((await envPools(none)).envs).toEqual({})
      await run('return 1', envId, small)
      await expect
        .poll(async () => (await envPools(small)).envs[envId]?.tooBig, { timeout: 30_000 })
        .toBe(true)
      expect(await run('return 1', envId, small)).toMatchObject({ ok: true, warm: false })
    } finally {
      await quick.stop()
      await none.stop()
      await small.stop()
    }
  })
})
