import { scrubSecretsDeep } from '@ow/crypto'
import { z } from 'zod'
import { clientCredentialsToken } from '../oauth'
import { type RestConfig, restAuthSchema, restConfigSchema } from '../rest'
import { actionQuerySchema, fieldReader, limitOf, validateActionQuery } from '../services/common'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from '../types'
import { type SdkEnvProvider, type SdkOutcome, type SdkRunRequest, sdkEnvs, sdkRunner } from './runner'

// SDK resources (M37, docs/architecture.md §2.41): a company SDK, Python or JavaScript, installed from its registry by
// the package builder, its client made by the resource's setup code with the resource's token (pasted, OAuth client
// credentials, or M9's OAuth sign-in), its methods called in the SDK runner's jail with network only to the
// resource's hosts. The query: call a method, run a snippet, or describe the client.

const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/

/** REST's sign-in (M9's OAuth, client credentials, a token), as far as an SDK takes a token. */
const SDK_AUTH_TYPES = ['none', 'bearer', 'oauth2ClientCredentials', 'oauth2AuthorizationCode'] as const

const configSchema = z.object({
  language: z.enum(['python', 'javascript']).default('python'),
  /** The SDK and anything it needs: requirement lines (`acme-sdk==1.4.2`) or npm packages (`@acme/sdk@^2`). */
  packages: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  /** A Python index's slug (Settings → Python); npm registries apply by scope. */
  pythonIndex: optionalText(
    z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62})$/, 'A Python index’s slug'),
  ),
  /** Handed to the setup code; its host is allowed by default. */
  baseUrl: optionalText(z.string().trim().url().max(2048)),
  /** Where the SDK may connect (`api.acme.com`, `*.acme.com`, `host:8443`); empty: the base URL's host. */
  allowedHosts: z
    .array(z.string().trim().toLowerCase().regex(HOST, 'A host name, *.domain, or host:port'))
    .max(50)
    .default([]),
  /** The hosts may be on a private network (admins only). */
  allowPrivateNetwork: z.boolean().default(false),
  /** Plain settings for the setup code (JSON). */
  options: z.record(z.string(), z.unknown()).default({}),
  /** Makes the client: Python `def client(token, base_url, options, secrets)`, JavaScript `export default (…) => …`. */
  setup: z.string().max(100_000).default(''),
  auth: restAuthSchema
    .refine((a) => (SDK_AUTH_TYPES as readonly string[]).includes(a.type), {
      message: 'An SDK signs in with a token, OAuth client credentials or OAuth sign-in',
    })
    .default({ type: 'bearer' }),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({
  /** The pasted token (auth `bearer`). */
  bearerToken: z.string().optional(),
  /** The OAuth app's client secret (client credentials, or M9's sign-in). */
  clientSecret: z.string().optional(),
  /** Secret values for the setup code, by name. */
  values: z.record(z.string(), z.string()).default({}),
})
type Secrets = z.output<typeof secretsSchema>

const querySchema = actionQuerySchema('sdk')

/** The settings M9's OAuth (connect routes, token store) reads: the sign-in, and the base URL for its consent. */
function httpConfig(config: Config): RestConfig {
  return restConfigSchema.parse({
    baseUrl: config.baseUrl ?? 'https://sdk.invalid/',
    auth: config.auth,
    allowedHosts: [],
    allowPrivateNetwork: config.allowPrivateNetwork,
  })
}

/** The hosts the SDK may reach: the resource's list, else its base URL's host. */
export function sdkAllowedHosts(config: Pick<Config, 'allowedHosts' | 'baseUrl'>): string[] {
  if (config.allowedHosts.length) return config.allowedHosts
  if (!config.baseUrl) return []
  const url = new URL(config.baseUrl)
  return [url.port ? `${url.hostname}:${url.port}` : url.hostname]
}

interface Client {
  resourceId: string
  config: Config
  secrets: Secrets
  /** Client credentials' token, until a minute before it expires. */
  cached?: { token: string; expiresAt: number }
  /** The env a test installed first (`prepareTest`), outside its time limit; a test's client is its own. */
  installed?: SdkEnv
}

type SdkEnv = Awaited<ReturnType<SdkEnvProvider>>

/** How long Test connection waits for a first install before saying it goes on in the background. */
export const SDK_TEST_INSTALL_MS = 3 * 60_000

