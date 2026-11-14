import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { type CompiledSql, compileSql, paramValue, TemplateError } from '@ow/expressions'
import { z } from 'zod'
import { resolveFragments } from '../sql-fragments'
import { tunnelFor } from '../ssh/client'
import type { SshTunnel } from '../ssh/tunnel'
import {
  type Connector,
  ConnectorError,
  type CredentialSource,
  type QueryResult,
  statementTimeoutMs,
} from '../types'
import { jdbcForwarder } from './forwarder'
import { type JarSource, jdbcRunner, uploadedDriver } from './runner'
import {
  type JdbcConfig,
  type JdbcConnection,
  type JdbcSecrets,
  jdbcConfigSchema,
  jdbcConnection,
  jdbcDialect,
  jdbcHttpConfig,
  jdbcSecretsSchema,
} from './settings'

// JDBC resources (M38, docs/architecture.md §2.42): Oracle, Snowflake, ClickHouse and uploaded drivers, run by the
// JDBC runner. This side builds the connection and binds `{{ }}`; the runner holds the pools and talks to the database.

const querySchema = z.object({ sql: z.string().min(1) })

/**
 * This process's part of a pool's name: the api and each worker keep their own pools in the runner, so one dropping
 * its client (idle, or settings changed) never closes a pool another is running a query on.
 */
export const JDBC_PROCESS = randomBytes(4).toString('hex')
type Query = z.output<typeof querySchema>

interface Client {
  config: JdbcConfig
  connection: JdbcConnection
  /** An uploaded driver's jar, when the runner asks for it. */
  jar?: JarSource
  /** The SSH tunnel the runner's connections go through (step 4), and its id at this process's forwarder. */
  tunnel?: { ssh: SshTunnel; id: string }
}

export const jdbcConnector: Connector<JdbcConfig, JdbcSecrets, Query, Client> = {
  type: 'jdbc',
  label: 'JDBC',
  configSchema: jdbcConfigSchema,
  secretsSchema: jdbcSecretsSchema,
  querySchema,
  httpConfig: jdbcHttpConfig,

  async createClient({ id, version, config, secrets }) {
    let connection = jdbcConnection(config, secrets, `${id}:${version}:${JDBC_PROCESS}`)
    let jar: JarSource | undefined
    if (config.driver === 'uploaded') {
      const driver = await uploadedDriver(config.driverId ?? '')
      connection = { ...connection, driverSha: driver.sha256, driverClass: driver.className }
      jar = driver.jar
    }
    const ssh = tunnelFor(config, secrets)
    if (!ssh) return { config, connection, ...(jar ? { jar } : {}) }
    try {
      const tunnel = await jdbcForwarder().register(ssh, config.tunnelHosts, sshRoute(config))
      return {
        config,
        connection: { ...connection, tunnel },
        ...(jar ? { jar } : {}),
        tunnel: { ssh, id: tunnel.tunnelId },
      }
    } catch (err) {
      await ssh.close()
      throw err
    }
  },

  async destroyClient(client) {
    if (client.tunnel) jdbcForwarder().unregister(client.tunnel.id)
    await jdbcRunner()
      .closePools(client.connection.poolKey)
      .catch(() => {})
    await client.tunnel?.ssh.close()
  },

  async testConnection(client, { signal, timeoutMs, credentials }) {
    const connection = await withToken(client, credentials, signal)
    return jdbcRunner().test(connection, { signal, timeoutMs, ...(client.jar ? { jar: client.jar } : {}) })
  },

  validateQuery(query) {
    // The driver isn't known here: fine if any JDBC dialect reads it (Snowflake's $$ strings, ClickHouse's backslash
    // escapes); `execute` compiles it again in the driver's own.
    let first: TemplateError | undefined
    for (const dialect of ['jdbc', 'oracle', 'snowflake', 'clickhouse'] as const) {
      try {
        compileSql(query.sql, dialect)
        return []
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err
        first ??= err
      }
    }
    return first ? [first] : []
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const dialect = jdbcDialect(client.config.driver)
    const plan = await resolveFragments(compileSql(query.sql, dialect), dialect, ctx.evaluate)
    const values: unknown[] = []
    for (const param of plan.params) values.push(await paramValue(param, ctx.evaluate))
    const { text, params } = expandParams(plan, values)
    const connection = await withToken(client, ctx.credentials, ctx.signal)
    return jdbcRunner().query(
      {
        queryId: randomUUID(),
        connection,
        sql: text,
        params,
        maxRows: client.config.maxRows,
        timeoutMs: statementTimeoutMs(ctx, client.config.statementTimeoutMs),
      },
      { signal: ctx.signal, ...(client.jar ? { jar: client.jar } : {}) },
    )
  },
}

/**
 * Snowflake OAuth: the token of whoever runs the query (or the shared account), as of now. Its pool is the token's
 * own: a session signed in as one person must never run another's query (a refreshed token starts a new pool; the
 * runner closes the old one when it's idle).
 */
async function withToken(
  client: Client,
  credentials: CredentialSource | undefined,
  signal: AbortSignal,
): Promise<JdbcConnection> {
  if (!client.connection.tokenProperty) return client.connection
  if (!credentials?.accessToken) {
    throw new ConnectorError('auth_required', 'Connect a Snowflake account to this resource first')
  }
  const token = await credentials.accessToken({ signal })
  const owner = createHash('sha256').update(token).digest('hex').slice(0, 16)
  return { ...client.connection, poolKey: `${client.connection.poolKey}:${owner}`, token }
}

/**
 * Which network a tunnel reaches: its SSH servers in order (where, as whom, through IAP or not), never their keys. Every
 * app process and resource on one route reaches the same hosts; the runner shares their addresses.
 */
export function sshRoute(config: JdbcConfig): string {
  const hops = (config.ssh?.hops ?? []).map((h) => [
    h.reach ?? 'direct',
    h.host,
    h.port,
    h.username,
    h.iap ?? null,
  ])
  return createHash('sha256').update(JSON.stringify(hops)).digest('hex').slice(0, 32)
}

/**
 * The values for the `?`s. An array becomes one `?` per item, so `id IN ({{ ids }})` works (an empty array becomes
 * `NULL`, which matches nothing; careful with `NOT IN`, as in MySQL). Dates go as `{ $timestamp }` (bound as timestamps,
 * which Oracle compares with its DATEs; ISO text it wouldn't parse) and binary as `{ $bytes }`; other objects as JSON
 * text; booleans, numbers and strings as they are.
 */
export function expandParams(plan: CompiledSql, values: unknown[]): { text: string; params: unknown[] } {
  let text = ''
  let from = 0
  const params: unknown[] = []
  for (const [i, at] of plan.offsets.entries()) {
    text += plan.text.slice(from, at)
    from = at + 1
    const value = values[i]
    if (!Array.isArray(value)) {
      text += '?'
      params.push(toParam(value))
    } else if (!value.length) text += 'NULL'
    else {
      text += value.map(() => '?').join(', ')
      for (const item of value) params.push(toParam(item))
    }
  }
  return { text: text + plan.text.slice(from), params }
}

function toParam(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return { $timestamp: value.toISOString() }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}
