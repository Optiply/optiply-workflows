import { compileSql, paramValue, TemplateError } from '@ow/expressions'
import postgres from 'postgres'
import { z } from 'zod'
import { resolveFragments } from './sql-fragments'
import { sshConnectionError, tunnelFor } from './ssh/client'
import { sshConfigSchema, sshSecretsSchema } from './ssh/settings'
import type { SshTunnel } from './ssh/tunnel'
import { type Connector, ConnectorError, type QueryResult } from './types'

const configSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  /** `prefer` tries TLS and falls back; `verify-full` checks the certificate and hostname. */
  ssl: z.enum(['disable', 'prefer', 'require', 'verify-full']).default('prefer'),
  /** PEM CA certificate for `verify-full` against a private CA. */
  caCert: z.string().optional(),
  poolSize: z.number().int().min(1).max(50).default(5),
  /**
   * Runs every query in a READ ONLY transaction on a read-only session. A guard against mistakes, not a security
   * boundary: for that, connect as a database user that only has SELECT.
   */
  readOnly: z.boolean().default(false),
  /** Queries returning more rows than this fail rather than load everything into memory. */
  maxRows: z.number().int().positive().default(1_000_000),
  statementTimeoutMs: z.number().int().positive().default(120_000),
  /** Connect through an SSH server (and jump hosts) rather than directly (M17). */
  ssh: sshConfigSchema.optional(),
})

const secretsSchema = z.object({ password: z.string().optional(), ssh: sshSecretsSchema.optional() })

const querySchema = z.object({ sql: z.string().min(1) })

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>
type Query = z.output<typeof querySchema>

interface Client {
  sql: postgres.Sql
  config: Config
  /** The SSH tunnel every connection of the pool goes through (M17), if the resource has one. */
  tunnel?: SshTunnel
}

const JSON_TYPES = new Set([114, 3802]) // json, jsonb
const CURSOR_BATCH = 1000

export const postgresConnector: Connector<Config, Secrets, Query, Client> = {
  type: 'postgres',
  label: 'PostgreSQL',
  configSchema,
  secretsSchema,
  querySchema,

  createClient({ config, secrets }) {
    const tunnel = tunnelFor(config, secrets)
    const sql = postgres({
      // Each connection (and each cancel request) is a channel through the tunnel; TLS goes over it, checked against
      // `host` as the last SSH server reaches it. (`socket` is in postgres's README, not its types.)
      ...(tunnel
        ? ({
            socket: ({ host: [h], port: [p] }: { host: string[]; port: number[] }) => tunnel.open(h!, p!),
          } as object)
        : {}),
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password: secrets.password,
      ssl: sslOption(config),
      max: config.poolSize,
      idle_timeout: 60,
      connect_timeout: 10,
      onnotice: () => {},
      connection: {
        application_name: 'optiply-workflows',
        ...(config.readOnly ? { default_transaction_read_only: true } : {}),
      },
    })
    return { sql, config, ...(tunnel ? { tunnel } : {}) }
  },

  async destroyClient({ sql, tunnel }) {
    await sql.end({ timeout: 5 })
    await tunnel?.close()
  },

  async testConnection({ sql }, { signal }) {
    const q = sql`select version() as version`
    const cancel = () => void q.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const [row] = await q
      return { message: String(row?.version ?? '').split(',')[0] }
    } catch (err) {
      throw toError(err)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  },

  validateQuery(query) {
    try {
      compileSql(query.sql)
      return []
    } catch (err) {
      if (err instanceof TemplateError) return [err]
      throw err
    }
  },

  async execute({ sql, config }, query, ctx): Promise<QueryResult> {
    const plan = await resolveFragments(compileSql(query.sql), 'postgres', ctx.evaluate)
    const timeoutMs = Math.min(ctx.timeoutMs, config.statementTimeoutMs)
    // Extended protocol always (simple: false), so a multi-statement string like `commit; delete …` is rejected
    // by Postgres instead of escaping the transaction. Unnamed statements (prepare: false), so arbitrary user SQL
    // doesn't accumulate in a per-connection statement cache.
    const opts = { simple: false, prepare: false } as const

    try {
      return await sql.begin(config.readOnly ? 'read only' : 'read write', async (tx) => {
        await tx`select set_config('statement_timeout', ${String(timeoutMs)}, true)`

        // Describe first: catches SQL errors before any {{ }} runs, gives parameter types, and tells us whether
        // the statement returns rows. (A named statement, released when the connection is recycled.)
        const statement = await tx.unsafe(plan.text, [], opts).describe()
        const values: unknown[] = []
        for (const [i, param] of plan.params.entries()) {
          values.push(toParam(await paramValue(param, ctx.evaluate), statement.types[i]))
        }

        if (statement.columns.length === 0) {
          const result = await withCancel(tx.unsafe(plan.text, values as never[], opts), ctx.signal)
          return { data: [], metadata: { command: result.command, rowCount: result.count, fields: [] } }
        }

        // Rows come back through a cursor so an oversized result fails fast instead of exhausting memory.
        const rows: Record<string, unknown>[] = []
        const q = tx.unsafe(plan.text, values as never[], opts)
        const cancel = () => void q.cancel()
        ctx.signal.addEventListener('abort', cancel, { once: true })
        try {
          ctx.signal.throwIfAborted()
          for await (const batch of q.cursor(Math.min(CURSOR_BATCH, config.maxRows + 1))) {
            for (const row of batch) rows.push({ ...row })
            if (rows.length > config.maxRows) {
              throw new ConnectorError(
                'too_large',
                `The query returned more than ${config.maxRows} rows. Add a LIMIT or raise the resource's maxRows.`,
              )
            }
          }
        } finally {
          ctx.signal.removeEventListener('abort', cancel)
        }
        return {
          data: rows,
          metadata: {
            rowCount: rows.length,
            fields: statement.columns.map((c) => ({ name: c.name, dataTypeId: c.type })),
          },
        }
      })
    } catch (err) {
      throw toError(err)
    }
  },
}

