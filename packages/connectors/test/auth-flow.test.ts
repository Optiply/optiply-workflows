import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthFlowStep,
  ConnectorError,
  type CredentialSource,
  type FlowSandbox,
  PoolManager,
  type RestConfig,
  type RestSecrets,
  restConnector,
  runAuthFlow,
  runQuery,
  testResource,
} from '../src'
import { resource, scopeEvaluator } from './helpers'

/** Stand-in for the sandbox: plain `new Function` over the scope (the server tests use the real one). */
const sandbox: FlowSandbox = {
  async evalExpression(expression, scope) {
    return new Function(...Object.keys(scope), `return (${expression})`)(...Object.values(scope))
  },
  async runCode(code, scope) {
    return new Function(...Object.keys(scope), `return (async () => { ${code} })()`)(...Object.values(scope))
  },
}

let server: Server
let origin: string
let pool: PoolManager
const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = []
let validSession = 'session-1'

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url ?? '/', 'http://x')
    requests.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body })
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/api/login') {
      const { user, password } = JSON.parse(body || '{}')
      if (user !== 'ada' || password !== 'pw-Secret-123') return json(401, { error: 'bad login' })
      return json(200, { session: validSession, expiresIn: 600 }, { 'x-csrf': 'csrf-1' })
    }
    if (url.pathname === '/api/login-form') return json(200, { session: 'form-session' })
    if (url.pathname === '/api/data') {
      if (req.headers['x-session'] !== validSession) return json(401, { error: 'expired' })
      return json(200, { ok: true, session: req.headers['x-session'], key: url.searchParams.get('key') })
    }
    json(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
  await new Promise((r) => server?.close(r))
})
beforeEach(() => {
  requests.length = 0
  validSession = 'session-1'
})

const loginSteps: AuthFlowStep[] = [
  {
    type: 'request',
    name: 'login',
    method: 'POST',
    path: 'login',
    params: [],
    headers: [],
    body: { type: 'json', json: '{"user": {{ secrets.user }}, "password": {{ secrets.password }}}' },
  },
  {
    type: 'code',
    name: 'expiry',
    code: 'return Date.parse("2026-10-16T00:00:00Z") + login.data.expiresIn * 1000',
  },
  { type: 'variable', name: 'session', value: '{{ login.data.session }}', secret: true },
  { type: 'variable', name: 'csrf', value: '{{ login.headers["x-csrf"] }}', secret: true },
  { type: 'variable', name: 'until', value: '{{ expiry }}', secret: true },
]

const config = (overrides: Partial<RestConfig> = {}): RestConfig =>
  restConnector.configSchema.parse({
    baseUrl: `${origin}/api`,
    allowPrivateNetwork: true,
    headers: [
      { key: 'x-session', value: '{{ auth.session }}' },
      { key: 'x-static', value: 'plain' },
    ],
    params: [{ key: 'key', value: 'k-{{ auth.csrf }}' }],
    auth: { type: 'custom', steps: loginSteps },
    ...overrides,
  })
const secrets = (values: Record<string, string> = { user: 'ada', password: 'pw-Secret-123' }): RestSecrets =>
  restConnector.secretsSchema.parse({ values })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected it to fail')
}

