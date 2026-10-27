import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Keyring, parseKeyring } from '@ow/crypto'
import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .default(false)

const ConfigSchema = z
  .object({
    ROLE: z.enum(['api', 'worker', 'migrate', 'all']).default('all'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().url(),
    /** Run migrations when the api/all role starts (handy in dev; prod uses the dedicated migrate role). */
    AUTO_MIGRATE: bool,
    /** Externally visible origin, e.g. https://workflows.optiply.nl — used for OIDC redirects and cookies. */
    PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    /** Signs short-lived cookies (OIDC state). ≥ 32 chars. */
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 7),
    TRUST_PROXY: bool,
    OIDC_ISSUER: z.string().url().default('https://accounts.google.com'),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    /** Only emails from this domain may sign in via SSO. */
    OIDC_ALLOWED_DOMAIN: z.string().default('optiply.nl'),
    /** Break-glass email/password login for local admins (created via the create-admin CLI). */
    LOCAL_LOGIN_ENABLED: bool,
    /** Directory with the built web app to serve (production). */
    WEB_DIST_DIR: z.string().optional(),
    /** Resource credentials and secret config vars: `v1:<base64 32 bytes>[,v2:…]`. Losing these loses every secret. */
    ENCRYPTION_KEYS: z.string().min(1),
    /** Version used for new encryptions; defaults to the last key in ENCRYPTION_KEYS. */
    ENCRYPTION_KEY_CURRENT: z.string().optional(),
    /** Workflow runs one worker process executes at once. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    /** Sync webhook runs one API process executes itself at once; more go to the workers. 0 sends all of them. */
    WEBHOOK_INLINE_CONCURRENCY: z.coerce.number().int().min(0).max(100).default(8),
    /** Workers delete runs (with their blocks and logs) that finished longer ago than this, once a day. 0 keeps all. */
    RUN_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
    /**
     * How often an open editor's connection (M16) checks its session and access again: a draft deleted, access
     * taken away, the object protected or the person signed out ends it.
     */
    COLLAB_ACCESS_CHECK_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
    /** When set, `/metrics` needs `Authorization: Bearer <token>`. */
    METRICS_TOKEN: z.string().optional(),
    /** Workers serve `/metrics` (and `/health`) on this port; 0 turns it off. The API serves it on PORT. */
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
    /**
     * Lets `fetch` in workflow code reach private, loopback and link-local addresses. Off by default (SSRF guard);
     * for development and tests against local servers.
     */
    CODE_FETCH_ALLOW_PRIVATE_NETWORK: bool,
    /**
     * Where each process keeps its bare cache of the Git repo (M11). Not shared between processes: each takes it
     * for itself. Defaults to `<tmp>/ow-git-<pid>`.
     */
    GIT_CACHE_DIR: z.string().optional(),
    /** Lets the Git repo be a `file://` or `http://` URL: for development and tests against local repos. */
    GIT_ALLOW_INSECURE_URLS: bool,
    /** Workers check the deploy branch this often (seconds; 0 turns polling off: webhooks and Deploy now only). */
    GIT_POLL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
    /** Workers re-check the last deploy's problem objects this often (minutes; 0 off; M22). */
    GIT_RETRY_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
    /** The GitHub REST API to open pull requests with; by default worked out from the repo URL (tests set it). */
    GITHUB_API_URL: z.string().url().optional(),
    /**
     * The code executor that runs Python code blocks (M12, apps/code-executor), e.g. `http://code-executor:8080`.
     * Without it, workflows with Python can't run or be published.
     */
    PYTHON_EXECUTOR_URL: z.string().url().optional(),
    /** The executor's bearer token (its PYTHON_EXECUTOR_TOKEN). Without it Python stays off (a warning at start). */
    PYTHON_EXECUTOR_TOKEN: z.string().min(16).optional(),
    /**
     * `allow` lets resources use this server's own Google identity: SSH tunnels through Google Cloud IAP (M18) and
     * Pub/Sub resources (M19). It's the Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, gcloud's
     * file, or the metadata server). Off by default; only admins can choose it for a resource.
     */
    GOOGLE_SERVER_IDENTITY: z.enum(['allow', 'deny']).default('deny'),
    /** IAP's WebSocket endpoint, Pub/Sub's REST API and Google's token endpoint: for tests against fakes. */
    GOOGLE_IAP_URL: z.string().url().optional(),
    GOOGLE_PUBSUB_URL: z.string().url().optional(),
    GOOGLE_TOKEN_URL: z.string().url().optional(),
  })
  .transform(({ ENCRYPTION_KEYS, ENCRYPTION_KEY_CURRENT, ...c }, ctx) => {
    let keyring: Keyring
    try {
      keyring = parseKeyring(ENCRYPTION_KEYS, ENCRYPTION_KEY_CURRENT)
    } catch (err) {
      // Keyring errors read "<VAR>: <problem>"; report them under that variable.
      const [, variable = 'ENCRYPTION_KEYS', message = ''] =
        /^(\w+): (.*)$/.exec((err as Error).message) ?? []
      ctx.addIssue({ code: 'custom', path: [variable], message })
      return z.NEVER
    }
    return {
      ...c,
      keyring,
      oidcEnabled: Boolean(c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
      secureCookies: c.PUBLIC_URL.startsWith('https://'),
    }
  })

export type Config = z.output<typeof ConfigSchema>

/**
 * Loads `.env` from the repo root (dev convenience) and validates the environment. An empty variable counts as
 * unset: Compose passes `${VAR:-}` through as an empty string, and `VAR=` in `.env` means "no value".
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (env === process.env && existsSync(candidate)) {
      process.loadEnvFile(candidate)
      break
    }
  }
  const parsed = ConfigSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}
