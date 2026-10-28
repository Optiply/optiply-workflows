import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '@ow/db'
import { fakeGitHub } from '../../server/test/fake-github'
import { E2E_EMAIL, E2E_GITHUB_TOKEN, E2E_PASSWORD, run, waitForHealth } from './global-setup'

const serverDir = fileURLToPath(new URL('../../server', import.meta.url))
const webDist = fileURLToPath(new URL('../dist', import.meta.url))

export interface Instance {
  /** Where it serves, for a browser context's baseURL. */
  base: string
}

/**
 * Instances of their own for a spec that needs several on one repo (M22's done-when): a new bare repo
 * (optiply/flows, with main holding only ow.json) and a fake GitHub for it, then one bundled server per port, each
 * with its own database in the e2e Postgres and the same admin (E2E_EMAIL). Apart from the shared instance and its
 * repo, so the other specs' objects never reach them. `stop` ends them and removes their databases.
 */
export async function startInstances(ports: number[]) {
  const root = mkdtempSync(join(tmpdir(), 'ow-e2e-instances-'))
  mkdirSync(join(root, 'optiply'))
  const repoDir = join(root, 'optiply', 'flows.git')
  const gitEnv = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', repoDir], { env: gitEnv })
  const github = await fakeGitHub({
    repoPath: repoDir,
    owner: 'optiply',
    repo: 'flows',
    token: E2E_GITHUB_TOKEN,
  })

  const admin = createDb(process.env.E2E_PG_URL!, { max: 1 })
  const servers: ChildProcess[] = []
  const databases: string[] = []
  const instances: Instance[] = []
  try {
    for (const port of ports) {
      const database = `ow_instance_${port}`
      await admin.sql.unsafe(`drop database if exists ${database} with (force)`)
      await admin.sql.unsafe(`create database ${database}`)
      databases.push(database)
      const url = new URL(process.env.E2E_PG_URL!)
      url.pathname = `/${database}`
      const base = `http://127.0.0.1:${port}`
      const env = {
        PATH: process.env.PATH ?? '',
        TZ: 'UTC',
        ROLE: 'all',
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_URL: base,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: randomBytes(32).toString('base64url'),
        ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
        LOCAL_LOGIN_ENABLED: 'true',
        AUTO_MIGRATE: 'true',
        MIGRATIONS_DIR: `${serverDir}/../../packages/db/migrations`,
        WEB_DIST_DIR: webDist,
        GIT_ALLOW_INSECURE_URLS: 'true',
        GIT_CACHE_DIR: join(root, `cache-${port}`),
        GITHUB_API_URL: github.url,
        GIT_POLL_SECONDS: '2',
        HOME: root,
      }
      // The server migrates its new database; the admin comes after.
      const server = spawn('node', ['--no-node-snapshot', 'dist/main.js'], {
        cwd: serverDir,
        env,
        stdio: 'inherit',
      })
      servers.push(server)
      await waitForHealth(`${base}/api/health`, server)
      await run(['dist/cli/create-admin.js', '--email', E2E_EMAIL, '--name', `Admin ${port}`], {
        ...env,
        ADMIN_PASSWORD: E2E_PASSWORD,
      })
      instances.push({ base })
    }
  } catch (e) {
    await stop()
    throw e
  }

  async function stop() {
    await Promise.all(
      servers.map(async (server) => {
        if (server.exitCode !== null) return
        server.kill('SIGTERM')
        await new Promise((resolve) => server.once('exit', resolve))
      }),
    )
    for (const database of databases)
      await admin.sql.unsafe(`drop database if exists ${database} with (force)`)
    await admin.close()
    await github.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  return { instances, repoUrl: `file://${repoDir}`, repoDir, github: github.url, stop }
}
