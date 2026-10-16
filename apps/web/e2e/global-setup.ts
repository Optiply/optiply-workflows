import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { fakeGitHub } from '../../server/test/fake-github'
import { E2E_PORT } from '../playwright.config'

const serverDir = fileURLToPath(new URL('../../server', import.meta.url))
const webDist = fileURLToPath(new URL('../dist', import.meta.url))

export const E2E_EMAIL = 'e2e@optiply.nl'
export const E2E_PASSWORD = 'e2e-password-not-secret'
/** A second person, for what differs between people (their own OAuth accounts). Same password. */
export const E2E_SECOND_EMAIL = 'e2e-second@optiply.nl'
/** Someone who isn't an admin: they reach only what's shared with them (M10's done-when). Same password. */
export const E2E_MEMBER_EMAIL = 'e2e-member@optiply.nl'
/** The token the fake GitHub takes (M11). */
export const E2E_GITHUB_TOKEN = 'github_pat_e2e_not_secret'

/**
 * Starts what the editor needs, as in production: an embedded Postgres, the bundled server (API and worker in one
 * process) serving the built web app, an admin, and a Postgres resource pointing at a seeded `customers` table.
 * Build first: `pnpm --filter @ow/web build && pnpm --filter @ow/server build`.
 */
export default async function globalSetup() {
  for (const path of [`${serverDir}/dist/main.js`, `${webDist}/index.html`]) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing: run pnpm --filter @ow/web build && pnpm --filter @ow/server build`)
    }
  }

  const pg = await startTestDatabase()
  const seed = createDb(pg.url, { max: 1 })
  await seed.sql.unsafe(`
    create table customers (id int primary key, email text not null, plan text not null);
    insert into customers values (1, 'ada@example.com', 'pro'), (2, 'grace@example.com', 'free');
  `)
  await seed.close()

  // Git sync (M11): an empty bare repo (optiply/flows) and a fake GitHub for its pull requests. Specs read where
  // they are from E2E_GIT_REPO_URL and E2E_FAKE_GITHUB, and merge pull requests through the fake's /_test routes.
  const gitRoot = mkdtempSync(join(tmpdir(), 'ow-e2e-git-'))
  mkdirSync(join(gitRoot, 'optiply'))
  const repoPath = join(gitRoot, 'optiply', 'flows.git')
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', repoPath], {
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const github = await fakeGitHub({ repoPath, owner: 'optiply', repo: 'flows', token: E2E_GITHUB_TOKEN })
  process.env.E2E_GIT_REPO_URL = `file://${repoPath}`
  process.env.E2E_FAKE_GITHUB = github.url

  const base = `http://127.0.0.1:${E2E_PORT}`
  const env = {
    ...process.env,
    TZ: 'UTC',
    ROLE: 'all',
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    HOST: '127.0.0.1',
    PORT: String(E2E_PORT),
    PUBLIC_URL: base,
    DATABASE_URL: pg.url,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    LOCAL_LOGIN_ENABLED: 'true',
    AUTO_MIGRATE: 'true',
    MIGRATIONS_DIR: `${serverDir}/../../packages/db/migrations`,
    WEB_DIST_DIR: webDist,
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(gitRoot, 'cache'),
    GITHUB_API_URL: github.url,
    GIT_POLL_SECONDS: '2',
  }

  for (const [email, name] of [
    [E2E_EMAIL, 'E2E'],
    [E2E_SECOND_EMAIL, 'Second'],
    [E2E_MEMBER_EMAIL, 'Member'],
  ] as const) {
    await run(['dist/cli/create-admin.js', '--email', email, '--name', name], {
      ...env,
      ADMIN_PASSWORD: E2E_PASSWORD,
    })
  }
  // The CLI only makes admins: the member leaves the admins group.
  const members = createDb(pg.url, { max: 1 })
  await members.sql.unsafe(
    `delete from group_members
      where user_id = (select id from users where email = $1)
        and group_id = (select id from groups where system_kind = 'admins')`,
    [E2E_MEMBER_EMAIL],
  )
  await members.close()
  const server = spawn('node', ['--no-node-snapshot', 'dist/main.js'], {
    cwd: serverDir,
    env,
    stdio: 'inherit',
  })
  await waitForHealth(`${base}/api/health`, server)

  // A resource for the query block, configured in production.
  const cookie = await login(base)
  const trpc = async (path: string, input: unknown) => {
    const res = await fetch(`${base}/api/trpc/${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return (await res.json()).result.data.json
  }
  const envs = await (await fetch(`${base}/api/trpc/environments.list`, { headers: { cookie } })).json()
  const production = envs.result.data.json.find((e: { slug: string }) => e.slug === 'production')
  const resource = await trpc('resources.create', { type: 'postgres', name: 'Shop DB', slug: 'shop_db' })
  const url = new URL(pg.url)
  await trpc('resources.saveConfig', {
    resourceId: resource.id,
    environmentId: production.id,
    config: {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      ssl: 'disable',
    },
    secrets: { password: decodeURIComponent(url.password) },
  })

  return async () => {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.once('exit', resolve))
    await pg.stop()
    await github.close()
    rmSync(gitRoot, { recursive: true, force: true })
  }
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--no-node-snapshot', ...args], { cwd: serverDir, env, stdio: 'inherit' })
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`)),
    )
  })
}

async function waitForHealth(url: string, server: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the server did not become healthy')
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}