function sslOption(config: Config): postgres.Options<never>['ssl'] {
  if (config.ssl === 'disable') return false
  if (config.ssl === 'verify-full')
    return config.caCert ? { ca: config.caCert, rejectUnauthorized: true } : 'verify-full'
  return config.ssl
}

/**
 * Prepares an evaluated `{{ }}` value for binding. Arrays bind as Postgres arrays (`= any({{ ids }})`), objects to
 * json/jsonb parameters natively; an object bound anywhere else is sent as JSON text rather than "[object Object]".
 */
function toParam(value: unknown, typeOid: number | undefined): unknown {
  if (value === undefined) return null
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !JSON_TYPES.has(typeOid ?? 0)
  ) {
    return JSON.stringify(value)
  }
  return value
}

/**
 * Awaits a postgres.js query, cancelling it server-side if the signal aborts. A signal that aborted before this
 * (while the query waited for a connection, or ran its describe) never fires the listener: the query isn't run.
 */
async function withCancel<T extends PromiseLike<unknown> & { cancel(): unknown }>(
  q: T,
  signal: AbortSignal,
): Promise<Awaited<T>> {
  const cancel = () => void q.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    return await q
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Postgres errors keep their SQLSTATE and position; connection failures are told apart from query failures. */
function toError(err: unknown): unknown {
  if (err instanceof ConnectorError) return err
  const ssh = sshConnectionError(err)
  if (ssh) return ssh
  if (err instanceof postgres.PostgresError) {
    if (err.code === '57014') {
      return new ConnectorError(
        err.message.includes('statement timeout') ? 'timeout' : 'aborted',
        err.message.includes('statement timeout')
          ? 'The query hit the statement timeout'
          : 'The query was cancelled',
        { sqlState: err.code },
      )
    }
    return new ConnectorError('query', err.message, {
      sqlState: err.code,
      detail: err.detail,
      hint: err.hint,
      position: err.position,
    })
  }
  const code = (err as { code?: string }).code
  if (code && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|CONNECT_TIMEOUT|CONNECTION_)/.test(code)) {
    return new ConnectorError('connection', `Could not connect to the database: ${(err as Error).message}`, {
      code,
    })
  }
  return err
}
