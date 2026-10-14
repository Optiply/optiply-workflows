import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'

export interface TestMysql {
  host: string
  port: number
  database: string
  /** An ordinary user with every privilege on `database` (what a resource connects as). */
  user: string
  password: string
  /** root, for setting up tables and looking at the server from outside. */
  rootPassword: string
  stop(): Promise<void>
}

const IMAGE = 'mysql:8.4'

/** Whether MySQL tests can run here: `MYSQL_TEST_URL` is set, or Docker is available. CI must run them. */
export function mysqlAvailable(): boolean {
  if (process.env.MYSQL_TEST_URL) return true
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('MySQL tests need Docker (or MYSQL_TEST_URL) in CI')
    return false
  }
}

/**
 * A MySQL server for tests: `MYSQL_TEST_URL` (`mysql://root:<password>@host:port/db`, whose root creates the test
 * user) or a throwaway `mysql:8.4` container on a random local port, removed by `stop()`.
 */
export async function startTestMysql(): Promise<TestMysql> {
  const database = 'ow_test'
  const user = 'ow'
  const password = randomBytes(12).toString('hex')

  if (process.env.MYSQL_TEST_URL) {
    const url = new URL(process.env.MYSQL_TEST_URL)
    const server = {
      host: url.hostname,
      port: Number(url.port || 3306),
      rootPassword: decodeURIComponent(url.password),
    }
    const root = await mysql.createConnection({ ...server, user: 'root', password: server.rootPassword })
    await root.query(`DROP DATABASE IF EXISTS ${database}`)
    await root.query(`CREATE DATABASE ${database}`)
    await root.query(`DROP USER IF EXISTS '${user}'@'%'`)
    await root.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`)
    await root.query(`GRANT ALL ON ${database}.* TO '${user}'@'%'`)
    await root.end()
    return { ...server, database, user, password, stop: async () => {} }
  }

  const rootPassword = randomBytes(12).toString('hex')
  const id = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-p',
      '127.0.0.1::3306',
      '-e',
      `MYSQL_ROOT_PASSWORD=${rootPassword}`,
      '-e',
      `MYSQL_DATABASE=${database}`,
      '-e',
      `MYSQL_USER=${user}`,
      '-e',
      `MYSQL_PASSWORD=${password}`,
      IMAGE,
    ],
    { encoding: 'utf8' },
  ).trim()
  const stop = async () => {
    execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
  }
  try {
    const mapping = execFileSync('docker', ['port', id, '3306/tcp'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0]!
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1))
    // The image's entrypoint initialises the data directory with networking off, then restarts the server: the
    // first TCP login that works means it's ready.
    const deadline = Date.now() + 180_000
    for (;;) {
      try {
        const conn = await mysql.createConnection({ host: '127.0.0.1', port, user, password, database })
        await conn.end()
        break
      } catch (err) {
        if (Date.now() > deadline) throw err
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    return { host: '127.0.0.1', port, database, user, password, rootPassword, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
