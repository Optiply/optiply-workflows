import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { type CompiledSql, compileSql, paramValue, placeholderFor, TemplateError } from '@ow/expressions'
import {
  Connection,
  type ConnectionConfiguration,
  ConnectionError,
  Request,
  RequestError,
  TYPES,
} from 'tedious'
import { z } from 'zod'
import { resolveFragments } from '../sql-fragments'
import { sshConnectionError, tunnelFor } from '../ssh/client'
import { sshConfigSchema, sshSecretsSchema } from '../ssh/settings'
import type { SshTunnel } from '../ssh/tunnel'
import { type Connector, ConnectorError, type QueryResult, statementTimeoutMs } from '../types'
import { TdsPool } from './pool'

// Microsoft SQL Server and Azure SQL (M38, docs/architecture.md §2.42), over tedious (TDS).

export const MSSQL_AUTH_TYPES = ['sql', 'ntlm', 'entra-password', 'entra-service-principal'] as const
export type MssqlAuth = (typeof MSSQL_AUTH_TYPES)[number]

const configSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(1433),
    /** A named instance (`SQLEXPRESS`): its port is looked up through the SQL Browser service instead of `port`. */
    instanceName: z.string().min(1).optional(),
    database: z.string().min(1),
    /**
     * How it signs in: a SQL login, a Windows (NTLM) domain account, an Entra ID user with a password (no MFA), or an
     * Entra ID app (service principal) with a client secret.
     */
    auth: z.enum(MSSQL_AUTH_TYPES).default('sql'),
    /** The login (`sql`), Windows user (`ntlm`) or Entra user (`entra-password`, `name@tenant.com`). */
    user: z.string().optional(),
    /** The Windows domain (`ntlm`). */
    domain: z.string().optional(),
    /** The Entra app's (client) id: the registered app for `entra-password`, the service principal's own. */
    clientId: z.string().optional(),
    /** The Entra directory (tenant) id: needed for a service principal; optional for a user. */
    tenantId: z.string().optional(),
    /**
     * `require` encrypts without checking the certificate; `verify-full` checks the certificate and the hostname.
     * Azure SQL always encrypts.
     */
    ssl: z.enum(['disable', 'require', 'verify-full']).default('require'),
    /** PEM CA certificate for `verify-full` against a private CA. */
    caCert: z.string().optional(),
    poolSize: z.number().int().min(1).max(50).default(5),
    /**
     * Every query runs in a transaction that is always rolled back, and one that reports changed rows fails. A guard
     * against mistakes, not a security boundary: for that, connect as a login that can only read (`db_datareader`).
     */
    readOnly: z.boolean().default(false),
    /** Queries returning more rows than this fail rather than load everything into memory. */
    maxRows: z.number().int().positive().default(1_000_000),
    statementTimeoutMs: z.number().int().positive().default(120_000),
    /** Connect through an SSH server (and jump hosts) rather than directly (M17). */
    ssh: sshConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const need = (field: 'user' | 'domain' | 'clientId' | 'tenantId', what: string) => {
      if (!config[field]?.trim())
        ctx.addIssue({ code: 'custom', path: [field], message: `${what} is required` })
    }
    if (config.auth !== 'entra-service-principal') need('user', 'The user')
    if (config.auth === 'ntlm') need('domain', 'The Windows domain')
    if (config.auth === 'entra-password' || config.auth === 'entra-service-principal') {
      need('clientId', 'The Entra app (client) id')
    }
    if (config.auth === 'entra-service-principal') need('tenantId', 'The Entra directory (tenant) id')
    if (config.instanceName && config.ssh) {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceName'],
        message: "Through an SSH tunnel, give the instance's port instead of its name",
      })
    }
  })

const secretsSchema = z.object({
  password: z.string().optional(),
  /** The service principal's client secret (`entra-service-principal`). */
  clientSecret: z.string().optional(),
  ssh: sshSecretsSchema.optional(),
})

const querySchema = z.object({ sql: z.string().min(1) })

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

interface Client {
  pool: TdsPool
  config: Config
  /** The SSH tunnel every connection goes through (M17), if the resource has one. */
  tunnel?: SshTunnel
}

