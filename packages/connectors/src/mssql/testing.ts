import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Connection, Request } from 'tedious'

export interface TestMssql {
  host: string
  port: number
  database: string
  /** A SQL login that owns `database` (what a resource connects as). */
  user: string
  password: string
  /** Runs statements as `sa`, in `database`: for setting up tables and looking at the server from outside. */
  admin(sql: string): Promise<Record<string, unknown>[]>
  stop(): Promise<void>
}

const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest'

/**
 * Whether SQL Server tests run here: `MSSQL_TEST_URL` is set, or Docker is available. CI must run them. The image is
 * amd64 only: on Apple silicon it runs emulated, and next to the other test containers in a small Docker VM it starves
 * them (MySQL then fails to start), so there they run only when asked: `MSSQL_TESTS=1`.
 */
export function mssqlAvailable(): boolean {
  if (process.env.MSSQL_TEST_URL) return true
  if (!process.env.CI && process.arch !== 'x64' && process.env.MSSQL_TESTS !== '1') return false
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('SQL Server tests need Docker (or MSSQL_TEST_URL) in CI')
    return false
  }
}

/**
 * A SQL Server for tests: `MSSQL_TEST_URL` (`mssql://sa:<password>@host:port`) or a throwaway SQL Server 2022 container
 * on a random local port, removed by `stop()`. Either way a fresh database and a login that owns it.
 */
export async function startTestMssql(): Promise<TestMssql> {
  const database = `ow_test_${randomBytes(3).toString('hex')}`
  const user = 'ow'
  // SQL Server's password policy wants upper, lower, digits and symbols.
  const password = `Ow-${randomBytes(9).toString('hex')}-X1`
  let host = '127.0.0.1'
  let port: number
  let saPassword: string
  let stop = async () => {}

  if (process.env.MSSQL_TEST_URL) {
    const url = new URL(process.env.MSSQL_TEST_URL)
    host = url.hostname
    port = Number(url.port || 1433)
    saPassword = decodeURIComponent(url.password)
  } else {
    saPassword = `Sa-${randomBytes(9).toString('hex')}-X1`
    const id = execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--platform',
        'linux/amd64',
        '-p',
        '127.0.0.1::1433',
        '-e',
        'ACCEPT_EULA=Y',
        '-e',
        `MSSQL_SA_PASSWORD=${saPassword}`,
        '-e',
        'MSSQL_PID=Developer',
        // Docker Desktop's VM is often small (4 GB here): keep the buffer pool from taking it all.
        '-e',
        'MSSQL_MEMORY_LIMIT_MB=1536',
        IMAGE,
      ],
      { encoding: 'utf8' },
    ).trim()
    stop = async () => {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
    }
    const mapping = execFileSync('docker', ['port', id, '1433/tcp'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0]!
    port = Number(mapping.slice(mapping.lastIndexOf(':') + 1))
  }

  const run = (db: string, sql: string) =>
    runAs({ host, port, user: 'sa', password: saPassword, database: db }, sql)
  try {
    // The server takes a while to start (longer emulated): the first login that works means it's ready.
    const deadline = Date.now() + 240_000
    for (;;) {
      try {
        await run('master', 'SELECT 1')
        break
      } catch (err) {
        if (Date.now() > deadline) throw err
        await new Promise((r) => setTimeout(r, 1_000))
      }
    }
    await run('master', `CREATE DATABASE [${database}]`)
    await run(
      'master',
      `IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = '${user}') CREATE LOGIN [${user}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF
       ELSE ALTER LOGIN [${user}] WITH PASSWORD = '${password}'`,
    )
    await run(database, `CREATE USER [${user}] FOR LOGIN [${user}]; ALTER ROLE db_owner ADD MEMBER [${user}]`)
  } catch (err) {
    await stop()
    throw err
  }
  return {
    host,
    port,
    database,
    user,
    password,
    admin: (sql) => run(database, sql),
    stop: async () => {
      if (process.env.MSSQL_TEST_URL) {
        await run(
          'master',
          `ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]`,
        )
      }
      await stop()
    },
  }
}

/** One batch on a fresh connection, its last result set's rows. */
function runAs(
  at: { host: string; port: number; user: string; password: string; database: string },
  sql: string,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server: at.host,
      authentication: { type: 'default', options: { userName: at.user, password: at.password } },
      options: {
        port: at.port,
        database: at.database,
        encrypt: false,
        requestTimeout: 0,
        connectTimeout: 5_000,
      },
    })
    conn.on('error', () => {})
    conn.connect((err) => {
      if (err) {
        conn.close()
        return reject(err)
      }
      let names: string[] = []
      let rows: Record<string, unknown>[] = []
      const req = new Request(sql, (e) => {
        conn.close()
        if (e) reject(e)
        else resolve(rows)
      })
      req.on('columnMetadata', (meta) => {
        names = (meta as unknown as { colName: string }[]).map((c) => c.colName)
        rows = []
      })
      req.on('row', (cells: { value: unknown }[]) => {
        rows.push(Object.fromEntries(cells.map((c, i) => [names[i]!, c.value])))
      })
      conn.execSqlBatch(req)
    })
  })
}
