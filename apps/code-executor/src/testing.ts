import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TestExecutor {
  /** The executor's base URL, e.g. `http://127.0.0.1:53017`. */
  url: string
  token: string
  /** The container's name (for `docker exec`/`docker logs` in tests); null with `PYTHON_EXECUTOR_TEST_URL`. */
  container: string | null
  stop(): Promise<void>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** The seccomp profile the container runs with: Docker's default plus `pivot_root` for nsjail. */
export const SECCOMP_PROFILE = join(ROOT, 'seccomp.json')

/**
 * Whether the executor tests can run here: `PYTHON_EXECUTOR_TEST_URL` is set, or Docker is available. CI must run
 * them.
 */
export function executorAvailable(): boolean {
  if (process.env.PYTHON_EXECUTOR_TEST_URL) return true
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI)
      throw new Error('The Python executor tests need Docker (or PYTHON_EXECUTOR_TEST_URL) in CI')
    return false
  }
}

/** The image for this checkout's executor sources, tagged by their hash (built once, reused while unchanged). */
export function executorImage(): string {
  const hash = createHash('sha256')
  const files = [
    'Dockerfile',
    'seccomp.json',
    ...readdirSync(join(ROOT, 'executor'))
      .filter((f) => !f.startsWith('.') && f !== '__pycache__')
      .sort()
      .map((f) => `executor/${f}`),
  ]
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(ROOT, file)))
      .update('\0')
  const image = `ow-code-executor:test-${hash.digest('hex').slice(0, 16)}`
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
  } catch {
    execFileSync('docker', ['build', '-q', '-f', join(ROOT, 'Dockerfile'), '-t', image, ROOT], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 900_000,
    })
    // Earlier sources' images (433 MB each) would pile up; one still running a container stays.
    const old = execFileSync('docker', [
      'image',
      'ls',
      'ow-code-executor',
      '--format',
      '{{.Repository}}:{{.Tag}}',
    ])
      .toString()
      .split('\n')
      .filter((tag) => tag.startsWith('ow-code-executor:test-') && tag !== image)
    for (const tag of old) {
      try {
        execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' })
      } catch {}
    }
  }
  return image
}

/** The flags the executor's container needs: SYS_ADMIN for nsjail's namespaces, and its seccomp profile. */
export const EXECUTOR_DOCKER_FLAGS = [
  '--cap-add',
  'SYS_ADMIN',
  '--security-opt',
  `seccomp=${SECCOMP_PROFILE}`,
  // Docker's AppArmor profile (on Linux hosts) refuses the mounts nsjail makes; the jail has its own policy.
  '--security-opt',
  'apparmor=unconfined',
]

/**
 * A code executor for tests: `PYTHON_EXECUTOR_TEST_URL` and `PYTHON_EXECUTOR_TEST_TOKEN`, or a throwaway container
 * of this checkout's image on a random local port, removed by `stop()`. `env` adds settings (e.g.
 * `PYTHON_MAX_CONCURRENT`).
 */
export async function startTestExecutor(opts: { env?: Record<string, string> } = {}): Promise<TestExecutor> {
  if (process.env.PYTHON_EXECUTOR_TEST_URL) {
    return {
      url: process.env.PYTHON_EXECUTOR_TEST_URL.replace(/\/$/, ''),
      token: process.env.PYTHON_EXECUTOR_TEST_TOKEN ?? '',
      container: null,
      stop: async () => {},
    }
  }
  const image = executorImage()
  const token = randomBytes(24).toString('hex')
  const name = `ow-code-executor-test-${randomBytes(4).toString('hex')}`
  const env = Object.entries({ PYTHON_EXECUTOR_TOKEN: token, ...opts.env }).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ])
  execFileSync(
    'docker',
    ['run', '-d', '--rm', '--name', name, ...EXECUTOR_DOCKER_FLAGS, ...env, '-p', '127.0.0.1::8080', image],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const stop = async () => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    } catch {}
  }
  try {
    const port = Number(
      execFileSync('docker', ['port', name, '8080/tcp']).toString().trim().split('\n')[0]!.split(':').pop(),
    )
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        if ((await fetch(`${url}/health`)).ok) break
      } catch {}
      if (Date.now() > deadline) {
        const logs = execFileSync('docker', ['logs', name]).toString()
        throw new Error(`The executor didn't start:\n${logs}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { url, token, container: name, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
