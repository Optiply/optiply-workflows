import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureSdkEnvs,
  configureSdkRunner,
  PoolManager,
  runQuery,
  type SdkOutcome,
  type SdkRunRequest,
  sdkAllowedHosts,
  sdkConnector,
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