export const mssqlConnector: Connector<Config, Secrets, Query, Client> = {
  type: 'mssql',
  label: 'Microsoft SQL Server',
  configSchema,
  secretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    const tunnel = tunnelFor(config, secrets)
    const settings = connectionSettings(config, secrets, tunnel)
    const pool = new TdsPool(() => openConnection(settings), config.poolSize)
    return { pool, config, ...(tunnel ? { tunnel } : {}) }
  },

  async destroyClient({ pool, tunnel }) {
    await pool.end()
    await tunnel?.close()
  },

  async testConnection(client, { signal, timeoutMs }) {
    const result = await runStatement(client, 'SELECT @@VERSION AS version', [], {
      signal,
      timeoutMs,
      maxRows: 1,
    })
    const version = String((result.data as { version?: unknown }[])[0]?.version ?? '')
    return { message: version.split('\n')[0]!.trim() || 'Connected' }
  },

  validateQuery(query) {
    try {
      compileSql(query.sql, 'mssql')
      return []
    } catch (err) {
      if (err instanceof TemplateError) return [err]
      throw err
    }
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const plan = await resolveFragments(compileSql(query.sql, 'mssql'), 'mssql', ctx.evaluate)
    if (client.config.readOnly) {
      const word = endsTransaction(plan.text)
      if (word) {
        throw new ConnectorError(
          'invalid_query',
          `This resource is read-only: every query runs in a transaction that is rolled back, so it can't use ${word}`,
        )
      }
    }
    const values: unknown[] = []
    for (const param of plan.params) values.push(await paramValue(param, ctx.evaluate))
    const { text, params } = expandParams(plan, values)
    return runStatement(client, text, params, {
      signal: ctx.signal,
      timeoutMs: statementTimeoutMs(ctx, client.config.statementTimeoutMs),
      maxRows: client.config.maxRows,
    })
  },
}

/** tedious' settings for one resource: its sign-in, TLS, and the tunnel each connection goes through. */
export function connectionSettings(
  config: Config,
  secrets: Secrets,
  tunnel?: SshTunnel,
): ConnectionConfiguration {
  return {
    server: config.host,
    authentication: authentication(config, secrets),
    options: {
      ...(config.instanceName ? { instanceName: config.instanceName } : { port: config.port }),
      database: config.database,
      encrypt: config.ssl !== 'disable',
      trustServerCertificate: config.ssl === 'require',
      ...(config.ssl === 'verify-full' && config.caCert
        ? { cryptoCredentialsDetails: { ca: config.caCert } }
        : {}),
      // Through a tunnel, the SSH servers' own connect time (15 s each) comes first, so their errors say which and why.
      connectTimeout: 15_000 + (config.ssh?.hops.length ?? 0) * 15_000,
      // Our own timer cancels the query (`statementTimeoutMs`); tedious' would fail it without telling the server.
      requestTimeout: 0,
      // A cancel the server doesn't acknowledge within this closes the connection.
      cancelTimeout: 5_000,
      // DATETIME and DATETIME2 have no zone: read as UTC, they come back as written (see `cellValue`).
      useUTC: true,
      useColumnNames: false,
      rowCollectionOnRequestCompletion: false,
      appName: 'Optiply Workflows',
      // Lets an Always On listener route to a readable secondary; a plain server ignores it.
      readOnlyIntent: config.readOnly,
      // Each connection is a channel through the tunnel; TLS goes over it, checked against `host`.
      ...(tunnel ? { connector: async () => asSocket(await tunnel.open(config.host, config.port)) } : {}),
    },
  }
}

function authentication(config: Config, secrets: Secrets): ConnectionConfiguration['authentication'] {
  const user = config.user?.trim() ?? ''
  const password = secrets.password ?? ''
  const need = (value: string | undefined, field: string, what: string): string => {
    if (!value) throw new ConnectorError('invalid_config', `${what} is required`, { field })
    return value
  }
  switch (config.auth) {
    case 'ntlm':
      return {
        type: 'ntlm',
        options: {
          domain: config.domain?.trim() ?? '',
          userName: user,
          password: need(password, 'password', 'The password'),
        },
      }
    case 'entra-password':
      return {
        type: 'azure-active-directory-password',
        options: {
          userName: user,
          password: need(password, 'password', 'The password'),
          clientId: config.clientId?.trim() ?? '',
          tenantId: config.tenantId?.trim() ?? '',
        },
      }
    case 'entra-service-principal':
      return {
        type: 'azure-active-directory-service-principal-secret',
        options: {
          clientId: config.clientId?.trim() ?? '',
          tenantId: config.tenantId?.trim() ?? '',
          clientSecret: need(secrets.clientSecret, 'clientSecret', 'The client secret'),
        },
      }
    default:
      return { type: 'default', options: { userName: user, password } }
  }
}

