import { readFileSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  PoolManager,
  type ResolvedResource,
  restConnector,
  runQuery,
  testResource,
} from '../src'
import { startTestSshServer, type TestSshServer } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

/**
 * M17 step 3b: REST resources through an SSH tunnel. The API is `api.internal`, which only the test SSH server resolves;
 * its HTTPS certificate is for that name, signed by a test CA this file trusts (fixtures/tls).
 */

const ssh_ = (name: string) => readFileSync(new URL(`./fixtures/ssh/${name}`, import.meta.url), 'utf8')
const tlsFixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), 'utf8')

let ssh: TestSshServer
let http: Server
let https: Server
let httpPort: number
let httpsPort: number
let pool: PoolManager
const seen: { path: string; host: string; authorization?: string }[] = []
const defaultCas = tls.getCACertificates('default')

function api(req: IncomingMessage, res: ServerResponse) {
  seen.push({ path: req.url ?? '', host: req.headers.host ?? '', authorization: req.headers.authorization })
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/token')
    return res.end(JSON.stringify({ access_token: 'tunnelled-token', expires_in: 3600 }))
  res.end(JSON.stringify({ path: req.url, secure: 'encrypted' in req.socket }))
}

beforeAll(async () => {
  tls.setDefaultCACertificates([...defaultCas, tlsFixture('ca.crt')])
  http = createHttp(api)
  https = createHttps({ key: tlsFixture('api.internal.key'), cert: tlsFixture('api.internal.crt') }, api)
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
  httpPort = (http.address() as { port: number }).port
  httpsPort = (https.address() as { port: number }).port
  ssh = await startTestSshServer({
    users: [{ username: 'ow', publicKey: ssh_('openssh-ed25519.pub') }],
    hosts: { 'api.internal': '127.0.0.1', 'other.internal': '127.0.0.1' },
  })
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
  await ssh?.close()
  await new Promise((r) => http?.close(r))
  await new Promise((r) => https?.close(r))
  tls.setDefaultCACertificates(defaultCas)
})

const tunnel = (over: Record<string, unknown> = {}) => ({
  hops: [
    {
      id: 'bastion',
      host: ssh.host,
      port: ssh.port,
      username: 'ow',
      auth: 'key',
      hostKey: ssh.hostKey,
      ...over,
    },
  ],
})
const restResource = (config: Record<string, unknown>, version: string): ResolvedResource =>
  resource(
    { ssh: tunnel(), ...config },
    { clientSecret: 'cs', ssh: { bastion: { privateKey: ssh_('openssh-ed25519') } } },
    version,
  )
const get = (res: ResolvedResource, path: string) =>
  runQuery(pool, restConnector, res, { method: 'GET', path }, { evaluate: scopeEvaluator({}) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('it worked')
}

describe('REST through an SSH tunnel', () => {
  it('sends requests through it, over http', async () => {
    const res = restResource({ baseUrl: `http://api.internal:${httpPort}/v1` }, 'http')
    const result = await get(res, 'hello')
    expect(result.data).toEqual({ path: '/v1/hello', secure: false })
    expect(seen.at(-1)?.host).toBe(`api.internal:${httpPort}`)
    expect(ssh.forwards.at(-1)).toEqual({ host: 'api.internal', port: httpPort, allowed: true })
    expect(await testResource(restConnector, res)).toMatchObject({ ok: true })
  })

  it('speaks TLS over it, checking the certificate against the hostname', async () => {
    const result = await get(
      restResource({ baseUrl: `https://api.internal:${httpsPort}` }, 'https'),
      'secure',
    )
    expect(result.data).toEqual({ path: '/secure', secure: true })
    // The same server under a name its certificate isn't for: refused.
    const wrongName = await failure(
      get(restResource({ baseUrl: `https://other.internal:${httpsPort}` }, 'mismatch'), 'x'),
    )
    expect(wrongName.code).toBe('connection')
    expect(wrongName.message).toMatch(
      /Host: other\.internal\. is not in the cert's altnames: DNS:api\.internal/,
    )
  })

  it("reaches private addresses through it (the SSH server's network), not without it", async () => {
    const result = await get(restResource({ baseUrl: `http://127.0.0.1:${httpPort}` }, 'private'), 'p')
    expect(result.data).toMatchObject({ path: '/p' })
    const direct = await failure(
      get(resource({ baseUrl: `http://127.0.0.1:${httpPort}` }, {}, 'direct'), 'p'),
    )
    expect(direct.code).toBe('blocked')
  })

  it('gets an OAuth2 client-credentials token through it too', async () => {
    const res = restResource(
      {
        baseUrl: `http://api.internal:${httpPort}`,
        auth: {
          type: 'oauth2ClientCredentials',
          tokenUrl: `http://api.internal:${httpPort}/token`,
          clientId: 'ow',
        },
      },
      'oauth',
    )
    await get(res, 'with-token')
    expect(seen.at(-2)?.path).toBe('/token')
    expect(seen.at(-1)).toMatchObject({ path: '/with-token', authorization: 'Bearer tunnelled-token' })
  })

  it('says which SSH server refused, with its host key', async () => {
    const err = await failure(
      get(
        restResource(
          { baseUrl: `http://api.internal:${httpPort}`, ssh: tunnel({ hostKey: undefined }) },
          'untrusted',
        ),
        'x',
      ),
    )
    expect(err.code).toBe('connection')
    expect(err.details).toMatchObject({
      ssh: {
        code: 'ssh_host_key_unknown',
        hop: 'bastion',
        hostKey: { fingerprint: ssh.hostKey.fingerprint },
      },
    })
  })
})
