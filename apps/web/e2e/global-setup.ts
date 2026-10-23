import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executorAvailable, startTestExecutor } from '@ow/code-executor/testing'
import { startFakePubSub, startTestIapServer } from '@ow/connectors/testing'
import { createDb } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { FakeGoogle } from '../../../packages/connectors/test/google-fake'
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
/** The VM the fake IAP endpoint reaches (at 127.0.0.1, on the port asked for: specs start the SSH server) (M18). */
export const E2E_IAP_VM = { project: 'e2e-project', zone: 'europe-west1-b', instance: 'bastion' }

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
  // For specs that point a resource of their own at this database (M17's SSH tunnel spec, through a test SSH server).
  process.env.E2E_PG_URL = pg.url
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

  // Python (M12): the code executor in a container, when Docker is there (CI must have it). Specs that need it read
  // E2E_PYTHON.
  const executor = executorAvailable() ? await startTestExecutor() : null
  if (executor) process.env.E2E_PYTHON = '1'

  // Google Cloud IAP (M18): a fake Google issues tokens (for a service account key, and from its metadata server as
  // this server's own identity) and a fake IAP endpoint takes them. Specs read the key from E2E_IAP_KEY.
  const google = new FakeGoogle()
  await google.start()
  const iap = await startTestIapServer({
    tokens: [],
    accept: (token) => /^(sa|md)-\d+$/.test(token),
    instances: { [`${E2E_IAP_VM.project}/${E2E_IAP_VM.zone}/${E2E_IAP_VM.instance}`]: '127.0.0.1' },
  })
  process.env.E2E_IAP_KEY = google.keyJson
  // Specs steer the fake IAP from their own process: POST /drop cuts every WebSocket (sessions stay, as on a dropped
  // network), POST /refuse-next?code=&reason= closes the next connect so; GET /stats counts connects and reconnects.
  // Pub/Sub (M19): a fake in project `fake-project`, topics `orders` and `refunds` with a subscription each
  // (`<topic>-sub`). Specs publish and look through E2E_IAP_CONTROL's /pubsub routes.
  const pubsub = await startFakePubSub({ project: 'fake-project' })
  for (const topic of ['orders', 'refunds']) {
    pubsub.createTopic(topic)
    pubsub.createSubscription(`${topic}-sub`, { topic })
  }
  const iapControl = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const param = (name: string) => url.searchParams.get(name) ?? ''
    if (url.pathname === '/pubsub/publish' && req.method === 'POST')
      return json({
        messageId: pubsub.publish(param('topic'), param('data'), JSON.parse(param('attributes') || '{}')),
      })
    if (url.pathname === '/pubsub/messages') return json(pubsub.messages(param('subscription')))
    if (url.pathname === '/pubsub/published') return json(pubsub.published(param('topic')))
    if (req.method === 'POST' && url.pathname === '/drop') iap.dropAll()
    else if (req.method === 'POST' && url.pathname === '/refuse-next')
      iap.refuseNext(Number(url.searchParams.get('code')), url.searchParams.get('reason') ?? '')
    else if (req.method !== 'GET' || url.pathname !== '/stats') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ connects: iap.connects.length, reconnects: iap.reconnects.length }))
  })
  await new Promise<void>((r) => iapControl.listen(0, '127.0.0.1', r))
  process.env.E2E_IAP_CONTROL = `http://127.0.0.1:${(iapControl.address() as { port: number }).port}`

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
    // Editors notice lost access quickly (M16).
    COLLAB_ACCESS_CHECK_MS: '500',
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
    ...(executor && { PYTHON_EXECUTOR_URL: executor.url, PYTHON_EXECUTOR_TOKEN: executor.token }),
    GOOGLE_SERVER_IDENTITY: 'allow',
    GOOGLE_IAP_URL: iap.url,
    GOOGLE_PUBSUB_URL: pubsub.url,
    GOOGLE_TOKEN_URL: google.tokenUrl,
    // The server's identity is the fake metadata server's, never the developer's own gcloud login.
    GOOGLE_APPLICATION_CREDENTIALS: '',
    HOME: gitRoot,
    GCE_METADATA_HOST: google.metadataHost,
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
    await executor?.stop()
    await new Promise((r) => iapControl.close(r))
    await iap.close()
    await pubsub.close()
    await google.stop()
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
