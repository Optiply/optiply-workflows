// Pure (no Node imports), so the web app's settings form shows the same URL the server connects with
// (`@ow/connectors/jdbc-urls`).

export const JDBC_DRIVERS = ['oracle', 'snowflake', 'clickhouse', 'uploaded'] as const
export type JdbcDriver = (typeof JDBC_DRIVERS)[number]

/** Each built-in driver's URLs (the runner checks them too). */
export const JDBC_URL_PREFIXES: Record<Exclude<JdbcDriver, 'uploaded'>, string[]> = {
  oracle: ['jdbc:oracle:thin:'],
  snowflake: ['jdbc:snowflake:'],
  clickhouse: ['jdbc:clickhouse:', 'jdbc:ch:'],
}

/** A first URL for each driver, for the URL mode. */
export const JDBC_URL_TEMPLATES: Record<JdbcDriver, string> = {
  oracle: 'jdbc:oracle:thin:@//host:1521/service_name',
  snowflake: 'jdbc:snowflake://account.snowflakecomputing.com/?warehouse=&db=&schema=&role=',
  clickhouse: 'jdbc:clickhouse:https://host:8443/default',
  uploaded: 'jdbc:',
}

export const JDBC_DEFAULT_PORTS: Partial<Record<JdbcDriver, number>> = { oracle: 1521, clickhouse: 8443 }

/** The fields that make a URL (a resource's settings, defaults applied or not). */
export interface JdbcUrlFields {
  driver: JdbcDriver
  mode?: 'fields' | 'url' | undefined
  url?: string | undefined
  host?: string | undefined
  port?: number | undefined
  database?: string | undefined
  oracleConnect?: 'service' | 'sid' | 'tns' | undefined
  serviceName?: string | undefined
  sid?: string | undefined
  tnsAlias?: string | undefined
  account?: string | undefined
  warehouse?: string | undefined
  schema?: string | undefined
  role?: string | undefined
  https?: boolean | undefined
}

/** The account's host: `orgname-account` becomes `orgname-account.snowflakecomputing.com`; a full host stays. */
export function snowflakeHost(account: string): string {
  const a = account
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  return /\.snowflakecomputing\.(com|cn)$/i.test(a) ? a : `${a}.snowflakecomputing.com`
}

/** The JDBC URL: as written, or made from the fields. */
export function jdbcUrl(c: JdbcUrlFields): string {
  if (c.driver === 'uploaded' || c.mode === 'url') return (c.url ?? '').trim()
  const host = (c.host ?? '').trim()
  const port = c.port ?? JDBC_DEFAULT_PORTS[c.driver]
  if (c.driver === 'oracle') {
    if (c.oracleConnect === 'tns') return `jdbc:oracle:thin:@${(c.tnsAlias ?? '').trim()}`
    if (c.oracleConnect === 'sid') return `jdbc:oracle:thin:@${host}:${port}:${(c.sid ?? '').trim()}`
    return `jdbc:oracle:thin:@//${host}:${port}/${(c.serviceName ?? '').trim()}`
  }
  if (c.driver === 'snowflake') {
    const query = new URLSearchParams()
    for (const [key, value] of [
      ['warehouse', c.warehouse],
      ['db', c.database],
      ['schema', c.schema],
      ['role', c.role],
    ] as const) {
      if (value?.trim()) query.set(key, value.trim())
    }
    const q = query.toString()
    return `jdbc:snowflake://${snowflakeHost(c.account ?? '')}/${q ? `?${q}` : ''}`
  }
  const database = (c.database ?? '').trim()
  return `jdbc:clickhouse:${c.https ? 'https' : 'http'}://${host}:${c.port ?? (c.https ? 8443 : 8123)}/${encodeURIComponent(database || 'default')}`
}
