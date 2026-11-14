import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Test helpers for the JDBC runner (M38): its image built from this checkout, and real databases next to it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Whether the runner's tests can run here: `JDBC_RUNNER_TEST_URL` is set, or Docker is available. CI must run them. */
export function jdbcRunnerAvailable(): boolean {
  if (process.env.JDBC_RUNNER_TEST_URL) return true
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('The JDBC runner tests need Docker (or JDBC_RUNNER_TEST_URL) in CI')
    return false
  }
}

function files(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .flatMap((f) => {
      const path = join(dir, f)
      return statSync(path).isDirectory() ? files(path) : [path]
    })
}

/** The image for this checkout's runner sources, tagged by their hash (built once, reused while unchanged). */
export function jdbcRunnerImage(): string {
  const hash = createHash('sha256')
  for (const file of [join(ROOT, 'Dockerfile'), join(ROOT, 'pom.xml'), ...files(join(ROOT, 'src/main'))]) {
    hash.update(relative(ROOT, file)).update('\0').update(readFileSync(file)).update('\0')
  }
  const repository = 'ow-jdbc-runner'
  const image = `${repository}:test-${hash.digest('hex').slice(0, 16)}`
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
  } catch {
    execFileSync('docker', ['build', '-q', '-t', image, ROOT], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 900_000,
    })
    // Earlier sources' images (~660 MB each) would pile up; one still running a container stays.
    const old = execFileSync('docker', ['image', 'ls', repository, '--format', '{{.Repository}}:{{.Tag}}'])
      .toString()
      .split('\n')
      .filter((tag) => tag.startsWith(`${repository}:test-`) && tag !== image)
    for (const tag of old) {
      try {
        execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' })
      } catch {}
    }
  }
  return image
}

/** A Docker network for a test's containers, so the runner reaches a database by its container name. */
export function testNetwork(): { name: string; remove(): void } {
  const name = `ow-jdbc-test-${randomBytes(4).toString('hex')}`
  execFileSync('docker', ['network', 'create', name], { stdio: 'ignore' })
  return {
    name,
    remove: () => {
      try {
        execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' })
      } catch {}
    },
  }
}

export interface TestJdbcRunner {
  /** The runner's base URL from this machine, e.g. `http://127.0.0.1:53017`. */
  url: string
  token: string
  container: string | null
  stop(): Promise<void>
}

/**
 * A JDBC runner for tests: `JDBC_RUNNER_TEST_URL` and `JDBC_RUNNER_TEST_TOKEN`, or a throwaway container of this
 * checkout's image on a random local port, read-only with a tmpfs as in Compose, on `network` if given.
 */
export async function startTestJdbcRunner(
  opts: { network?: string; env?: Record<string, string> } = {},
): Promise<TestJdbcRunner> {
  if (process.env.JDBC_RUNNER_TEST_URL) {
    return {
      url: process.env.JDBC_RUNNER_TEST_URL.replace(/\/$/, ''),
      token: process.env.JDBC_RUNNER_TEST_TOKEN ?? '',
      container: null,
      stop: async () => {},
    }
  }
  const image = jdbcRunnerImage()
  const token = randomBytes(24).toString('hex')
  const name = `ow-jdbc-runner-test-${randomBytes(4).toString('hex')}`
  const env = Object.entries({ JDBC_RUNNER_TOKEN: token, ...opts.env }).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ])
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      '/tmp',
      // As Compose's volume: uploaded drivers are written here (the runner's user owns it).
      '--tmpfs',
      '/drivers:uid=10001',
      '--add-host',
      'host.docker.internal:host-gateway',
      ...(opts.network ? ['--network', opts.network] : []),
      ...env,
      '-p',
      '127.0.0.1::8080',
      image,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const url = await waitFor(name, 8080, async (u) => (await fetch(`${u}/health`)).ok)
  return { url, token, container: name, stop: async () => remove(name) }
}

export interface TestClickHouse {
  /** As the runner reaches it on the test network. */
  host: string
  port: number
  /** From this machine. */
  localUrl: string
  user: string
  password: string
  database: string
  stop(): Promise<void>
}

const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:26.8-alpine'

/** A ClickHouse server for tests, on `network` (as `host`), its HTTP port published for this machine too. */
export async function startTestClickHouse(network: string): Promise<TestClickHouse> {
  const name = `ow-test-clickhouse-${randomBytes(4).toString('hex')}`
  const user = 'ow'
  const password = randomBytes(12).toString('hex')
  const database = 'ow_test'
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      network,
      '--ulimit',
      'nofile=262144:262144',
      '-e',
      `CLICKHOUSE_USER=${user}`,
      '-e',
      `CLICKHOUSE_PASSWORD=${password}`,
      '-e',
      `CLICKHOUSE_DB=${database}`,
      '-e',
      'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
      '-p',
      '127.0.0.1::8123',
      CLICKHOUSE_IMAGE,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  const localUrl = await waitFor(
    name,
    8123,
    async (u) => (await fetch(`${u}/?query=SELECT%201`, { headers: { Authorization: auth } })).ok,
    120_000,
  )
  return { host: name, port: 8123, localUrl, user, password, database, stop: async () => remove(name) }
}

/** Runs SQL on a test ClickHouse from this machine (its HTTP interface), for setting up and checking tables. */
export async function clickhouse(ch: TestClickHouse, sql: string): Promise<string> {
  const res = await fetch(`${ch.localUrl}/?database=${ch.database}`, {
    method: 'POST',
    body: sql,
    headers: { Authorization: `Basic ${Buffer.from(`${ch.user}:${ch.password}`).toString('base64')}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ClickHouse: ${text}`)
  return text
}

async function waitFor(
  name: string,
  port: number,
  ready: (url: string) => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<string> {
  try {
    const mapping = execFileSync('docker', ['port', name, `${port}/tcp`])
      .toString()
      .trim()
      .split('\n')[0]!
    const url = `http://127.0.0.1:${mapping.slice(mapping.lastIndexOf(':') + 1)}`
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        if (await ready(url)) return url
      } catch {}
      if (Date.now() > deadline) {
        const logs = execFileSync('docker', ['logs', name]).toString().slice(-4000)
        throw new Error(`${name} didn't start:\n${logs}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } catch (err) {
    remove(name)
    throw err
  }
}

function remove(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  } catch {}
}
