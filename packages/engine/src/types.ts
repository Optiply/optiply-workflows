import type {
  AnyConnector,
  CodeFetcher,
  CredentialSource,
  PoolManager,
  ResolvedResource,
} from '@ow/connectors'
import type { LogLevel } from '@ow/db'
import type {
  LibraryQueryDefinition,
  LibraryUser,
  OpenTaskField,
  TaskOutcome,
  WorkflowDefinition,
} from '@ow/definition'
import type { CodeRuntime, PythonRunner } from '@ow/sandbox'

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
  /** A Pub/Sub trigger's message (M19): `data` holds its data, this the rest (`startTrigger.message`). */
  message?: PubSubRunMessage
}

/** What a Pub/Sub-triggered run sees of its message, besides its data. */
export interface PubSubRunMessage {
  messageId: string
  publishTime: string
  attributes: Record<string, string>
  orderingKey?: string
  /** Pub/Sub's count, on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number
  subscription: string
  /** The data's bytes, for binary payloads `data` can only show as text. */
  dataBase64: string
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
   * A block started waiting (a Wait until `until`, or a sync Workflow block for its child run). Not final: the run resumes it later, and `blockFinished`
   * then commits its result.
   */
  blockWaiting(key: string, attempt: number, state: WaitState): Promise<void>
  /**
   * Commits finished loop iterations (keys `<loop>[<index>]`) in one go. Like `blockFinished`, a committed
   * iteration is never overwritten.
   */
  iterationsFinished(loop: string, results: readonly BlockResult[]): Promise<void>
  /** Buffered; failures to write logs never fail the run. */
  log(entry: { blockKey: string | null; level: LogLevel; message: string }): void
}

/**
 * Why a block is waiting, as stored on its `waiting` row so a resumed run picks up where it left off: when it
 * resumes at the latest, and for a sync Workflow block, the child run and when the block started waiting for it.
 */
export interface WaitState {
  until: Date
  childRunId?: string
  since?: Date
  /** The User Task a block waits for. */
  taskId?: string
}

/** Finds a resource's connector and decrypted settings for an environment. Throws when it can't. */
export interface ResourceProvider {
  resolve(
    slug: string,
    environmentId: string,
    opts?: { actingUserId?: string | null },
  ): Promise<{ connector: AnyConnector; resource: ResolvedResource; credentials?: CredentialSource }>
}

export interface EngineServices {
  /** One per run: concurrent evaluations queue on its isolate, and it's disposed when the run ends. */
  sandbox: CodeRuntime
  pool: PoolManager
  resources: ResourceProvider
  /** Backs `fetch` in code. Without it, `fetch` rejects with "fetch isn't available here". */
  fetcher?: Pick<CodeFetcher, 'fetch'>
  /** Starts and follows child runs (Workflow blocks, loop workflow runners). Without it they fail. */
  children?: ChildRuns
  /** Opens User Tasks and reads their answers. Without it User Task blocks fail. */
  tasks?: UserTasks
  /** Runs Python code (the code executor). Without it Python blocks fail with `python_unavailable`. */
  python?: PythonRunner
  /** Library queries (M21): Library query blocks and runners. Without it they fail with `library`. */
  library?: LibraryQueries
}

/** The Query Library as runs see it (M21). */
export interface LibraryQueries {
  /**
   * The release a reference runs: the pinned version, or the live one for `latest` (whichever is live now). Throws a
   * BlockFailure when the library query or the release doesn't exist. Nobody's access is checked: the workflow's
   * publisher vouched for using it (a draft run's starter was checked when the run started).
   */
  resolve(slug: string, version: string): Promise<{ version: string; definition: LibraryQueryDefinition }>
  /** `current_user` for a run started by this person; null when there's no such user any more. */
  user(userId: string): Promise<LibraryUser | null>
}

/** A User Task as its block sees it. */
export interface TaskState {
  id: string
  status: 'open' | 'completed' | 'expired' | 'cancelled'
  dueAt: Date | null
  outcome: string | null
  values: Record<string, unknown> | null
  completedBy: { id: string; email: string; name: string } | null
  completedAt: Date | null
}

export interface UserTasks {
  /**
   * Opens the task for this run's block, or returns the one it opened before. Assignees are emails and group
   * names; throws a BlockFailure when one doesn't exist, or when there's nobody to do the task.
   */
  open(request: {
    runId: string
    blockKey: string
    workflowId: string
    environmentId: string
    title: string
    description: string | null
    fields: OpenTaskField[]
    outcomes: TaskOutcome[]
    assignees: { users: string[]; groups: string[] }
    dueAt: Date | null
  }): Promise<TaskState>
  get(taskId: string): Promise<TaskState | null>
  /** Marks an open task expired (its due time passed); returns it as it is now. */
  expire(taskId: string): Promise<TaskState | null>
}

/** A child run as its parent sees it. */
export interface ChildRunState {
  runId: string
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  response: RunResponse | null
  error: (EngineError & { block?: string }) | null
}

/** Child workflow runs, for Workflow blocks and loop workflow runners. */
export interface ChildRuns {
  /**
   * Starts a run of `workflow`'s live release in the parent's environment, or returns the one this `key` started
   * before (so a re-run block doesn't start a second child). Throws a BlockFailure when the workflow is unknown or
   * not published.
   */
  start(request: {
    workflow: string
    input: unknown
    key: string
    parentRunId: string
    environmentId: string
  }): Promise<string>
  get(runId: string): Promise<ChildRunState | null>
  cancel(runId: string): Promise<void>
}

export interface ExecuteRunOptions {
  runId: string
  definition: WorkflowDefinition
  environmentId: string
  /**
   * Whose own accounts resources that connect one per person (OAuth) use: the person who started a draft run.
   * Null for runs of a release, which nobody is behind (webhooks, schedules, child runs).
   */
  actingUserId?: string | null
  /**
   * Whoever started the run (M21): manual, editor and app runs, inherited by child runs; null for schedules,
   * webhooks and Pub/Sub. Library queries see them as `current_user`.
   */
  currentUserId?: string | null
  input: RunInput
  /** Merged into every evaluation's scope: `configVars`, `workflowContext`, `idempotencyKey`. */
  globals: Record<string, unknown>
  services: EngineServices
  store: RunStore
  /** Results committed by an earlier lease; those blocks don't run again. */
  checkpoints?: readonly BlockResult[]
  /** Blocks an earlier lease left waiting, with when each resumes (and the child run a Workflow block waits for). */
  waits?: ReadonlyMap<string, WaitState>
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
