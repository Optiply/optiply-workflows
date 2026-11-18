import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectorError,
  configureSdkEnvs,
  configureSdkRunner,
  PoolManager,
  runQuery,
  SDK_TEST_INSTALL_MS,
  type SdkOutcome,
  type SdkRunRequest,
  sdkAllowedHosts,
  sdkConnector,
  testResource,
} from '../src'
import { resource, scopeEvaluator } from './helpers'

// The SDK connector (M37) against a fake runner: what it sends, the token per sign-in, a 401 retried with a fresh
// token, failures as errors, tokens scrubbed. The real runner and builder: apps/server/test/sdk-resources.test.ts.

const pool = new PoolManager()
let sent: SdkRunRequest[] = []
let answers: SdkOutcome[] = []
let logs: string[] = []

beforeEach(() => {
  sent = []
  answers = []
  logs = []
  configureSdkRunner({
    run: async (request, opts) => {
      sent.push(request)
      opts.onLog?.('log', `printed ${request.context.token}`)
      return answers.shift() ?? { ok: true, result: { echoed: request.context.token }, connections: 1 }
    },
  })
  configureSdkEnvs(async (spec) => ({ envId: 'e'.repeat(32), versions: { [spec.packages[0]!]: '1.0.0' } }))
})
afterAll(async () => {
  configureSdkRunner(null)
  configureSdkEnvs(null)
  await pool.closeAll()
})

const sdk = (
  config: Record<string, unknown>,
  secrets: Record<string, unknown> = { bearerToken: 'tok-pasted-1' },
) => {
  const r = resource(
    { setup: 'def client(token):\n    return token\n', ...config },
    secrets,
    JSON.stringify([config, secrets]),
  )
  return {
    ...r,
    config: sdkConnector.configSchema.parse(r.config),
    secrets: sdkConnector.secretsSchema.parse(r.secrets),
  }
}

const run = (r: ReturnType<typeof sdk>, query: Record<string, string>, tokens: string[] = []) =>
  runQuery(pool, sdkConnector, r, query, {
    evaluate: scopeEvaluator({ n: 2 }),
    log: (level, message) => logs.push(`${level} ${message}`),
    credentials: {
      accessToken: async ({ force }) => {
        const t = force ? 'oauth-fresh-2' : 'oauth-stale-1'
        tokens.push(t)
        return t
      },
    },
  })

