import type { Evaluate, TemplateError } from '@ow/expressions'
import type { z } from 'zod'
import type { AiRunContext } from './ai/core'
import type { RestConfig } from './rest'

/** One resource's settings in one environment, with secrets already decrypted (server-side only). */
export interface ResolvedResource<Config = unknown, Secrets = unknown> {
  /** The `resource_configs` row id. */
  id: string
  resourceId: string
  environmentId: string
  /** Changes whenever config or secrets change (e.g. `updatedAt`); pooled clients are keyed by it. */
  version: string
  config: Config
  secrets: Secrets
}

export interface QueryContext {
  /** Evaluates the code inside one `{{ }}`. */
  evaluate: Evaluate
  /** Aborted on timeout or cancellation; connectors must stop work (cancel SQL, abort HTTP). */
  signal: AbortSignal
  /** Time budget for this execution. */
  timeoutMs: number
  /**
   * `timeoutMs` was set on the block or query itself (not a default), so it overrides the resource's statement
   * timeout: a block given 10 minutes gets 10 minutes, even on a resource whose statement timeout is 2.
   */
  ownTimeout?: boolean
  /** Who is running the query (workflow, run, user), for connectors that can tag their work: BigQuery job labels. */
  labels?: Record<string, string>
  /**
   * The `{{ }}` values come from someone who mustn't shape the request beyond them (an app's viewer, through the
   * browser). SQL binds values anyway; REST puts each one in its URL path as a single encoded segment.
   */
  untrustedValues?: boolean
  /** Access tokens for resources whose credentials live outside their settings (OAuth authorization code). */
  credentials?: CredentialSource
  /** AI resources (M35): the run's token budget so far and, in workflows, the workflows an agent may call. */
  ai?: AiRunContext
}

/**
 * How long a SQL statement may run: the block's or query's own timeout when it set one, otherwise the shorter of
 * the default budget and the resource's statement timeout.
 */
export function statementTimeoutMs(
  ctx: Pick<QueryContext, 'timeoutMs' | 'ownTimeout'>,
  resourceMs: number,
): number {
  return ctx.ownTimeout ? ctx.timeoutMs : Math.min(ctx.timeoutMs, resourceMs)
}

/**
 * Credentials that belong to a connection rather than to the resource's settings: an OAuth access token (the shared
 * account, or the account of the person running the query), or the variables a custom auth flow signed in for. The
 * server supplies them; connectors only ask.
 */
export interface CredentialSource {
  /**
   * OAuth: a token that should be valid now. `force` gets a fresh one even if the stored token looks valid (the API
   * just refused it). Throws a `ConnectorError` with code `auth_required` when nothing is connected or the provider
   * no longer accepts the connection.
   */
  accessToken?(opts: { signal: AbortSignal; force?: boolean }): Promise<string>
  /**
   * Custom auth flows: the variables the flow signed in for, as an evaluator of the `{{ auth.NAME }}` in the
   * resource's headers and parameters. `force` refreshes them (the API refused them). Throws `auth_required` when
   * signing in fails.
   */
  authVariables?(opts: { signal: AbortSignal; force?: boolean }): Promise<AuthVariables>
}

export interface AuthVariables {
  /** Evaluates the inside of a `{{ }}` with `auth` (the flow's variables) in scope. */
  evaluate: Evaluate
  /** The variables' values, scrubbed from what queries return. */
  secrets: string[]
}

export interface QueryResult {
  data: unknown
  metadata: Record<string, unknown>
}

export interface TestResult {
  /** Shown to the user, e.g. the server version or HTTP status. */
  message?: string
}

export interface Connector<Config = unknown, Secrets = unknown, Query = unknown, Client = unknown> {
  readonly type: string
  readonly label: string
  /** Non-secret settings, stored as `resource_configs.config`. */
  readonly configSchema: z.ZodType<Config>
  /** Credentials, stored encrypted in `resource_configs.secrets` and never returned to the browser. */
  readonly secretsSchema: z.ZodType<Secrets>
  readonly querySchema: z.ZodType<Query>
  /**
   * Also scrub secret values out of result data, not just errors and metadata. For connectors whose results
   * can plausibly echo credentials (an HTTP API reflecting headers); off for databases, where it would mangle
   * ordinary values that happen to match a short password.
   */
  readonly scrubResultData?: boolean
  createClient(resource: ResolvedResource<Config, Secrets>): Client | Promise<Client>
  destroyClient(client: Client): Promise<void>
  testConnection(
    client: Client,
    ctx: { signal: AbortSignal; timeoutMs: number; credentials?: CredentialSource },
  ): Promise<TestResult>
  /**
   * The REST-shaped settings an HTTP connector connects with (M27): its base URL, auth, allowed hosts and network.
   * The server's OAuth sign-in (M9) and custom auth flows work from these, for any type that has them.
   */
  httpConfig?(config: Config): RestConfig
  /** Static checks that need no evaluation (e.g. `{{ }}` inside a SQL string literal). */
  validateQuery(query: Query): TemplateError[]
  execute(client: Client, query: Query, ctx: QueryContext): Promise<QueryResult>
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds connectors of different shapes
export type AnyConnector = Connector<any, any, any, any>

export type ConnectorErrorCode =
  | 'invalid_config'
  | 'invalid_query'
  | 'expression'
  | 'timeout'
  | 'aborted'
  | 'connection'
  | 'query'
  | 'http'
  | 'blocked'
  | 'too_large'
  /** An account has to be connected (or reconnected) before the resource can be used. */
  | 'auth_required'
  /** AI (M35): the model declined (its category in the message), the answer was cut off, the run's AI budget is
   * spent, the answer isn't what was asked for (JSON, the schema, a label), an agent ran out of steps. */
  | 'ai_refused'
  | 'ai_max_tokens'
  | 'ai_budget'
  | 'ai_invalid_output'
  | 'ai_max_steps'

/** Every failure surfaced to users. Messages and details are scrubbed of the resource's secrets. */
export class ConnectorError extends Error {
  override name = 'ConnectorError'
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}