function envSpec(client: Client) {
  const { config } = client
  return {
    resourceId: client.resourceId,
    language: config.language,
    packages: config.packages,
    pythonIndex: config.pythonIndex,
  }
}

type Ctx = QueryContext

/** The token the setup code gets; `force` after the SDK was refused (401). */
async function tokenFor(client: Client, ctx: Ctx, force: boolean): Promise<string | null> {
  const { auth } = client.config
  if (auth.type === 'none') return null
  if (auth.type === 'bearer') {
    if (!client.secrets.bearerToken) throw new ConnectorError('invalid_config', 'Add the token (bearerToken)')
    return client.secrets.bearerToken
  }
  if (auth.type === 'oauth2AuthorizationCode') {
    if (!ctx.credentials?.accessToken) {
      throw new ConnectorError('auth_required', 'Connect an account in the resource first (OAuth sign-in)')
    }
    return ctx.credentials.accessToken({ signal: ctx.signal, force })
  }
  if (auth.type === 'oauth2ClientCredentials') {
    if (!force && client.cached && client.cached.expiresAt > Date.now()) return client.cached.token
    if (!client.secrets.clientSecret) throw new ConnectorError('invalid_config', 'Add the client secret')
    const set = await clientCredentialsToken(auth, client.secrets.clientSecret, {
      signal: ctx.signal,
      allowPrivateNetwork: client.config.allowPrivateNetwork,
    })
    client.cached = {
      token: set.accessToken,
      expiresAt: set.expiresAt ? set.expiresAt.getTime() - 60_000 : Date.now() + 5 * 60_000,
    }
    return set.accessToken
  }
  throw new ConnectorError('invalid_config', `An SDK can't sign in with ${auth.type}`)
}

/** One call in the runner: the env installed (or found) first, the token fetched, a 401 retried once afresh. */
async function callSdk(
  client: Client,
  request: Pick<SdkRunRequest, 'mode' | 'method' | 'args' | 'limit' | 'code' | 'params'>,
  ctx: Ctx,
): Promise<{ outcome: SdkOutcome; versions: Record<string, string> }> {
  const started = Date.now()
  const { config } = client
  if (!config.setup.trim()) {
    throw new ConnectorError('invalid_config', 'Write the setup code that makes the SDK’s client')
  }
  const env = config.packages.length ? (client.installed ?? (await sdkEnvs()(envSpec(client)))) : null
  const tokens: string[] = []
  // The query's whole budget covers the install, the token and every attempt: each call gets what's left, so the
  // runner reports its own timeout (with the prints) before the query's abort cuts it off.
  const deadline = started + ctx.timeoutMs
  const attempt = async (force: boolean) => {
    const token = await tokenFor(client, ctx, force)
    if (token) tokens.push(token)
    const scrub = (text: string) =>
      scrubSecretsDeep(text, [...tokens, ...Object.values(client.secrets.values)])
    return sdkRunner().run(
      {
        language: config.language,
        ...(env && { envId: env.envId }),
        setup: config.setup,
        context: {
          token,
          baseUrl: config.baseUrl ?? null,
          options: config.options,
          secrets: client.secrets.values,
        },
        allowedHosts: sdkAllowedHosts(config),
        allowPrivate: config.allowPrivateNetwork,
        timeoutMs: Math.max(1000, deadline - Date.now()),
        ...request,
      },
      { signal: ctx.signal, onLog: (level, message) => ctx.log?.(level, scrub(message)) },
    )
  }
  let outcome = await attempt(false)
  const refreshable =
    config.auth.type === 'oauth2AuthorizationCode' || config.auth.type === 'oauth2ClientCredentials'
  if (!outcome.ok && outcome.error?.status === 401 && refreshable) {
    ctx.log?.('info', 'The SDK was refused (401): calling again with a fresh token')
    outcome = await attempt(true)
  }
  return {
    outcome: scrubSecretsDeep(outcome, [...tokens, ...Object.values(client.secrets.values)]),
    versions: env?.versions ?? {},
  }
}