/** A tunnel channel as tedious wants its socket: it sets keep-alive and no-delay, which a channel has no use for. */
function asSocket(stream: Duplex): Socket {
  return Object.assign(stream, {
    setKeepAlive: () => stream,
    setNoDelay: () => stream,
  }) as unknown as Socket
}

function openConnection(settings: ConnectionConfiguration): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = new Connection(settings)
    // Failures after connecting end the connection, which the pool notices; this keeps them from being unhandled.
    conn.on('error', () => {})
    conn.connect((err) => {
      if (err) {
        conn.close()
        reject(err)
      } else resolve(conn)
    })
  })
}

interface TdsParam {
  name: string
  value: unknown
}

/**
 * Binds the evaluated `{{ }}` values as `@p1`, `@p2`…, numbered again in order. An array becomes one parameter per
 * item, so `id IN ({{ ids }})` works (an empty array becomes `NULL`, which matches nothing). Careful with
 * `NOT IN ({{ ids }})`: an empty array makes it `NOT IN (NULL)`, which matches nothing too, not everything.
 */
export function expandParams(plan: CompiledSql, values: unknown[]): { text: string; params: TdsParam[] } {
  let text = ''
  let from = 0
  const params: TdsParam[] = []
  const bind = (value: unknown) => {
    params.push({ name: `p${params.length + 1}`, value })
    return `@p${params.length}`
  }
  for (const [i, at] of plan.offsets.entries()) {
    text += plan.text.slice(from, at)
    from = at + placeholderFor('mssql', i + 1).length
    const value = values[i]
    if (!Array.isArray(value)) text += bind(value)
    else text += value.length ? value.map(bind).join(', ') : 'NULL'
  }
  return { text: text + plan.text.slice(from), params }
}

/** A value's SQL Server type: what it is in JavaScript (objects are sent as JSON text). */
function tdsType(value: unknown): { type: (typeof TYPES)[keyof typeof TYPES]; value: unknown } {
  if (value === undefined || value === null) return { type: TYPES.NVarChar, value: null }
  if (typeof value === 'boolean') return { type: TYPES.Bit, value }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) <= 2_147_483_647) return { type: TYPES.Int, value }
    if (Number.isSafeInteger(value)) return { type: TYPES.BigInt, value }
    return { type: TYPES.Float, value }
  }
  if (typeof value === 'bigint') return { type: TYPES.BigInt, value: value.toString() }
  if (value instanceof Date) return { type: TYPES.DateTimeOffset, value }
  if (value instanceof Uint8Array) return { type: TYPES.VarBinary, value: Buffer.from(value) }
  if (typeof value === 'object') return { type: TYPES.NVarChar, value: JSON.stringify(value) }
  return { type: TYPES.NVarChar, value: String(value) }
}

/**
 * The first `COMMIT` or `ROLLBACK` outside strings, quoted names and comments: a read-only resource's query can't end
 * the transaction it runs in (what it did after that would stay). Dynamic SQL (`EXEC('COMMIT')`) isn't seen: the
 * check after the query catches it, too late to undo (see `runStatement`).
 */
export function endsTransaction(sql: string): string | undefined {
  let bare = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
    } else if (ch === '/' && next === '*') {
      let depth = 0
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2
          if (--depth === 0) break
        } else i++
      }
    } else if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      i++
      while (i < sql.length) {
        if (sql[i] === close && sql[i + 1] === close) i += 2
        else if (sql[i] === close) {
          i++
          break
        } else i++
      }
    } else {
      bare += ch
      i++
      continue
    }
    bare += ' '
  }
  return /\b(COMMIT|ROLLBACK)\b/i.exec(bare)?.[1]?.toUpperCase()
}

interface Outcome {
  columns: { name: string; type: string }[] | undefined
  rows: Record<string, unknown>[]
  /** Rows changed by statements that return none (INSERT, UPDATE, DELETE, SELECT INTO, MERGE). */
  affected: number
  tooLarge: boolean
}

/**
 * Runs one statement on a pooled connection and collects the first result set's rows. Cancelling (the signal), the
 * statement timeout and too many rows cancel the query on the server (a TDS attention; the connection stays usable).
 * Afterwards any transaction still open is rolled back, so nothing a query leaves open (or a read-only resource's own
 * transaction) carries over to the next one; a connection that can't be cleaned up is closed.
 */