describe('the SDK connector', () => {
  it('installs the packages, sends the call with the token, the base URL’s host, and scrubs the token', async () => {
    const r = sdk({
      language: 'python',
      packages: ['acme==1.0'],
      baseUrl: 'https://api.acme.com/v2',
      options: { tenant: 'x' },
    })
    const result = await run(r, {
      action: 'call',
      method: 'items.list',
      args: '{"page": {{ n }}}',
      limit: '5',
    })
    expect(sent[0]).toMatchObject({
      language: 'python',
      envId: 'e'.repeat(32),
      mode: 'call',
      method: 'items.list',
      args: { page: 2 },
      limit: 5,
      context: {
        token: 'tok-pasted-1',
        baseUrl: 'https://api.acme.com/v2',
        options: { tenant: 'x' },
        secrets: {},
      },
      allowedHosts: ['api.acme.com'],
      allowPrivate: false,
    })
    expect(result.data).toEqual({ echoed: '[REDACTED]' })
    expect(result.metadata).toMatchObject({
      language: 'python',
      packages: { 'acme==1.0': '1.0.0' },
      connections: 1,
    })
    expect(logs).toEqual(['log printed [REDACTED]'])
  })

  it('OAuth sign-in: a 401 from the SDK fetches a fresh token and calls once more', async () => {
    answers = [{ ok: false, error: { kind: 'sdk', message: 'ApiError: 401', status: 401 } }]
    const tokens: string[] = []
    const r = sdk(
      {
        auth: {
          type: 'oauth2AuthorizationCode',
          authorizeUrl: 'https://a.example/auth',
          tokenUrl: 'https://a.example/token',
          clientId: 'c',
        },
      },
      { clientSecret: 's' },
    )
    const result = await run(r, { action: 'describe' }, tokens)
    expect(tokens).toEqual(['oauth-stale-1', 'oauth-fresh-2'])
    expect(sent.map((s) => s.context.token)).toEqual(['oauth-stale-1', 'oauth-fresh-2'])
    expect(result.data).toEqual({ echoed: '[REDACTED]' })
    expect(logs).toContain('info The SDK was refused (401): calling again with a fresh token')
  })

  it('says what failed: the setup, the SDK with its status, a missing method, blocked hosts, no setup', async () => {
    const fail = async (outcome: SdkOutcome, r = sdk({})) => {
      answers = [outcome]
      try {
        await run(r, { action: 'describe' })
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError)
        return err as ConnectorError
      }
      throw new Error('Expected a failure')
    }
    expect(
      (await fail({ ok: false, error: { kind: 'setup', message: 'NameError: x', line: 2 } })).message,
    ).toBe('The setup code failed: NameError: x (line 2 of the setup code)')
    const sdkError = await fail({
      ok: false,
      error: { kind: 'sdk', message: 'ApiError: nope', status: 403, type: 'ApiError' },
      blocked: [{ host: 'evil.com:443', reason: 'not allowed' }],
    })
    expect(sdkError.code).toBe('sdk')
    expect(sdkError.message).toBe('ApiError: nope. Blocked: evil.com:443')
    expect(sdkError.details).toMatchObject({
      status: 403,
      type: 'ApiError',
      blocked: [{ host: 'evil.com:443' }],
    })
    expect((await fail({ ok: false, error: { kind: 'sdk_method', message: 'no such' } })).code).toBe(
      'sdk_method',
    )
    const noSetup = sdk({ setup: '' })
    await expect(run(noSetup, { action: 'describe' })).rejects.toThrow(/Write the setup code/)
  })

  it('gives the runner what is left of the query’s time after a slow install (review fix)', async () => {
    configureSdkEnvs(async () => {
      await new Promise((r) => setTimeout(r, 1500))
      return { envId: 'f'.repeat(32), versions: {} }
    })
    await runQuery(
      pool,
      sdkConnector,
      sdk({ packages: ['acme==1'] }),
      { action: 'describe' },
      {
        evaluate: scopeEvaluator({}),
        timeoutMs: 10_000,
      },
    )
    expect(sent[0]!.timeoutMs).toBeLessThanOrEqual(8_600)
    expect(sent[0]!.timeoutMs).toBeGreaterThan(7_000)
  })

  describe('Test connection with packages to install first (2026-11-17: a first install took longer than 15 s)', () => {
    const slowInstall = (ms: number, versions = { acme: '1.0.0' }) => {
      let installs = 0
      configureSdkEnvs(async () => {
        installs++
        await new Promise((r) => setTimeout(r, ms))
        return { envId: 'f'.repeat(32), versions }
      })
      return () => installs
    }

    it('installs before its own time limit starts, once, and gives the runner the whole limit', async () => {
      // Longer than the test's own limit (the runner gets at least 1 s, so the limit is 1 s too).
      const installs = slowInstall(1200)
      let abortedWhenCalled: boolean | undefined
      configureSdkRunner({
        run: async (request, opts) => {
          sent.push(request)
          abortedWhenCalled = opts.signal?.aborted
          return { ok: true, result: { type: 'Acme', members: [] }, connections: 1 }
        },
      })
      const result = await testResource(sdkConnector, sdk({ packages: ['acme==1'] }), { timeoutMs: 1000 })
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining('installed acme 1.0.0') })
      expect(installs()).toBe(1)
      expect(abortedWhenCalled).toBe(false)
      expect(sent[0]!.envId).toBe('f'.repeat(32))
      expect(sent[0]!.timeoutMs).toBeGreaterThan(900)
      expect(sent[0]!.timeoutMs).toBeLessThanOrEqual(1000)
      // The duration is the test's own, not the install's.
      expect(result.ok && result.durationMs).toBeLessThan(1000)
    })

    it('says when it was the install that failed', async () => {
      configureSdkEnvs(async () => {
        throw new ConnectorError('sdk_install', 'No matching distribution found for acme==9', {
          log: 'pip …',
        })
      })
      const result = await testResource(sdkConnector, sdk({ packages: ['acme==9'] }))
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'sdk_install',
          message: "Installing the SDK's packages failed: No matching distribution found for acme==9",
          details: { log: 'pip …' },
        },
      })
      expect(sent).toEqual([])

      // The builder's own timeout is still the install's (not taken for the test's wait).
      configureSdkEnvs(async () => {
        throw new ConnectorError('timeout', 'The package builder timed out')
      })
      expect(await testResource(sdkConnector, sdk({ packages: ['acme==9'] }))).toMatchObject({
        ok: false,
        error: {
          code: 'timeout',
          message: "Installing the SDK's packages failed: The package builder timed out",
        },
      })
    })

    it('says the setup code is missing before installing anything', async () => {
      const installs = slowInstall(10)
      expect(await testResource(sdkConnector, sdk({ packages: ['acme==1'], setup: ' ' }))).toMatchObject({
        ok: false,
        error: { code: 'invalid_config', message: expect.stringContaining('Write the setup code') },
      })
      expect(installs()).toBe(0)
    })

    it('stops waiting for an install after a few minutes, which goes on in the background', async () => {
      vi.useFakeTimers()
      try {
        slowInstall(SDK_TEST_INSTALL_MS + 60_000)
        const pending = testResource(sdkConnector, sdk({ packages: ['acme==1'] }))
        await vi.advanceTimersByTimeAsync(SDK_TEST_INSTALL_MS + 1)
        expect(await pending).toMatchObject({
          ok: false,
          error: {
            code: 'timeout',
            message: expect.stringMatching(/takes more than 3 minutes\. It goes on/),
          },
        })
        expect(sent).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('says a timeout after the install was the connection, not the install', async () => {
      slowInstall(300)
      configureSdkRunner({
        run: (_request, opts) =>
          new Promise((_, reject) =>
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      })
      const result = await testResource(sdkConnector, sdk({ packages: ['acme==1'] }), { timeoutMs: 200 })
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'timeout',
          message: expect.stringMatching(
            /^The test timed out after 200 ms, not counting installing the SDK's packages \(\d+ s\)$/,
          ),
        },
      })
    })

    it('needs no install without packages', async () => {
      const installs = slowInstall(10)
      expect(await testResource(sdkConnector, sdk({}), { timeoutMs: 400 })).toMatchObject({ ok: true })
      expect(installs()).toBe(0)
    })
  })

  it('takes a snippet as code (not a template), and the hosts from the list or the base URL', async () => {
    expect(
      sdkConnector.validateQuery({ action: 'code', code: 'return {{"a": 1}}', params: '{}' } as never),
    ).toEqual([])
    const r = sdk({ language: 'javascript' })
    await run(r, { action: 'code', code: 'return {{ not a template }}', params: '{"n": {{ n }}}' })
    expect(sent[0]).toMatchObject({ mode: 'code', code: 'return {{ not a template }}', params: { n: 2 } })
    expect(sdkAllowedHosts({ allowedHosts: [], baseUrl: 'http://localhost:8080/x' })).toEqual([
      'localhost:8080',
    ])
    expect(sdkAllowedHosts({ allowedHosts: ['*.acme.com'], baseUrl: 'https://api.acme.com' })).toEqual([
      '*.acme.com',
    ])
    expect(sdkAllowedHosts({ allowedHosts: [], baseUrl: undefined })).toEqual([])
    expect(() => sdkConnector.configSchema.parse({ auth: { type: 'apiKey', name: 'x' } })).toThrow(
      /An SDK signs in/,
    )
  })
})
