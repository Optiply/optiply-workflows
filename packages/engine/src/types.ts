import type { AnyConnector, CodeFetcher, PoolManager, ResolvedResource } from '@ow/connectors'
import type { LogLevel } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import type { CodeRuntime } from '@ow/sandbox'

/** Why a block or run failed, as stored and shown. Messages are scrubbed of known secrets. */
export interface EngineError {
  /** E.g. `timeout`, `expression`, `query`, `runtime`, `too_large`, `run_timeout`, `invalid_definition`. */
  code: string
  message: string
  details?: Record<string, unknown>
}

export type FinalBlockStatus = 'succeeded' | 'errored' | 'failed' | 'skipped' | 'cancelled'

/** A block's final outcome: what downstream `{{ }}` reads and what is checkpointed. */
export interface BlockResult {
  /** The block name. */
  key: string
  status: FinalBlockStatus
  /** Plain JSON. Null unless the block succeeded. */
  data: unknown
  /** Size of `data` as JSON text. */
  sizeBytes: number
  error: EngineError | null
  metadata: Record<string, unknown>
  /** The output port that fired (`out`, `error`, `cond:<id>`, `else`), or null when none did. */
  port: string | null
  attempt: number
  startedAt: Date | null
  finishedAt: Date
}

/** The first Response block's reply. */
export interface RunResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** What the start trigger receives. */
export interface RunInput {
  data?: unknown
  headers?: Record<string, string>
  pathParams?: Record<string, string>
  urlParams?: Record<string, string>
}

/**
 * Where a run's progress goes. The Postgres implementation fences every call with the lease's epoch and throws
 * `LeaseLostError` once another worker has taken the run over.
 */
export interface RunStore {
  /** A block attempt began (live status). */
  blockStarted(key: string, attempt: number, startedAt: Date): Promise<void>
  /**
   * Commits a block's final result, once per block. With `response`, the run's reply is recorded in the same
   * transaction.
   */
  blockFinished(result: BlockResult, extra?: { response?: RunResponse }): Promise<void>
  /**
   * A block started waiting until `until` (a Wait). Not final: the run resumes it later, and `blockFinished`
   * then commits its result.
   */
  blockWaiting(key: string, attempt: number, until: Date): Promise<void>
  /**
   * Commits finished loop iterations (keys `<loop>[<index>]`) in one go. Like `blockFinished`, a committed
   * iteration is never overwritten.
   */
  iterationsFinished(loop: string, results: readonly BlockResult[]): Promise<void>
  /** Buffered; failures to write logs never fail the run. */
  log(entry: { blockKey: string | null; level: LogLevel; message: string }): void
}

/** Finds a resource's connector and decrypted settings for an environment. Throws when it can't. */
export interface ResourceProvider {
  resolve(
    slug: string,
    environmentId: string,
  ): Promise<{ connector: AnyConnector; resource: ResolvedResource }>
}

export interface EngineServices {
  /** One per run: concurrent evaluations queue on its isolate, and it's disposed when the run ends. */
  sandbox: CodeRuntime
  pool: PoolManager
  resources: ResourceProvider
  /** Backs `fetch` in code. Without it, `fetch` rejects with "fetch isn't available here". */
  fetcher?: Pick<CodeFetcher, 'fetch'>
}

export interface ExecuteRunOptions {
  runId: string
  definition: WorkflowDefinition
  environmentId: string
  input: RunInput
  /** Merged into every evaluation's scope: `configVars`, `workflowContext`, `idempotencyKey`. */
  globals: Record<string, unknown>
  services: EngineServices
  store: RunStore
  /** Results committed by an earlier lease; those blocks don't run again. */
  checkpoints?: readonly BlockResult[]
  /** Wait blocks an earlier lease left waiting, with the time each resumes. */
  waits?: ReadonlyMap<string, Date>
  /**
   * Run only these blocks (the editor's "Run block"), plus whichever of their ancestors have no checkpoint.
   * Everything else is left alone. Omit to run the whole workflow.
   */
  only?: readonly string[]
  /** A Response block already replied in an earlier lease. */
  responded?: boolean
  /**
   * Interrupts the run without finishing it (shutdown, lease lost); in-flight blocks re-run on resume. Aborting
   * with a `RunCancelledError` cancels the run instead: in-flight blocks are recorded as cancelled.
   */
  signal?: AbortSignal
  /** The run fails when this passes. */
  deadline?: Date
  /** Blocks executing at once. Default 10. */
  maxConcurrency?: number
  /** Waits due sooner than this finish in the process instead of pausing the run. Default 1 s. */
  suspendAfterMs?: number
  /** The error handler's time limit. Default 60 s. */
  handlerTimeoutMs?: number
  /** Values scrubbed from logs and errors (secret config var values). */
  secrets?: readonly string[]
}

export interface RunOutcome {
  /**
   * `interrupted`: stopped without finishing; another lease resumes it from the checkpoints. `waiting`: only Wait
   * blocks are left, so the run pauses until `resumeAt`. `cancelled`: someone cancelled it.
   */
  status: 'succeeded' | 'failed' | 'interrupted' | 'waiting' | 'cancelled'
  error: (EngineError & { block?: string }) | null
  /** The reply recorded during this execution, if any. */
  response: RunResponse | null
  /** With `waiting`: when the earliest Wait is due. */
  resumeAt?: Date
  results: ReadonlyMap<string, BlockResult>
}