async function runStatement(
  client: Client,
  text: string,
  params: TdsParam[],
  opts: { signal: AbortSignal; timeoutMs: number; maxRows: number },
): Promise<QueryResult> {
  const conn = await client.pool.acquire(opts.signal).catch((err: unknown) => {
    throw toError(err, undefined)
  })
  const { readOnly } = client.config
  let stop: 'aborted' | 'timeout' | undefined
  const halt = (reason: 'aborted' | 'timeout') => {
    if (stop) return
    stop = reason
    conn.cancel()
  }
  const onAbort = () => halt('aborted')
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => halt('timeout'), opts.timeoutMs)

  let outcome: Outcome | undefined
  let failure: unknown
  let begun = false
  try {
    if (opts.signal.aborted) throw new ConnectorError('aborted', 'The query was cancelled')
    if (readOnly) {
      await batch(conn, 'BEGIN TRANSACTION')
      begun = true
    }
    outcome = await exec(conn, text, params, opts.maxRows)
  } catch (err) {
    failure = err
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
  }

  // Roll back whatever is still open; a read-only resource's transaction must still be ours.
  let openBefore: number | undefined
  try {
    const rows = await batch(
      conn,
      'DECLARE @n int = @@TRANCOUNT; IF @@TRANCOUNT > 0 ROLLBACK; SELECT @n AS n',
    )
    openBefore = Number(rows[0]?.n ?? 0)
    client.pool.release(conn)
  } catch {
    client.pool.destroy(conn)
  }

  if (stop) throw stopError(stop)
  // Before any error the query raised: SQL Server adds its own (266) when a query ends the transaction it began in.
  // Ours, ended by the query: it succeeded anyway, or SQL Server said so (266, "mismatching BEGIN and COMMIT"). Any
  // other error (a deadlock, XACT_ABORT) rolled it back itself and is reported as it is.
  if (readOnly && begun && openBefore === 0 && (!failure || serverError(failure) === 266)) {
    throw new ConnectorError(
      'query',
      'This resource is read-only, but the query ended its transaction itself (COMMIT or ROLLBACK, e.g. in dynamic SQL): what it changed after that may have been kept',
    )
  }
  if (failure) throw toError(failure, undefined)
  const result = outcome!
  if (result.tooLarge) {
    throw new ConnectorError(
      'too_large',
      `The query returned more than ${opts.maxRows} rows. Add TOP or OFFSET … FETCH, or raise the resource's maxRows.`,
    )
  }
  if (readOnly && result.affected > 0) {
    throw new ConnectorError(
      'query',
      `This resource is read-only: the query changed ${result.affected} row${result.affected === 1 ? '' : 's'}, and the change was rolled back`,
      { affectedRows: result.affected },
    )
  }
  if (!result.columns) {
    return {
      data: [],
      metadata: { rowCount: result.affected, affectedRows: result.affected, fields: [] },
    }
  }
  return { data: result.rows, metadata: { rowCount: result.rows.length, fields: result.columns } }
}

interface ColumnMeta {
  colName: string
  type: { name: string }
  dataLength?: number
}

/** Runs a user statement (sp_executesql, its values bound) and reads its first result set. */
function exec(conn: Connection, text: string, params: TdsParam[], maxRows: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let sets = 0
    let current: ColumnMeta[] | undefined
    let names: string[] = []
    let columns: Outcome['columns']
    const rows: Record<string, unknown>[] = []
    let affected = 0
    let tooLarge = false
    const req = new Request(text, (err) => {
      if (err && !(tooLarge && (err as { code?: string }).code === 'ECANCEL')) reject(err)
      else resolve({ columns, rows, affected, tooLarge })
    })
    req.on('columnMetadata', (columnsOrMap) => {
      const meta = columnsOrMap as unknown as ColumnMeta[]
      sets++
      current = meta
      if (sets !== 1) return
      // Unnamed columns (`SELECT COUNT(*)`) get a name; a repeated name keeps the last value, as in MySQL.
      names = meta.map((c, i) => c.colName || `column${i + 1}`)
      columns = meta.map((c, i) => ({ name: names[i]!, type: c.type.name }))
    })
    req.on('row', (cells: { value: unknown; metadata: ColumnMeta }[]) => {
      // Several result sets: the first one is the result.
      if (sets !== 1 || tooLarge) return
      const row: Record<string, unknown> = {}
      for (const [i, cell] of cells.entries()) row[names[i]!] = cellValue(cell.value, cell.metadata)
      rows.push(row)
      if (rows.length > maxRows) {
        tooLarge = true
        conn.cancel()
      }
    })
    // Each statement ends with a DONE: a count without columns before it is a write (or `SELECT @v = …`).
    const done = (rowCount: number | undefined) => {
      if (rowCount !== undefined && !current) affected += rowCount
      current = undefined
    }
    req.on('doneInProc', done)
    req.on('done', done)
    for (const p of params) {
      const { type, value } = tdsType(p.value)
      req.addParameter(p.name, type, value)
    }
    conn.execSql(req)
  })
}