/** The runner's failure as the query's: the SDK's own words, its type and HTTP status, blocked hosts. */
function failure(outcome: SdkOutcome): ConnectorError {
  const error = outcome.error ?? { kind: 'sdk', message: 'The SDK call failed' }
  const kind = error.kind
  const code =
    kind === 'timeout'
      ? 'timeout'
      : kind === 'sdk_method'
        ? 'sdk_method'
        : kind === 'sdk_install'
          ? 'sdk_install'
          : kind === 'cancelled'
            ? 'aborted'
            : 'sdk'
  const where = error.line ? ` (line ${error.line}${kind === 'setup' ? ' of the setup code' : ''})` : ''
  const blocked = outcome.blocked?.length ? `. Blocked: ${outcome.blocked.map((b) => b.host).join(', ')}` : ''
  const prefix = kind === 'setup' ? 'The setup code failed: ' : kind === 'syntax' ? 'Syntax error: ' : ''
  return new ConnectorError(code, `${prefix}${error.message}${where}${blocked}`, {
    kind,
    ...(error.type && { type: error.type }),
    ...(error.status !== undefined && { status: error.status }),
    ...(error.line != null && { line: error.line }),
    ...(outcome.blocked?.length && { blocked: outcome.blocked }),
  })
}

export const sdkConnector: Connector<Config, Secrets, typeof querySchema._output, Client> = {
  type: 'sdk',
  label: 'SDK (Python or JavaScript)',
  configSchema,
  secretsSchema,
  querySchema,
  scrubResultData: true,

  createClient(resource) {
    return { resourceId: resource.resourceId, config: resource.config, secrets: resource.secrets }
  },

  async destroyClient() {},

  async prepareTest(client) {
    if (!client.config.packages.length) return undefined
    const started = Date.now()
    // The install goes on if the test stops waiting: the builder caches it, so the next test finds it.
    const install = sdkEnvs()(envSpec(client))
    install.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ConnectorError(
              'timeout',
              `Installing the SDK's packages takes more than ${SDK_TEST_INSTALL_MS / 60_000} minutes. It goes on in the background: test again in a few minutes`,
            ),
          ),
        SDK_TEST_INSTALL_MS,
      )
    })
    try {
      client.installed = await Promise.race([install, tooLong])
    } catch (err) {
      if (err instanceof ConnectorError && err.code !== 'timeout') {
        throw new ConnectorError(
          err.code,
          `Installing the SDK's packages failed: ${err.message}`,
          err.details,
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
    return `installing the SDK's packages (${Math.round((Date.now() - started) / 1000)} s)`
  },

  httpConfig,

  async testConnection(client, ctx) {
    const { outcome, versions } = await callSdk(
      client,
      { mode: 'describe' },
      {
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
        ...(ctx.credentials && { credentials: ctx.credentials }),
        evaluate: async () => undefined,
      },
    )
    if (!outcome.ok) throw failure(outcome)
    const described = outcome.result as { type?: string; members?: unknown[] }
    const installed = Object.entries(versions)
      .slice(0, 3)
      .map(([name, version]) => `${name} ${version}`)
      .join(', ')
    return {
      message: `The client (${described.type ?? 'a value'}) has ${described.members?.length ?? 0} members${installed ? `; installed ${installed}` : ''}`,
    }
  },

  // A snippet is code, not a template (Python's {{ }} is a set in a dict): only the other fields are checked.
  validateQuery: ({ code: _code, ...query }) => validateActionQuery(query as typeof querySchema._output),

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('sdk', query, ctx)
    let request: Parameters<typeof callSdk>[1]
    switch (query.action) {
      case 'call': {
        const method = await f.required('method')
        const args = await f.json('args')
        request = {
          mode: 'call',
          method,
          ...(args !== undefined && { args }),
          limit: limitOf(await f.number('limit'), 100_000, 1000),
        }
        break
      }
      case 'code':
        request = {
          mode: 'code',
          code: query.code ?? '',
          params: (await f.json('params')) ?? {},
          limit: limitOf(await f.number('limit'), 100_000, 1000),
        }
        break
      case 'describe':
        request = { mode: 'describe' }
        break
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
    const started = Date.now()
    const { outcome, versions } = await callSdk(client, request, ctx)
    if (!outcome.ok) throw failure(outcome)
    return {
      data: outcome.result ?? null,
      metadata: {
        language: client.config.language,
        durationMs: Date.now() - started,
        ...(Object.keys(versions).length && { packages: versions }),
        connections: outcome.connections ?? 0,
        ...(outcome.blocked?.length && { blocked: outcome.blocked }),
      },
    }
  },
}