describe('runAuthFlow', () => {
  it('runs requests, code and variables in order, with secrets and earlier steps in scope', async () => {
    const variables = await runAuthFlow({ config: config(), secrets: secrets() }, loginSteps, {
      sandbox,
      signal: AbortSignal.timeout(5000),
    })
    expect(variables).toEqual({
      session: 'session-1',
      csrf: 'csrf-1',
      until: Date.parse('2026-10-16T00:00:00Z') + 600_000,
    })
    // The sign-in request goes to the base URL without the resource's default headers and parameters.
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/login' })
    expect(requests[0]!.headers['x-static']).toBeUndefined()
    expect(requests[0]!.headers['x-session']).toBeUndefined()
    expect(JSON.parse(requests[0]!.body)).toEqual({ user: 'ada', password: 'pw-Secret-123' })
  })

  it('names the step that failed', async () => {
    const err = await failure(
      runAuthFlow({ config: config(), secrets: secrets({ user: 'ada', password: 'wrong' }) }, loginSteps, {
        sandbox,
        signal: AbortSignal.timeout(5000),
      }),
    )
    expect(err).toMatchObject({
      code: 'auth_required',
      message: 'Signing in failed at step "login": HTTP 401 Unauthorized',
      details: { reason: 'flow_failed', step: 'login', status: 401 },
    })

    const thrown = await failure(
      runAuthFlow(
        { config: config(), secrets: secrets() },
        [{ type: 'code', name: 'boom', code: 'throw new Error("no token in the answer")' }],
        { sandbox, signal: AbortSignal.timeout(5000) },
      ),
    )
    expect(thrown.message).toBe('Signing in failed at step "boom": no token in the answer')
  })

  it('starts a refresh flow from the previous variables', async () => {
    const variables = await runAuthFlow(
      { config: config(), secrets: secrets() },
      [{ type: 'variable', name: 'session', value: '{{ auth.session + "-renewed" }}', secret: true }],
      { sandbox, signal: AbortSignal.timeout(5000), previous: { session: 'old', csrf: 'c' } },
    )
    expect(variables).toEqual({ session: 'old-renewed' })
  })

  it('sends a multipart sign-in request', async () => {
    const variables = await runAuthFlow(
      { config: config(), secrets: secrets() },
      [
        {
          type: 'request',
          name: 'upload',
          method: 'POST',
          path: 'login-form',
          params: [],
          headers: [],
          body: {
            type: 'multipart',
            parts: [
              { kind: 'text', key: 'user', value: '{{ secrets.user }}' },
              {
                kind: 'file',
                key: 'cert',
                file: 'aGVsbG8=',
                filename: 'cert.pem',
                contentType: 'text/plain',
              },
            ],
          },
        },
        { type: 'variable', name: 'session', value: '{{ upload.data.session }}', secret: true },
      ],
      { sandbox, signal: AbortSignal.timeout(5000) },
    )
    expect(variables).toEqual({ session: 'form-session' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(requests[0]!.body).toMatch(/name="user"\r\n\r\nada\r\n/)
    expect(requests[0]!.body).toMatch(
      /name="cert"; filename="cert.pem"\r\nContent-Type: text\/plain\r\n\r\nhello\r\n/,
    )
  })

  it('keeps sign-in requests to the allowed hosts', async () => {
    const err = await failure(
      runAuthFlow(
        { config: config(), secrets: secrets() },
        [
          {
            ...(loginSteps[0] as AuthFlowStep & { type: 'request' }),
            path: 'https://evil.example.com/login',
          },
        ],
        { sandbox, signal: AbortSignal.timeout(5000) },
      ),
    )
    expect(err.message).toMatch(/evil.example.com isn't allowed/)
  })
})

describe('form steps', () => {
  const formSteps: AuthFlowStep[] = [
    {
      type: 'form',
      name: 'signin',
      title: 'Sign in to Acme',
      fields: [
        { name: 'user', label: 'Username', kind: 'text' },
        { name: 'password', label: 'Password', kind: 'password' },
      ],
    },
    {
      type: 'request',
      name: 'login',
      method: 'POST',
      path: 'login',
      params: [],
      headers: [],
      body: { type: 'json', json: '{"user": {{ signin.user }}, "password": {{ signin.password }}}' },
    },
    { type: 'variable', name: 'session', value: '{{ login.data.session }}', secret: true },
  ]

  it('puts what the person typed in scope by step name', async () => {
    const variables = await runAuthFlow({ config: config(), secrets: secrets({}) }, formSteps, {
      sandbox,
      signal: AbortSignal.timeout(5000),
      form: { signin: { user: 'ada', password: 'pw-Secret-123', extra: 'ignored' } },
    })
    expect(variables).toEqual({ session: 'session-1' })
    expect(JSON.parse(requests[0]!.body)).toEqual({ user: 'ada', password: 'pw-Secret-123' })
  })

  it('asks for the form before running any step', async () => {
    const err = await failure(
      runAuthFlow({ config: config(), secrets: secrets({}) }, formSteps, {
        sandbox,
        signal: AbortSignal.timeout(5000),
      }),
    )
    expect(err).toMatchObject({ code: 'auth_required', details: { reason: 'form_needed', step: 'signin' } })
    expect(requests).toHaveLength(0)
  })

  it('treats a missing field as empty and scrubs typed values from failures', async () => {
    const err = await failure(
      runAuthFlow(
        { config: config(), secrets: secrets({}) },
        [
          formSteps[0]!,
          {
            type: 'code',
            name: 'check',
            code: 'throw new Error(`refused ${signin.password} for "${signin.user}"`)',
          },
        ],
        { sandbox, signal: AbortSignal.timeout(5000), form: { signin: { password: 'Typed-Pass-999' } } },
      ),
    )
    expect(err.message).toBe('Signing in failed at step "check": refused [REDACTED] for ""')
  })

  it('reads only what was sent, also for names an Object has (constructor, toString)', async () => {
    const steps: AuthFlowStep[] = [
      {
        type: 'form',
        name: 'constructor',
        title: '',
        fields: [{ name: 'toString', label: 'A', kind: 'text' }],
      },
      { type: 'variable', name: 'seen', value: '{{ JSON.stringify(constructor) }}', secret: false },
    ]
    const err = await failure(
      runAuthFlow({ config: config(), secrets: secrets({}) }, steps, {
        sandbox,
        signal: AbortSignal.timeout(5000),
        form: {},
      }),
    )
    expect(err.details).toMatchObject({ reason: 'form_needed', step: 'constructor' })
    const variables = await runAuthFlow({ config: config(), secrets: secrets({}) }, steps, {
      sandbox,
      signal: AbortSignal.timeout(5000),
      form: { constructor: {} },
    })
    expect(variables).toEqual({ seen: '{"toString":""}' })
  })
})

describe('the custom auth schema', () => {
  const parse = (auth: unknown) =>
    restConnector.configSchema.safeParse({ baseUrl: 'https://api.example.com', auth })
  const issues = (auth: unknown) => parse(auth).error?.issues.map((i) => [i.path.join('.'), i.message])

  it('takes form steps with distinct JS field names, in the sign-in steps only', () => {
    const form = {
      type: 'form',
      name: 'signin',
      fields: [{ name: 'user', label: 'Username' }],
    }
    const variable = { type: 'variable', name: 'token', value: '{{ signin.user }}' }
    const parsed = parse({ type: 'custom', steps: [form, variable] })
    expect(parsed.success).toBe(true)
    expect((parsed.data!.auth as { steps: unknown[] }).steps[0]).toEqual({
      type: 'form',
      name: 'signin',
      title: '',
      fields: [{ name: 'user', label: 'Username', kind: 'text' }],
    })
    expect(
      issues({
        type: 'custom',
        steps: [
          {
            ...form,
            fields: [
              { name: 'user', label: 'A' },
              { name: 'user', label: 'B' },
              { name: '2fa', label: 'C' },
              { name: 'code', label: ' ' },
            ],
          },
          variable,
        ],
        refreshSteps: [form],
      }),
    ).toEqual([
      [
        'auth.steps.0.fields.2.name',
        'Use a JavaScript name: letters, digits, _ or $, not starting with a digit',
      ],
      ['auth.steps.0.fields.3.label', 'Give the field a label'],
      ['auth.steps.0.fields.1.name', 'Another field is named "user"'],
      [
        'auth.refreshSteps.0',
        "Refresh steps can't ask for a form: they run without anyone there to fill it in",
      ],
    ])
    expect(issues({ type: 'custom', steps: [{ ...form, fields: [] }, variable] })).toEqual([
      ['auth.steps.0.fields', 'Add at least one field'],
    ])
  })

  it('needs a variable, distinct step names, JS names, valid templates and no GET bodies', () => {
    expect(parse({ type: 'custom', steps: loginSteps }).success).toBe(true)
    expect(issues({ type: 'custom', steps: [{ type: 'code', name: 'a', code: 'return 1' }] })).toEqual([
      ['auth.steps', 'Define at least one variable for the headers or parameters to use'],
    ])
    expect(
      issues({
        type: 'custom',
        steps: [
          { type: 'variable', name: 'token', value: '{{ 1 }}', secret: true },
          { type: 'variable', name: 'token', value: '{{ 2 }}', secret: true },
          { type: 'variable', name: 'auth', value: 'x', secret: true },
          { type: 'variable', name: '1st', value: 'x', secret: true },
          { type: 'variable', name: 'broken', value: '{{ a', secret: true },
          { type: 'request', name: 'get', method: 'GET', body: { type: 'json', json: '{}' } },
        ],
      }),
    ).toEqual([
      ['auth.steps.2.name', '"auth" and "secrets" are taken'],
      ['auth.steps.3.name', 'Use a JavaScript name: letters, digits, _ or $, not starting with a digit'],
      ['auth.steps.1.name', 'Another step is named "token"'],
      ['auth.steps.4', expect.stringMatching(/./)],
      ['auth.steps.5.body', "GET requests can't have a body"],
    ])
  })
})

describe('queries on a custom auth resource', () => {
  /** Signs in with the flow on first use and on `force`, like the server's source. */
  function flowSource(cfg: RestConfig, sec: RestSecrets) {
    let variables: Record<string, unknown> | undefined
    const calls: { force: boolean }[] = []
    const source: CredentialSource = {
      async authVariables({ signal, force }) {
        calls.push({ force: !!force })
        if (!variables || force)
          variables = await runAuthFlow(
            { config: cfg, secrets: sec },
            cfg.auth.type === 'custom' ? cfg.auth.steps : [],
            { sandbox, signal },
          )
        const vars = variables
        return {
          evaluate: (code) => sandbox.evalExpression(code, { auth: vars }),
          secrets: Object.values(vars).filter((v): v is string => typeof v === 'string'),
        }
      },
    }
    return { source, calls }
  }

  const run = (
    cfg: RestConfig,
    sec: RestSecrets,
    query: Record<string, unknown>,
    credentials?: CredentialSource,
  ) =>
    runQuery(pool, restConnector, resource(cfg, sec), query, {
      evaluate: scopeEvaluator({}),
      ...(credentials && { credentials }),
    })

  it('renders the resource headers and parameters with the variables, and scrubs them from results', async () => {
    const cfg = config()
    const sec = secrets()
    const { source, calls } = flowSource(cfg, sec)
    const result = await run(cfg, sec, { path: 'data' }, source)
    // Every variable's value is scrubbed, the CSRF token's too.
    // Every variable's value is scrubbed, the CSRF token's too.
    expect(result.data).toEqual({ ok: true, session: '[REDACTED]', key: 'k-[REDACTED]' })
    const call = requests.find((r) => r.path.startsWith('/api/data'))!
    expect(call.headers).toMatchObject({ 'x-session': 'session-1', 'x-static': 'plain' })
    // What went out had the real values (the result above is scrubbed).
    expect(call.path).toBe('/api/data?key=k-csrf-1')
    expect(calls).toEqual([{ force: false }])
  })

  it("lets a query's own headers override the resource's defaults, as for other auth types", async () => {
    const cfg = config({
      headers: [
        { key: 'x-session', value: '{{ auth.session }}' },
        { key: 'accept', value: 'application/json' },
      ],
    })
    const sec = secrets()
    await run(
      cfg,
      sec,
      { path: 'data', headers: [{ key: 'accept', value: 'text/csv' }] },
      flowSource(cfg, sec).source,
    )
    const call = requests.find((r) => r.path.startsWith('/api/data'))!
    expect(call.headers).toMatchObject({ accept: 'text/csv', 'x-session': 'session-1' })
  })

  it('refreshes once when the API answers 401', async () => {
    const cfg = config()
    const sec = secrets()
    const { source, calls } = flowSource(cfg, sec)
    await run(cfg, sec, { path: 'data' }, source)
    validSession = 'session-2' // the server ends the session; the next sign-in gets the new one
    const again = await run(cfg, sec, { path: 'data' }, source)
    expect(again.data).toMatchObject({ ok: true })
    expect(calls).toEqual([{ force: false }, { force: false }, { force: true }])
  })

  it('asks for the flow when there is none, and reports a failing one', async () => {
    const cfg = config()
    expect(await failure(run(cfg, secrets(), { path: 'data' }))).toMatchObject({ code: 'auth_required' })
    const bad = secrets({ user: 'ada', password: 'nope' })
    const err = await failure(run(cfg, bad, { path: 'data' }, flowSource(cfg, bad).source))
    expect(err).toMatchObject({ code: 'auth_required', details: { reason: 'flow_failed', step: 'login' } })
    // The secret password never shows up in the error.
    expect(JSON.stringify(err)).not.toContain('pw-Secret-123')
  })

  it('tests the connection by signing in', async () => {
    const cfg = config({ baseUrl: `${origin}/api/data` })
    const sec = secrets()
    // The base URL is the data endpoint here, so the login path climbs one level.
    const steps = loginSteps.map((s) => (s.type === 'request' ? { ...s, path: `${origin}/api/login` } : s))
    const withSteps = { ...cfg, auth: { ...cfg.auth, steps } } as RestConfig
    const ok = await testResource(restConnector, resource(withSteps, sec), {
      credentials: flowSource(withSteps, sec).source,
    })
    expect(ok).toMatchObject({ ok: true, message: 'HTTP 200 OK' })
  })
})