/** Runs our own statements (no values), returning the last result set's rows. */
function batch(conn: Connection, text: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let names: string[] = []
    let rows: Record<string, unknown>[] = []
    const req = new Request(text, (err) => (err ? reject(err) : resolve(rows)))
    req.on('columnMetadata', (columnsOrMap) => {
      const meta = columnsOrMap as unknown as ColumnMeta[]
      names = meta.map((c) => c.colName)
      rows = []
    })
    req.on('row', (cells: { value: unknown }[]) => {
      rows.push(Object.fromEntries(cells.map((c, i) => [names[i]!, c.value])))
    })
    conn.execSqlBatch(req)
  })
}

/**
 * A cell as a JSON-friendly value. DATE, DATETIME, DATETIME2 and SMALLDATETIME have no zone: they come back as written
 * (`2026-10-14 09:30:00`), not guessed into an instant; DATETIMEOFFSET is an instant (ISO, UTC); TIME is `09:30:00`.
 * BIGINTs within 2^53 are numbers, beyond it strings. DECIMAL, NUMERIC and MONEY are numbers (tedious reads them so;
 * beyond 15 significant digits they lose precision: CAST them to a string for exact values).
 */
export function cellValue(value: unknown, meta: Pick<ColumnMeta, 'type' | 'dataLength'>): unknown {
  if (value === null || value === undefined) return null
  const type = meta.type.name
  if (value instanceof Date) {
    const iso = value.toISOString()
    const time = iso.slice(11, 23).replace(/\.000$/, '')
    if (type === 'DateTimeOffset' || type === 'DateTimeOffsetN') return iso
    if (type === 'Date' || type === 'DateN') return iso.slice(0, 10)
    if (type === 'Time' || type === 'TimeN') return time
    return `${iso.slice(0, 10)} ${time}`
  }
  if (typeof value === 'string' && (type === 'BigInt' || (type === 'IntN' && meta.dataLength === 8))) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : value
  }
  return value
}

/** The SQL Server error number of a failure (the first one, of several). */
function serverError(err: unknown): number | undefined {
  const all = err instanceof AggregateError ? (err.errors as unknown[]) : [err]
  for (const e of all) if (e instanceof RequestError && e.number !== undefined) return e.number
  return undefined
}

function stopError(stop: 'aborted' | 'timeout'): ConnectorError {
  return stop === 'timeout'
    ? new ConnectorError('timeout', 'The query hit the statement timeout')
    : new ConnectorError('aborted', 'The query was cancelled')
}

/** SQL Server errors keep their number and state; connection failures are told apart from query failures. */
function toError(err: unknown, stop: 'aborted' | 'timeout' | undefined): unknown {
  if (err instanceof ConnectorError) return err
  const ssh = sshConnectionError(err) ?? sshConnectionError((err as { cause?: unknown } | undefined)?.cause)
  if (ssh) return ssh
  if (stop) return stopError(stop)
  // Several errors from one request (or one connection attempt per address) come as one AggregateError.
  const all = err instanceof AggregateError ? (err.errors as unknown[]) : [err]
  const message = all.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
  const first = all[0] as { code?: string; number?: number; state?: number; class?: number } | undefined
  if (all.some((e) => e instanceof ConnectionError)) {
    return new ConnectorError('connection', `Could not connect to the database: ${message}`, {
      code: first?.code,
    })
  }
  if (all.some((e) => e instanceof RequestError)) {
    const server = all.find((e): e is RequestError => e instanceof RequestError && e.number !== undefined)
    return new ConnectorError('query', message, {
      code: first?.code,
      ...(server && { number: server.number, state: server.state, class: server.class }),
    })
  }
  return err
}
