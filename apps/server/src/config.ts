import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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
  })
  .transform((c) => ({
    ...c,
    oidcEnabled: Boolean(c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
    secureCookies: c.PUBLIC_URL.startsWith('https://'),
  }))

export type Config = z.output<typeof ConfigSchema>

/** Loads `.env` from the repo root (dev convenience) and validates the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (env === process.env && existsSync(candidate)) {
      process.loadEnvFile(candidate)
      break
    }
  }
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}
