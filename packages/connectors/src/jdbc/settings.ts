import type { SqlDialect } from '@ow/expressions'
import { z } from 'zod'
import { type RestConfig, restConfigSchema } from '../rest'
import { sshConfigSchema, sshSecretsSchema } from '../ssh/settings'
import { ConnectorError } from '../types'
import { JDBC_DRIVERS, JDBC_URL_PREFIXES, type JdbcDriver, jdbcUrl, snowflakeHost } from './urls'

export {
  JDBC_DEFAULT_PORTS,
  JDBC_DRIVERS,
  JDBC_URL_PREFIXES,
  JDBC_URL_TEMPLATES,
  type JdbcDriver,
  jdbcUrl,
  snowflakeHost,
} from './urls'

// A JDBC resource's settings (M38, docs/architecture.md §2.42): which driver, how to reach it (fields or a URL), how it
// signs in; and the connection the JDBC runner gets from them.

const record = z.record(z.string(), z.string())

export const jdbcConfigSchema = z
  .object({
    driver: z.enum(JDBC_DRIVERS),
    /** An uploaded driver: its id (Settings → JDBC drivers). */
    driverId: z.string().optional(),
    /** Built-in drivers: fields that make the URL, or the URL as written. Uploaded drivers: always the URL. */
    mode: z.enum(['fields', 'url']).default('fields'),
    url: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** ClickHouse's database, Snowflake's. */
    database: z.string().optional(),
    /** Oracle: by service name, SID, or a TNS alias (from a wallet's tnsnames.ora). */
    oracleConnect: z.enum(['service', 'sid', 'tns']).default('service'),
    serviceName: z.string().optional(),
    sid: z.string().optional(),
    tnsAlias: z.string().optional(),
    /** Snowflake: the account identifier (`orgname-account` or `xy12345.eu-west-1`) and the session's defaults. */
    account: z.string().optional(),
    warehouse: z.string().optional(),
    schema: z.string().optional(),
    role: z.string().optional(),
    /** ClickHouse over HTTPS (8443) or plain HTTP (8123). */
    https: z.boolean().default(true),
    /** How it signs in: a password (every driver), a key pair or OAuth (Snowflake). */
    auth: z.enum(['password', 'keyPair', 'oauth']).default('password'),
    user: z.string().optional(),
    /** Oracle: connect with a wallet (Autonomous Database, mTLS); the wallet zip is a secret. */
    wallet: z.boolean().default(false),
    /** The driver's own connection properties; secret ones are in the secrets. */
    properties: record.default({}),
    /** Snowflake OAuth: the OAuth app (security integration) the user signs in with. */
    oauthClientId: z.string().optional(),
    /** One Snowflake account per environment, or each person signs in as themselves. */
    oauthTokens: z.enum(['shared', 'perUser']).default('perUser'),
    /**
     * Read-only: a transaction that's always rolled back (Oracle, Snowflake, most drivers), or the server's own
     * `readonly` setting (ClickHouse). A guard against mistakes: for security, sign in as a user that can only read.
     */
    readOnly: z.boolean().default(false),
    maxRows: z.number().int().positive().default(1_000_000),
    statementTimeoutMs: z.number().int().positive().default(120_000),
    poolSize: z.number().int().min(1).max(50).default(5),
    /** Through an SSH server (M17), to these `host:port`s, which the URL uses as written (step 4). */
    ssh: sshConfigSchema.optional(),
    tunnelHosts: z.array(z.string()).default([]),
  })
  .superRefine((c, ctx) => {
    const need = (field: keyof typeof c, what: string) => {
      const v = c[field]
      if (typeof v !== 'string' || !v.trim())
        ctx.addIssue({ code: 'custom', path: [field], message: `${what} is required` })
    }
    if (c.driver === 'uploaded') need('driverId', 'The driver')
    if (c.driver === 'uploaded' || c.mode === 'url') {
      need('url', 'The JDBC URL')
      const url = c.url?.trim() ?? ''
      const prefixes = c.driver === 'uploaded' ? ['jdbc:'] : JDBC_URL_PREFIXES[c.driver]
      if (url && !prefixes.some((p) => url.startsWith(p))) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: `The URL starts with ${prefixes.join(' or ')}`,
        })
      }
    } else if (c.driver === 'oracle') {
      if (c.oracleConnect !== 'tns') need('host', 'The host')
      if (c.oracleConnect === 'service') need('serviceName', 'The service name')
      if (c.oracleConnect === 'sid') need('sid', 'The SID')
      if (c.oracleConnect === 'tns') need('tnsAlias', 'The TNS alias')
    } else if (c.driver === 'snowflake') {
      need('account', 'The account identifier')
    } else {
      need('host', 'The host')
    }
    if (c.driver !== 'snowflake' && c.auth !== 'password') {
      ctx.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'Only Snowflake signs in with a key pair or OAuth',
      })
    }
    if (c.auth !== 'oauth') need('user', 'The user')
    if (c.auth === 'oauth') need('oauthClientId', "The OAuth app's client id")
    if (c.wallet && c.driver !== 'oracle') {
      ctx.addIssue({ code: 'custom', path: ['wallet'], message: 'Only Oracle connects with a wallet' })
    }
    if (c.ssh) {
      // The runner reaches these through the tunnel: as the URL writes them, so TLS still checks the real names.
      if (!c.tunnelHosts.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['tunnelHosts'],
          message: 'List the host:port the database is at',
        })
      }
      const url = jdbcUrl(c).toLowerCase()
      for (const [i, hostPort] of c.tunnelHosts.entries()) {
        const m = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(hostPort.trim())
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
          ctx.addIssue({ code: 'custom', path: ['tunnelHosts', i], message: `"${hostPort}" isn't host:port` })
        } else if (!url.includes(m[1]!.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['tunnelHosts', i],
            message: `The URL doesn't use ${m[1]}: write it there as it is here`,
          })
        }
      }
    }
    if (c.oracleConnect === 'tns' && c.driver === 'oracle' && c.mode === 'fields' && !c.wallet) {
      ctx.addIssue({
        code: 'custom',
        path: ['tnsAlias'],
        message: 'A TNS alias comes from a wallet: add one',
      })
    }
  })

