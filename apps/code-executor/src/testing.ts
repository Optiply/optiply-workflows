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
  return sourcesImage('ow-code-executor')
}

/** The package builder's image (the Dockerfile's `builder` target, M23), tagged like the executor's. */
export function builderImage(): string {
  return sourcesImage('ow-python-builder', 'builder')
}

function sourcesImage(repository: string, target?: string): string {
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
  const image = `${repository}:test-${hash.digest('hex').slice(0, 16)}`
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
  } catch {
    const targetArgs = target ? ['--target', target] : []
    execFileSync(
      'docker',
      ['build', '-q', '-f', join(ROOT, 'Dockerfile'), ...targetArgs, '-t', image, ROOT],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 900_000,
      },
    )
    // Earlier sources' images (433 MB each) would pile up; one still running a container stays.
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
export async function startTestExecutor(
  opts: {
    env?: Record<string, string>
    /** A Docker volume holding the builder's envs (M23), mounted read-only at /envs: start the builder first. */
    envsVolume?: string
  } = {},
): Promise<TestExecutor> {
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
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      ...EXECUTOR_DOCKER_FLAGS,
      ...env,
      ...(opts.envsVolume ? ['-v', `${opts.envsVolume}:/envs:ro`] : []),
      '-p',
      '127.0.0.1::8080',
      image,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  return { ...(await waitForHealth(name)), token, container: name }
}

/** The SDK runner's image (the Dockerfile's `sdk-runner` target, M37), tagged like the executor's. */
export function sdkRunnerImage(): string {
  return sourcesImage('ow-sdk-runner', 'sdk-runner')
}

export interface TestSdkRunner {
  url: string
  token: string
  container: string | null
  stop(): Promise<void>
}

/**
 * An SDK runner for tests (M37): `SDK_RUNNER_TEST_URL` and `SDK_RUNNER_TEST_TOKEN`, or a throwaway container of this
 * checkout's `sdk-runner` target on a random local port. It reaches the host as `host.docker.internal` (a test's
 * fake API: allow private networks for it); `envsVolume` mounts installed envs read-only at /envs.
 */
export async function startTestSdkRunner(
  opts: { env?: Record<string, string>; envsVolume?: string } = {},
): Promise<TestSdkRunner> {
  if (process.env.SDK_RUNNER_TEST_URL) {
    return {
      url: process.env.SDK_RUNNER_TEST_URL.replace(/\/$/, ''),
      token: process.env.SDK_RUNNER_TEST_TOKEN ?? '',
      container: null,
      stop: async () => {},
    }
  }
  const image = sdkRunnerImage()
  const token = randomBytes(24).toString('hex')
  const name = `ow-sdk-runner-test-${randomBytes(4).toString('hex')}`
  const env = Object.entries({ SDK_RUNNER_TOKEN: token, ...opts.env }).flatMap(([k, v]) => [
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
      ...EXECUTOR_DOCKER_FLAGS,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...env,
      ...(opts.envsVolume ? ['-v', `${opts.envsVolume}:/envs:ro`] : []),
      '-p',
      '127.0.0.1::8080',
      image,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  return { ...(await waitForHealth(name)), token, container: name }
}

export { buildSdist, buildWheel, startTestIndex, type TestIndex, type TestPackage } from './test-index'
export {
  startTestRegistry,
  type TestPackage as TestNpmPackage,
  type TestRegistry,
} from './test-npm-registry'

export interface TestBuilder {
  url: string
  token: string
  container: string
  stop(): Promise<void>
}

/**
 * A package builder for tests (M23): a throwaway container of this checkout's `builder` target on a random local
 * port, installing from `indexUrl` (a `startTestIndex`'s `url`: the container reaches the host through
 * `host.docker.internal`). Its envs stay in the container (`docker exec` to look); `env` adds settings.
 */
export async function startTestBuilder(opts: {
  indexUrl: string
  env?: Record<string, string>
  /** A Docker volume for its envs (shared with an executor); a new one takes the image's /envs and its owner. */
  envsVolume?: string
}): Promise<TestBuilder> {
  const image = builderImage()
  const token = randomBytes(24).toString('hex')
  const name = `ow-python-builder-test-${randomBytes(4).toString('hex')}`
  const env = Object.entries({
    PYTHON_BUILDER_TOKEN: token,
    PYTHON_PACKAGE_INDEX_URL: opts.indexUrl,
    // The tests' indexes are http (M32's named indexes refuse it otherwise).
    PYTHON_ALLOW_INSECURE_INDEXES: '1',
    ...opts.env,
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      // nsjail for sdist builds (M32), as the executor's.
      ...EXECUTOR_DOCKER_FLAGS,
      // Docker Desktop knows host.docker.internal; Linux (CI) needs it named.
      '--add-host',
      'host.docker.internal:host-gateway',
      ...env,
      ...(opts.envsVolume ? ['-v', `${opts.envsVolume}:/envs`] : []),
      '-p',
      '127.0.0.1::8080',
      image,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  return { ...(await waitForHealth(name)), token, container: name }
}

/** A Docker volume for envs shared by a test builder and executor; `remove()` once both have stopped. */
export function testEnvsVolume(): { name: string; remove(): void } {
  const name = `ow-python-envs-test-${randomBytes(4).toString('hex')}`
  execFileSync('docker', ['volume', 'create', name], { stdio: 'ignore' })
  return {
    name,
    remove: () => {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', name], { stdio: 'ignore' })
      } catch {}
    },
  }
}

/** The container's published port, once its `/health` answers; the container is removed if it never does. */
async function waitForHealth(name: string): Promise<{ url: string; stop: () => Promise<void> }> {
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
        throw new Error(`${name} didn't start:\n${logs}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { url, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
