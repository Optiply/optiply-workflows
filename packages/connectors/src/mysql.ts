import { type CompiledSql, compileSql, TemplateError } from '@ow/expressions'
import mysql from 'mysql2'
import { z } from 'zod'
import { resolveFragments } from './sql-fragments'
import { type Connector, ConnectorError, type QueryResult } from './types'

const configSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3306),
  database: z.string().min(1),
  user: z.string().min(1),
  /**
   * `require` encrypts without checking the certificate; `verify-full` checks the certificate and the hostname.
   * (mysql2 has no "try TLS, fall back to plain" mode like Postgres' `prefer`.)
   */
  ssl: z.enum(['disable', 'require', 'verify-full']).default('require'),
  /** PEM CA certificate for `verify-full` against a private CA. */
  caCert: z.string().optional(),
  poolSize: z.number().int().min(1).max(50).default(5),
  /**
   * Sets the session's `transaction_read_only`, so MySQL refuses writes. A guard against mistakes, not a security
   * boundary: for that, connect as a database user that only has SELECT.
   */
  readOnly: z.boolean().default(false),
  /** Queries returning more rows than this fail rather than load everything into memory. */
  maxRows: z.number().int().positive().default(10_000),
  statementTimeoutMs: z.number().int().positive().default(120_000),
})

const secretsSchema = z.object({ password: z.string().optional() })

const querySchema = z.object({ sql: z.string().min(1) })

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

interface Client {
  pool: mysql.Pool
  config: Config
  /** Options for a side connection that kills a running query. */
  connectionOptions: mysql.ConnectionOptions
}

export const mysqlConnector: Connector<Config, Secrets, Query, Client> = {
  type: 'mysql',
  label: 'MySQL',
  configSchema,
  secretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    const connectionOptions: mysql.ConnectionOptions = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: secrets.password,
      ssl: sslOption(config),
      connectTimeout: 10_000,
      charset: 'utf8mb4',
      // One statement per query: `select 1; drop table t` is a syntax error, not two statements.
      multipleStatements: false,
      // Never let the server (or a `LOAD DATA LOCAL INFILE` in a query) read files from this machine. mysql2
      // already refuses without an `infileStreamFactory`; dropping the capability flag makes the server refuse too.
      flags: ['-LOCAL_FILES'],
      // TIMESTAMPs are instants (the session runs in UTC); DATE and DATETIME are wall-clock values with no zone, so
      // they come back exactly as stored ("2026-10-14 09:30:00") instead of being guessed into an instant.
      timezone: 'Z',
      dateStrings: ['DATE', 'DATETIME'],
      // BIGINTs beyond 2^53 come back as strings instead of losing precision; DECIMALs are always strings.
      supportBigNumbers: true,
      bigNumberStrings: false,
    }
    const pool = mysql.createPool({
      ...connectionOptions,
      connectionLimit: config.poolSize,
      maxIdle: config.poolSize,
      idleTimeout: 60_000,
      enableKeepAlive: true,
    })
    return { pool, config, connectionOptions }
  },

  async destroyClient({ pool }) {
    await new Promise<void>((resolve) => pool.end(() => resolve()))
  },

  async testConnection(client, { signal, timeoutMs }) {
    const result = await runStatement(client, 'SELECT VERSION() AS version', [], {
      signal,
      timeoutMs,
      maxRows: 1,
    })
    return { message: `MySQL ${String((result.data as { version?: unknown }[])[0]?.version ?? '')}` }
  },

  validateQuery(query) {
    try {
      compileSql(query.sql, 'mysql')
      return []
    } catch (err) {
      if (err instanceof TemplateError) return [err]
      throw err
    }
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const plan = await resolveFragments(compileSql(query.sql, 'mysql'), 'mysql', ctx.evaluate)
    const values: unknown[] = []
    for (const param of plan.params) values.push(await ctx.evaluate(param.code))
    const { text, params } = expandParams(plan, values)
    return runStatement(client, text, params, {
      signal: ctx.signal,
      timeoutMs: Math.min(ctx.timeoutMs, client.config.statementTimeoutMs),
      maxRows: client.config.maxRows,
    })
  },
}

function sslOption(config: Config): mysql.SslOptions | undefined {
  if (config.ssl === 'disable') return undefined
  if (config.ssl === 'verify-full') {
    return { ...(config.caCert && { ca: config.caCert }), rejectUnauthorized: true, verifyIdentity: true }
  }
  return { rejectUnauthorized: false }
}

