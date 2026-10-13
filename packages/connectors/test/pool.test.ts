import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Connector, ConnectorError, getConnector, isPrivateAddress, PoolManager, runQuery } from '../src'
import { hostMatches } from '../src/net-guard'
import { resource, scopeEvaluator } from './helpers'

interface FakeClient {
  id: number
  closed: boolean
}

/** Records client lifecycles; `execute` echoes the secret back in data, metadata and (optionally) errors. */
function fakeConnector(opts: { failCreate?: () => boolean; scrubResultData?: boolean } = {}) {
  const created: FakeClient[] = []
  const connector: Connector<{ fail?: boolean }, { password?: string }, { q: string }, FakeClient> = {
    type: 'fake',
    label: 'Fake',
    configSchema: z.object({ fail: z.boolean().optional() }),
    secretsSchema: z.object({ password: z.string().optional() }),
    querySchema: z.object({ q: z.string() }),
    scrubResultData: opts.scrubResultData,
    createClient() {
      if (opts.failCreate?.()) throw new Error('cannot connect')
      const client = { id: created.length + 1, closed: false }
      created.push(client)
      return client
    },
    async destroyClient(client) {
      client.closed = true
    },
    async testConnection() {
      return {}
    },
    validateQuery: () => [],
    async execute(client, query, ctx) {
      if (query.q === 'wait') await new Promise((r) => setTimeout(r, 50))
      if (query.q === 'fail') throw new Error('login failed for password hunter2-secret')
      return {
        data: { echo: 'data hunter2-secret', value: await ctx.evaluate('x') },
        metadata: { client: client.id, note: 'meta hunter2-secret' },
      }
    },
  }
  return { connector, created }
}

const secrets = { password: 'hunter2-secret' }

describe('PoolManager', () => {
  it('reuses a client per config version and replaces it when the version changes', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0 })
    const { connector, created } = fakeConnector()
    const v1 = resource({}, secrets, '1')
    await pool.withClient(connector, v1, async () => {})
    await pool.withClient(connector, v1, async () => {})
    expect(created).toHaveLength(1)

    await pool.withClient(connector, { ...v1, version: '2' }, async () => {})
    expect(created).toHaveLength(2)
    expect(created[0]!.closed).toBe(true)
    expect(pool.size).toBe(1)
    await pool.closeAll()
    expect(created[1]!.closed).toBe(true)
  })

  it('never closes a client that is in use', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0 })
    const { connector, created } = fakeConnector()
    const res = resource({}, secrets)
    let release!: () => void
    const busy = pool.withClient(connector, res, () => new Promise<void>((r) => (release = r)))
    await new Promise((r) => setTimeout(r, 5))

    await pool.invalidate(res.id)
    await pool.sweep(Date.now() + 60 * 60_000)
    expect(created[0]!.closed).toBe(false)
    release()
    await busy
    expect(created[0]!.closed).toBe(true)
    expect(pool.size).toBe(0)
  })

  it('closes idle clients after idleMs and evicts the least recently used beyond maxClients', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0, idleMs: 1000, maxClients: 2 })
    const { connector, created } = fakeConnector()
    const [a, b, c] = [resource({}, secrets), resource({}, secrets), resource({}, secrets)]
    await pool.withClient(connector, a, async () => {})
    await pool.withClient(connector, b, async () => {})
    await pool.withClient(connector, a, async () => {}) // a is now most recently used
    await pool.withClient(connector, c, async () => {})
    expect(created.map((x) => x.closed)).toEqual([false, true, false])

    await pool.sweep(Date.now() + 1000)
    expect(pool.size).toBe(0)
  })

  it('does not cache a client that failed to connect', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0 })
    let fail = true
    const { connector, created } = fakeConnector({ failCreate: () => fail })
    const res = resource({}, secrets)
    await expect(pool.withClient(connector, res, async () => {})).rejects.toThrow('cannot connect')
    fail = false
    await pool.withClient(connector, res, async () => {})
    expect(created).toHaveLength(1)
    await pool.closeAll()
  })
})

describe('runQuery', () => {
  it('scrubs secrets from errors and metadata, and from data only when the connector opts in', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0 })
    const evaluate = scopeEvaluator({ x: 1 })
    const plain = fakeConnector()
    const ok = await runQuery(pool, plain.connector, resource({}, secrets), { q: 'ok' }, { evaluate })
    expect(ok.data).toEqual({ echo: 'data hunter2-secret', value: 1 })
    expect(ok.metadata.note).toBe('meta [REDACTED]')

    const scrubbing = fakeConnector({ scrubResultData: true })
    const scrubbed = await runQuery(
      pool,
      scrubbing.connector,
      resource({}, secrets),
      { q: 'ok' },
      { evaluate },
    )
    expect(scrubbed.data).toEqual({ echo: 'data [REDACTED]', value: 1 })

    const err = await runQuery(
      pool,
      plain.connector,
      resource({}, secrets),
      { q: 'fail' },
      { evaluate },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.message).toBe('login failed for password [REDACTED]')
    await pool.closeAll()
  })

  it('validates the query shape and the stored config', async () => {
    const pool = new PoolManager({ sweepIntervalMs: 0 })
    const { connector } = fakeConnector()
    const evaluate = scopeEvaluator({})
    await expect(
      runQuery(pool, connector, resource({}, secrets), { nope: 1 }, { evaluate }),
    ).rejects.toMatchObject({
      code: 'invalid_query',
      details: { issues: [{ path: 'q' }] },
    })
    await expect(
      runQuery(pool, connector, resource({ fail: 'x' }, secrets), { q: 'ok' }, { evaluate }),
    ).rejects.toMatchObject({
      code: 'invalid_config',
    })
    // Secret validation errors report the path only, never the value.
    const err = await runQuery(
      pool,
      connector,
      resource({}, { password: 12345 }),
      { q: 'ok' },
      { evaluate },
    ).catch((e) => e)
    expect(err.details).toEqual({ issues: [{ path: 'password' }] })
    await pool.closeAll()
  })
})

describe('registry and network helpers', () => {
  it('looks connectors up by type', () => {
    expect(getConnector('postgres')?.label).toBe('PostgreSQL')
    expect(getConnector('rest')?.label).toBe('REST API')
    expect(getConnector('toString')).toBeUndefined()
  })

  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    ['example.com', false],
  ])('isPrivateAddress(%s) = %s', (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected)
  })

  it('matches allowed host patterns', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('API.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('x.api.example.com', '*.example.com')).toBe(true)
    expect(hostMatches('example.com', '*.example.com')).toBe(false)
    expect(hostMatches('evilexample.com', '*.example.com')).toBe(false)
  })
})
