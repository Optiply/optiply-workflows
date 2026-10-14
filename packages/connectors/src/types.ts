import type { Evaluate, TemplateError } from '@ow/expressions'
import type { z } from 'zod'

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
  /** Who is running the query (workflow, run, user), for connectors that can tag their work: BigQuery job labels. */
  labels?: Record<string, string>
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
  testConnection(client: Client, ctx: { signal: AbortSignal; timeoutMs: number }): Promise<TestResult>
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