/**
 * Binds the evaluated `{{ }}` values. An array expands its `?` into one placeholder per item, so
 * `id IN ({{ ids }})` works (an empty array becomes `NULL`, which matches nothing); objects are sent as JSON text.
 * Careful with `NOT IN ({{ ids }})`: an empty array makes it `NOT IN (NULL)`, which matches nothing too, not
 * everything. Guard it: `(id NOT IN ({{ ids }}) OR {{ ids.length }} = 0)`.
 */
export function expandParams(plan: CompiledSql, values: unknown[]): { text: string; params: unknown[] } {
  let text = plan.text
  const params: unknown[] = []
  // Right to left, so earlier offsets stay valid while the text grows.
  for (let i = plan.offsets.length - 1; i >= 0; i--) {
    const value = values[i]
    if (!Array.isArray(value)) {
      params.unshift(toParam(value))
      continue
    }
    const at = plan.offsets[i]!
    text = text.slice(0, at) + (value.length ? value.map(() => '?').join(', ') : 'NULL') + text.slice(at + 1)
    params.unshift(...value.map(toParam))
  }
  return { text, params }
}

function toParam(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  ) {
    return JSON.stringify(value)
  }
  return value
}

/**
 * Runs one prepared statement on a pooled connection and streams its rows. Cancelling (the signal) and the
 * statement timeout kill the query from a side connection (`KILL QUERY`), and the connection is then dropped, not
 * returned: a kill still on its way must not hit the next query on it. If the kill can't be sent, dropping the
 * connection ends the wait. A result past `maxRows` drops the connection instead of reading the rest.
 */
async function runStatement(
  client: Client,
  text: string,
  params: unknown[],
  opts: { signal: AbortSignal; timeoutMs: number; maxRows: number },
): Promise<QueryResult> {
  const conn = await getConnection(client.pool, opts.signal).catch((err: unknown) => {
    throw toError(err, undefined)
  })
  await prepareSession(conn, client.config.readOnly)
  let stop: 'aborted' | 'timeout' | undefined
  let tooLarge = false
  // Ends the wait for the query's result; a destroyed connection doesn't fail the query it was running.
  let abandon: (() => void) | undefined
  const kill = (reason: 'aborted' | 'timeout') => {
    if (stop) return
    stop = reason
    void killQuery(client, conn.threadId).then((killed) => {
      if (killed) return
      conn.destroy()
      abandon?.()
    })
  }
  const onAbort = () => kill('aborted')
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => kill('timeout'), opts.timeoutMs)

  try {
    if (opts.signal.aborted) throw new ConnectorError('aborted', 'The query was cancelled')
    const rows: Record<string, unknown>[] = []
    let fields: mysql.FieldPacket[] = []
    let header: mysql.ResultSetHeader | undefined

    await new Promise<void>((resolve, reject) => {
      abandon = resolve
      // A server-side prepared statement: values are sent separately and never touch the SQL text.
      const q = conn.execute({ sql: text, values: params as mysql.ExecuteValues } as mysql.QueryOptions)
      q.on('fields', (f: mysql.FieldPacket[] | undefined) => {
        // Writes have no fields; CALL returns several result sets, and the rows of the first one are the result.
        if (!fields.length && f) fields = f
      })
      q.on('result', (row: unknown, resultIndex?: number) => {
        if (tooLarge) return
        if (isHeader(row)) {
          header ??= row
          return
        }
        if ((resultIndex ?? 0) > 0) return
        rows.push({ ...(row as Record<string, unknown>) })
        if (rows.length > opts.maxRows) {
          tooLarge = true
          // Stop reading: the connection is dropped (and the query killed) rather than drained.
          conn.destroy()
          void killQuery(client, conn.threadId)
          resolve()
        }
      })
      q.on('error', reject)
      q.on('end', () => resolve())
    })

    if (tooLarge) {
      throw new ConnectorError(
        'too_large',
        `The query returned more than ${opts.maxRows} rows. Add a LIMIT or raise the resource's maxRows.`,
      )
    }
    // A killed SLEEP() returns normally; anything stopped on purpose is reported as stopped.
    if (stop) throw stopError(stop)
    if (!fields.length && header) {
      return {
        data: [],
        metadata: {
          rowCount: header.affectedRows,
          affectedRows: header.affectedRows,
          insertId: header.insertId,
          fields: [],
        },
      }
    }
    return {
      data: rows,
      metadata: { rowCount: rows.length, fields: fields.map((f) => ({ name: f.name, type: f.type })) },
    }
  } catch (err) {
    throw toError(err, stop)
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
    if (stop) conn.destroy()
    else if (!tooLarge) {
      // Prepared statements are cached per connection; user SQL is arbitrary, so don't keep it.
      try {
        conn.unprepare(text)
      } catch {
        // Not prepared (it failed to parse) or the connection is gone.
      }
      conn.release()
    }
  }
}