export const jdbcSecretsSchema = z.object({
  password: z.string().optional(),
  /** Snowflake key pair: the private key (PEM, PKCS#8) and its passphrase if it's encrypted. */
  privateKey: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  /** Oracle: the wallet zip, base64, and the password of an `ewallet.p12` in it (auto-login wallets need none). */
  wallet: z.string().optional(),
  walletPassword: z.string().optional(),
  /** Snowflake OAuth: the OAuth app's client secret. */
  clientSecret: z.string().optional(),
  /** Secret connection properties. */
  properties: record.optional(),
  ssh: sshSecretsSchema.optional(),
})

export type JdbcConfig = z.output<typeof jdbcConfigSchema>
export type JdbcSecrets = z.output<typeof jdbcSecretsSchema>

/**
 * What the app's OAuth sign-in (M9) connects with: Snowflake's own OAuth (a `CUSTOM` security integration), its role
 * as the scope. Nothing for other sign-ins.
 */
export function jdbcHttpConfig(c: JdbcConfig): RestConfig {
  const oauth = c.driver === 'snowflake' && c.auth === 'oauth' && c.oauthClientId?.trim() && c.account?.trim()
  const origin = oauth ? `https://${snowflakeHost(c.account!)}` : 'https://jdbc.invalid'
  const role = c.role?.trim()
  return restConfigSchema.parse({
    baseUrl: `${origin}/`,
    allowedHosts: [],
    auth: oauth
      ? {
          type: 'oauth2AuthorizationCode',
          authorizeUrl: `${origin}/oauth/authorize`,
          tokenUrl: `${origin}/oauth/token-request`,
          revokeUrl: `${origin}/oauth/revoke`,
          clientId: c.oauthClientId!.trim(),
          // A refresh token keeps the sign-in; the role is the one the session takes.
          scope: role ? `refresh_token session:role:${role}` : 'refresh_token',
          clientAuth: 'basic',
          pkce: true,
          tokens: c.oauthTokens,
        }
      : { type: 'none' },
  })
}

/** How the SQL is read for each driver: `?` placeholders all, each database's strings and functions. */
export function jdbcDialect(driver: JdbcDriver): SqlDialect {
  return driver === 'uploaded' ? 'jdbc' : driver
}

/** What the runner connects with, but the driver jar and the token (added per query). */
export interface JdbcConnection {
  poolKey: string
  driver: JdbcDriver
  driverSha?: string
  driverClass?: string
  url: string
  properties: Record<string, string>
  tokenProperty?: string
  token?: string
  wallet?: { zip: string; password?: string }
  readOnly: boolean
  poolSize: number
  tunnel?: { forwarder: string; tunnelId: string; secret: string; hosts: string[]; route: string }
}

/**
 * The connection for the runner: the URL, then the properties (the resource's plain ones, its secret ones, then the
 * sign-in's, which win). A missing secret is a settings error that says which.
 */
export function jdbcConnection(c: JdbcConfig, s: JdbcSecrets, poolKey: string): JdbcConnection {
  const missing = (field: string, what: string): never => {
    throw new ConnectorError('invalid_config', `${what} is missing: add it in the resource's settings`, {
      field,
    })
  }
  const properties: Record<string, string> = { ...c.properties, ...(s.properties ?? {}) }
  const user = c.user?.trim()
  if (user) properties.user = user
  let tokenProperty: string | undefined
  if (c.auth === 'password') {
    if (s.password) properties.password = s.password
  } else if (c.auth === 'keyPair') {
    if (!s.privateKey?.trim()) missing('privateKey', 'The private key')
    // Snowflake reads the key file's content from this property (and decrypts it with the passphrase).
    properties.private_key_base64 = Buffer.from(s.privateKey!.trim()).toString('base64')
    if (s.privateKeyPassphrase) properties.private_key_pwd = s.privateKeyPassphrase
    properties.authenticator = 'snowflake_jwt'
  } else {
    properties.authenticator = 'oauth'
    tokenProperty = 'token'
  }
  let wallet: JdbcConnection['wallet']
  if (c.wallet) {
    if (!s.wallet) missing('wallet', 'The wallet')
    wallet = { zip: s.wallet!, ...(s.walletPassword ? { password: s.walletPassword } : {}) }
  }
  return {
    poolKey,
    driver: c.driver,
    url: jdbcUrl(c),
    properties,
    ...(tokenProperty ? { tokenProperty } : {}),
    ...(wallet ? { wallet } : {}),
    readOnly: c.readOnly,
    poolSize: c.poolSize,
  }
}