/** Connections whose session is set up; the pool hands out the same connection objects again. */
const preparedSessions = new WeakSet<mysql.PoolConnection>()

/**
 * Sets up a connection's session before its first query. A connection whose setup fails is dropped and the query
 * fails: a read-only resource on a server without `transaction_read_only` (MariaDB before 11.1) must not run
 * read-write.
 */
async function prepareSession(conn: mysql.PoolConnection, readOnly: boolean): Promise<void> {
  if (preparedSessions.has(conn)) return
  const statements = ["SET SESSION time_zone = '+00:00'"]
  if (readOnly) statements.push('SET SESSION transaction_read_only = ON')
  for (const statement of statements) {
    try {
      await new Promise<void>((resolve, reject) =>
        conn.query(statement, (err) => (err ? reject(err) : resolve())),
      )
    } catch (err) {
      conn.destroy()
      throw new ConnectorError(
        'query',
        `Could not set up the session (${statement}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  preparedSessions.add(conn)
}

/** Waits for a pooled connection, giving up when the signal aborts (a late connection goes straight back). */
function getConnection(pool: mysql.Pool, signal: AbortSignal): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      settled = true
      reject(new ConnectorError('aborted', 'The query was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pool.getConnection((err, conn) => {
      signal.removeEventListener('abort', onAbort)
      if (settled) {
        conn?.release()
        return
      }
      settled = true
      if (err) reject(err)
      else resolve(conn)
    })
  })
}

/** `KILL QUERY` from a fresh connection: the query's own connection is busy waiting for it. True once it's sent. */
function killQuery(client: Client, threadId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const side = mysql.createConnection(client.connectionOptions)
    side.on('error', () => resolve(false))
    side.query('KILL QUERY ?', [threadId], (err) => {
      side.end(() => resolve(!err))
    })
  })
}

function isHeader(row: unknown): row is mysql.ResultSetHeader {
  return (
    row !== null &&
    typeof row === 'object' &&
    (row as { constructor?: { name?: string } }).constructor?.name === 'ResultSetHeader'
  )
}

function stopError(stop: 'aborted' | 'timeout'): ConnectorError {
  return stop === 'timeout'
    ? new ConnectorError('timeout', 'The query hit the statement timeout')
    : new ConnectorError('aborted', 'The query was cancelled')
}

/** MySQL errors keep their code and SQLSTATE; connection failures are told apart from query failures. */
function toError(err: unknown, stop: 'aborted' | 'timeout' | undefined): unknown {
  if (err instanceof ConnectorError) return err
  const e = err as { code?: string; errno?: number; sqlState?: string; sqlMessage?: string; message?: string }
  // Stopped on purpose: whatever the query died of (usually ER_QUERY_INTERRUPTED) is our own KILL QUERY.
  if (stop) return stopError(stop)
  const code = e.code ?? ''
  // Network failures first: Node's own errors carry a (negative) errno too.
  if (/^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|PROTOCOL_|HANDSHAKE_)/.test(code)) {
    return new ConnectorError('connection', `Could not connect to the database: ${e.message}`, { code })
  }
  if (e.sqlState || (e.errno ?? 0) > 0) {
    if (
      /^(ER_ACCESS_DENIED|ER_DBACCESS_DENIED|ER_BAD_DB_ERROR|ER_HOST_NOT_PRIVILEGED|ER_NOT_SUPPORTED_AUTH)/.test(
        code,
      )
    ) {
      return new ConnectorError(
        'connection',
        `Could not connect to the database: ${e.sqlMessage ?? e.message}`,
        {
          code,
        },
      )
    }
    return new ConnectorError('query', e.sqlMessage ?? e.message ?? String(err), {
      code: e.code,
      errno: e.errno,
      sqlState: e.sqlState,
    })
  }
  // TLS failures (an untrusted certificate, a hostname mismatch) happen while connecting.
  if (/CERT|SELF_SIGNED|ERR_TLS|ERR_SSL|UNABLE_TO_/.test(code)) {
    return new ConnectorError('connection', `Could not connect to the database: ${e.message}`, { code })
  }
  return err
}
