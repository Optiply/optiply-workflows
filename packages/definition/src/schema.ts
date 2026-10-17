import { z } from 'zod'

/**
 * The stored shape of a workflow: what the editor autosaves as the draft and what a release freezes.
 *
 * Built for Git: block **names** are the identity (`{{ query1.data }}` reads a block by name), resources are
 * referenced by slug, the canvas layout is kept apart from the logic, and nothing secret ever appears here.
 * Optional settings are stored sparsely; `resolveBlockSettings` fills in the defaults at run time.
 *
 * M2 covered the headless block types; M5 adds Loop, Function, Workflow, Wait, the global error handler and
 * `functions` (reusable subflows); M6 adds User Tasks. Triggers (webhook and schedules) only act on the live
 * release (M4).
 */

export const SCHEMA_VERSION = 1

export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000
export const MAX_RUN_TIMEOUT_MS = 6 * 60 * 60_000

/** A block name is a JS identifier, because expressions read blocks as variables. */
export const blockNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    'Use up to 64 letters, digits or underscores, starting with a letter or underscore',
  )

/** A function's name and its parameters' names are JS identifiers too: code calls `await name()`. */
export const identifierSchema = blockNameSchema

/** Same rule as resource slugs in the resources API. */
export const resourceSlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,62}$/,
    'Use 2–63 lowercase letters, digits or underscores, starting with a letter',
  )

/** Same rule as workflow slugs in the workflows API (they appear in webhook URLs). */
export const workflowSlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,62}$/,
    'Use 2–63 lowercase letters, digits, dashes or underscores, starting with a letter',
  )

/** Branch conditions have stable ids so reordering them keeps their `cond:<id>` edges attached. */
export const conditionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use up to 32 letters, digits, underscores or dashes')

/** `out` on success, `error` when a block with `finally: continue` fails, `cond:<id>`/`else` on a branch. */
export const portSchema = z
  .string()
  .regex(/^(out|error|else|cond:[A-Za-z0-9_-]{1,32})$/, 'Expected out, error, else or cond:<id>')

const nonBlank = (what: string) => z.string().regex(/\S/, `${what} can't be empty`)

export const retrySettingsSchema = z.strictObject({
  /** Extra attempts after the first one fails. */
  count: z.number().int().min(0).max(10).optional(),
  intervalMs: z.number().int().min(0).max(3_600_000).optional(),
  exponential: z.boolean().optional(),
  /** Multiplier per attempt when `exponential` is on. */
  coefficient: z.number().min(1).max(10).optional(),
  maxIntervalMs: z.number().int().min(0).max(3_600_000).optional(),
})

export const blockSettingsSchema = z.strictObject({
  timeoutMs: z.number().int().min(100).max(MAX_RUN_TIMEOUT_MS).optional(),
  retry: retrySettingsSchema.optional(),
  /** `stop` fails the run; `continue` kills the `out` edge and fires the `error` edge instead. */
  finally: z.enum(['stop', 'continue']).optional(),
})

/** A loop retries each iteration (`config.iteration`), never the whole loop. */
export const loopSettingsSchema = blockSettingsSchema.omit({ retry: true })

/** A wait has nothing to time out or retry; it can only continue on failure (a bad duration, say). */
export const waitSettingsSchema = blockSettingsSchema.pick({ finally: true })

const named = {
  name: blockNameSchema,
  description: z.string().max(2000).optional(),
}
const executable = { ...named, settings: blockSettingsSchema.optional() }

/** Parameter values for a function call: templates by parameter name. */
const functionArgsSchema = z.record(identifierSchema, z.string())

const keyValueSchema = z.strictObject({ key: z.string(), value: z.string() })

export const startTriggerBlockSchema = z.strictObject({
  ...named,
  type: z.literal('startTrigger'),
  config: z
    .strictObject({
      /** Input used by the editor's Run button. */
      testInput: z.json().optional(),
    })
    .optional(),
})

/** The languages code runs in. Stored only for Python: no `language` is JavaScript (so older hashes stand). */
export const CODE_LANGUAGES = ['javascript', 'python'] as const
export type CodeLanguage = (typeof CODE_LANGUAGES)[number]

/** `python` for Python; JavaScript otherwise. */
const languageSchema = z.literal('python').optional()

export const codeBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('code'),
  config: z.strictObject({
    /**
     * Run as a function body that `return`s the block's data: JavaScript (async: may `await`), or Python with
     * `language: 'python'` (run by the code executor; reads blocks as variables, can't call functions or fetch).
     */
    code: z.string(),
    language: languageSchema,
  }),
})

export const resourceQueryBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('resourceQuery'),
  config: z.strictObject({
    resource: resourceSlugSchema,
    /** The connector's query, checked against its `querySchema` when resources are known. Strings are templates. */
    query: z.record(z.string(), z.json()),
  }),
})

export const branchBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('branch'),
  config: z.strictObject({
    /** Checked in order; only the first truthy one fires its `cond:<id>` edge, otherwise `else` fires. */
    conditions: z
      .array(
        z.strictObject({
          id: conditionIdSchema,
          /** A JS expression, written without `{{ }}`. */
          expression: nonBlank('A condition'),
        }),
      )
      .min(1)
      .max(50),
  }),
})

export const filterBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('filter'),
  config: z.strictObject({
    /** A template that evaluates to an array, e.g. `{{ query1.data }}`. */
    input: nonBlank('The input'),
    /** A JS expression, written without `{{ }}`, with `value` and `index` in scope. Truthy keeps the item. */
    condition: nonBlank('The condition'),
  }),
})

export const responseBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('response'),
  config: z.strictObject({
    /** Template for the HTTP status; defaults to `200`. */
    status: z.string().optional(),
    headers: z.array(keyValueSchema).max(50).optional(),
    /** JSON template, rendered like a REST body: `{"id": {{ query1.data[0].id }}}`. */
    body: z.string().optional(),
  }),
})

export const LOOP_MODES = ['parallel', 'sequential', 'batch'] as const
export const DEFAULT_LOOP_CONCURRENCY = 10
export const MAX_LOOP_CONCURRENCY = 50
export const DEFAULT_LOOP_BATCH_SIZE = 10
export const MAX_LOOP_ITERATIONS = 100_000

/** `sync` waits for the child run to finish and returns its result; `async` returns `{ runId }` once it's queued. */
export const WORKFLOW_CALL_MODES = ['sync', 'async'] as const

/**
 * What a loop runs for each item. Every field sees `value` (the item) and `index` besides the usual scope.
 */
export const loopRunnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('code'),
    /** A function body, like a code block's (JavaScript, or Python); its `return` is the iteration's data. */
    code: z.string(),
    language: languageSchema,
  }),
  z.strictObject({
    kind: z.literal('query'),
    resource: resourceSlugSchema,
    query: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    kind: z.literal('function'),
    function: identifierSchema,
    params: functionArgsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('workflow'),
    workflow: workflowSlugSchema,
    /** JSON template for the child run's `startTrigger.data`. */
    input: z.string().optional(),
    mode: z.enum(WORKFLOW_CALL_MODES).optional(),
  }),
])

export const loopBlockSchema = z.strictObject({
  ...named,
  settings: loopSettingsSchema.optional(),
  type: z.literal('loop'),
  config: z.strictObject({
    /** A template that evaluates to an array, e.g. `{{ query1.data }}`. */
    input: nonBlank('The input'),
    /**
     * `parallel` runs up to `concurrency` iterations at once (default); `sequential` runs one at a time; `batch`
     * runs `batchSize` at once and pauses `batchDelayMs` between batches.
     */
    mode: z.enum(LOOP_MODES).optional(),
    concurrency: z.number().int().min(1).max(MAX_LOOP_CONCURRENCY).optional(),
    batchSize: z.number().int().min(1).max(1000).optional(),
    batchDelayMs: z.number().int().min(0).max(3_600_000).optional(),
    runner: loopRunnerSchema,
    /** Each iteration's limit and retries; defaults as for a block. */
    iteration: z
      .strictObject({ timeoutMs: blockSettingsSchema.shape.timeoutMs, retry: retrySettingsSchema.optional() })
      .optional(),
    /** A failed iteration fails the loop (`stop`, default) or leaves `null` in its slot (`continue`). */
    onError: z.enum(['stop', 'continue']).optional(),
  }),
})

export const functionBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('function'),
  config: z.strictObject({
    function: identifierSchema,
    params: functionArgsSchema.optional(),
  }),
})

export const workflowBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('workflow'),
  config: z.strictObject({
    /** The child workflow's slug; its live release runs, in this run's environment. */
    workflow: workflowSlugSchema,
    /** JSON template for the child run's `startTrigger.data`. */
    input: z.string().optional(),
    /** Default `sync`. */
    mode: z.enum(WORKFLOW_CALL_MODES).optional(),
  }),
})

export const WAIT_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const
export const MAX_WAIT_MS = 60 * 24 * 60 * 60_000

/** A durable pause: the run gives up its worker and resumes when the time comes. At most 60 days. */
export const waitBlockSchema = z.strictObject({
  ...named,
  settings: waitSettingsSchema.optional(),
  type: z.literal('wait'),
  config: z.discriminatedUnion('kind', [
    /** `amount` is a template for a number of `unit`s. */
    z.strictObject({ kind: z.literal('duration'), amount: z.string(), unit: z.enum(WAIT_UNITS) }),
    /** A template for a date and time (ISO 8601, or anything `dayjs` parses). */
    z.strictObject({ kind: z.literal('until'), until: z.string() }),
  ]),
})

export const TASK_FIELD_TYPES = ['text', 'longText', 'number', 'checkbox', 'select'] as const
export const TASK_DUE_UNITS = ['minutes', 'hours', 'days'] as const
/** A task without outcomes of its own has this one. */
export const DEFAULT_TASK_OUTCOMES = [{ id: 'submit', label: 'Submit' }] as const

/** One thing the person fills in. Its value is `values.<name>` in the block's data. */
export const taskFieldSchema = z.strictObject({
  name: identifierSchema,
  label: z.string().max(200),
  type: z.enum(TASK_FIELD_TYPES),
  required: z.boolean().optional(),
  /** The choices of a `select`. */
  options: z.array(z.string().max(200)).max(100).optional(),
  /** A template for the starting value, evaluated when the task opens. */
  default: z.string().optional(),
  help: z.string().max(500).optional(),
})

/** A button that completes the task, e.g. Approve and Reject. Its id is `outcome` in the block's data. */
export const taskOutcomeSchema = z.strictObject({
  id: identifierSchema,
  label: z.string().max(100),
})

/**
 * Human in the loop: the run waits (without holding a worker) until one of the assignees completes the task in the
 * inbox, then carries on with `{ outcome, values, completedBy, completedAt }`. Titles, descriptions, assignees,
 * field defaults and the due time are templates. Past its due time the task expires and the block fails.
 */
export const userTaskBlockSchema = z.strictObject({
  ...named,
  settings: waitSettingsSchema.optional(),
  type: z.literal('userTask'),
  config: z.strictObject({
    title: z.string().max(500),
    description: z.string().max(10_000).optional(),
    /** Users by email and groups by name; any of them can complete it (admins always can). */
    assignees: z.strictObject({
      users: z.array(z.string()).max(100).optional(),
      groups: z.array(z.string()).max(100).optional(),
    }),
    fields: z.array(taskFieldSchema).max(50).optional(),
    outcomes: z.array(taskOutcomeSchema).max(10).optional(),
    /** `amount` is a template for a number of `unit`s from when the task opens. */
    due: z.strictObject({ amount: z.string(), unit: z.enum(TASK_DUE_UNITS) }).optional(),
  }),
})

/**
 * The global error handler: never connected to the start trigger. When the run fails, the blocks connected after it
 * run, reading `{{ <name>.data }}` = `{ block, code, message }`. The run still ends `failed`; a Response block in
 * the handler answers a sync webhook instead of the default 500.
 */
export const errorTriggerBlockSchema = z.strictObject({
  ...named,
  type: z.literal('errorTrigger'),
})

export const blockSchema = z.discriminatedUnion('type', [
  startTriggerBlockSchema,
  codeBlockSchema,
  resourceQueryBlockSchema,
  branchBlockSchema,
  filterBlockSchema,
  responseBlockSchema,
  loopBlockSchema,
  functionBlockSchema,
  workflowBlockSchema,
  waitBlockSchema,
  userTaskBlockSchema,
  errorTriggerBlockSchema,
])

export const edgeSchema = z.strictObject({
  from: blockNameSchema,
  port: portSchema,
  to: blockNameSchema,
})

export const workflowSettingsSchema = z.strictObject({
  /** Whole-run limit. Time spent waiting (M5) doesn't count. */
  timeoutMs: z.number().int().min(1000).max(MAX_RUN_TIMEOUT_MS).optional(),
})

export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export const DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS = 30_000
export const MAX_WEBHOOK_SYNC_TIMEOUT_MS = 5 * 60_000
export const MIN_SCHEDULE_INTERVAL_MS = 60_000

/**
 * The live release's webhook: `/api/v1/workflows/<slug>/webhook`, plus `/api/v1/hooks/<alias>` when an alias is
 * set. Values people type (the alias) are checked by the validator rather than the schema, so a draft with a
 * half-typed one still saves.
 */
export const webhookTriggerSchema = z.strictObject({
  enabled: z.boolean(),
  /** Path segments separated by `/`; a segment `:name` captures `startTrigger.pathParams.name`. */
  alias: z.string().max(200).optional(),
  /** Defaults to `['POST']`. */
  methods: z.array(z.enum(WEBHOOK_METHODS)).min(1).max(WEBHOOK_METHODS.length).optional(),
  /** How long a call waits for the Response block before answering `202 { runId }`. Default 30 s. */
  syncTimeoutMs: z.number().int().min(0).max(MAX_WEBHOOK_SYNC_TIMEOUT_MS).optional(),
})

/**
 * A schedule of the live release: a cron expression on a time zone's wall clock, or a fixed interval (exactly one,
 * checked by the validator). Runs start in `environment` (default: the default environment).
 */
export const scheduleTriggerSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Use lowercase letters, digits, - or _'),
  enabled: z.boolean(),
  cron: z.string().max(200).optional(),
  intervalMs: z.number().int().positive().optional(),
  /** IANA zone for cron schedules; defaults to Europe/Amsterdam. */
  timezone: z.string().max(64).optional(),
  /**
   * When the previous run of this schedule is still going: `skip` this fire (default), `queue` it to start when the
   * previous one ends, or `allow` both to run at once.
   */
  overlap: z.enum(['skip', 'queue', 'allow']).optional(),
  /** Environment slug. */
  environment: z.string().max(63).optional(),
})

export const triggersSchema = z.strictObject({
  webhook: webhookTriggerSchema.optional(),
  schedules: z.array(scheduleTriggerSchema).max(20).optional(),
})

export const layoutSchema = z.strictObject({
  blocks: z.record(blockNameSchema, z.strictObject({ x: z.number(), y: z.number() })).optional(),
})

/**
 * A reusable subflow, called from a Function block, a Loop's function runner, or `await name({ ... })` in code.
 * Its blocks read the arguments as `{{ params.<name> }}`; every block nothing connects into starts the function.
 * Block names are local to the function. It returns the data of its `returns` block (by default the only block
 * nothing follows). Function calls aren't checkpointed: they belong to the block that calls them.
 */
export const functionSchema = z.strictObject({
  name: identifierSchema,
  description: z.string().max(2000).optional(),
  params: z
    .array(
      z.strictObject({
        name: identifierSchema,
        description: z.string().max(500).optional(),
        /** Used when the function is tested on its own in the editor. */
        testValue: z.json().optional(),
      }),
    )
    .max(20)
    .optional(),
  blocks: z.array(blockSchema).max(200),
  edges: z.array(edgeSchema).max(1000),
  returns: blockNameSchema.optional(),
  layout: layoutSchema.optional(),
})

export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  settings: workflowSettingsSchema.optional(),
  triggers: triggersSchema.optional(),
  blocks: z.array(blockSchema).max(500),
  edges: z.array(edgeSchema).max(2000),
  functions: z.array(functionSchema).max(50).optional(),
  /** Canvas positions. Excluded from `definitionHash`, so moving blocks around isn't a change. */
  layout: layoutSchema.optional(),
})

export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>
export type Block = z.output<typeof blockSchema>
export type BlockType = Block['type']
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>
export type Edge = z.output<typeof edgeSchema>
export type BlockSettings = z.output<typeof blockSettingsSchema>
export type RetrySettings = z.output<typeof retrySettingsSchema>
export type WebhookTrigger = z.output<typeof webhookTriggerSchema>
export type ScheduleTrigger = z.output<typeof scheduleTriggerSchema>
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number]
export type FunctionDefinition = z.output<typeof functionSchema>
export type LoopRunner = z.output<typeof loopRunnerSchema>
export type LoopMode = (typeof LOOP_MODES)[number]
export type WaitUnit = (typeof WAIT_UNITS)[number]

export interface ResolvedBlockSettings {
  timeoutMs: number
  retry: Required<RetrySettings>
  finally: 'stop' | 'continue'
}

export const DEFAULT_BLOCK_SETTINGS: ResolvedBlockSettings = {
  timeoutMs: 10_000,
  retry: { count: 0, intervalMs: 1000, exponential: false, coefficient: 2, maxIntervalMs: 60_000 },
  finally: 'stop',
}

/**
 * Blocks that do a lot by default get more time: a loop or a wait is bounded by the run timeout, and a function or
 * child workflow call by the default run timeout. Everything else gets 10 s.
 */
const DEFAULT_TIMEOUT_MS: Partial<Record<BlockType, number>> = {
  loop: MAX_RUN_TIMEOUT_MS,
  wait: MAX_RUN_TIMEOUT_MS,
  userTask: MAX_RUN_TIMEOUT_MS,
  function: DEFAULT_RUN_TIMEOUT_MS,
  workflow: DEFAULT_RUN_TIMEOUT_MS,
}

/** A block's settings with every default filled in. Triggers run nothing, so they get the defaults. */
export function resolveBlockSettings(block: Block): ResolvedBlockSettings {
  const s: BlockSettings | undefined = 'settings' in block ? block.settings : undefined
  return {
    timeoutMs: s?.timeoutMs ?? DEFAULT_TIMEOUT_MS[block.type] ?? DEFAULT_BLOCK_SETTINGS.timeoutMs,
    retry: { ...DEFAULT_BLOCK_SETTINGS.retry, ...stripUndefined(s?.retry ?? {}) },
    finally: s?.finally ?? DEFAULT_BLOCK_SETTINGS.finally,
  }
}

/** A loop iteration's limit and retries: `config.iteration`, with the block defaults. */
export function resolveIterationSettings(
  block: BlockOf<'loop'>,
): Pick<ResolvedBlockSettings, 'timeoutMs' | 'retry'> {
  const it = block.config.iteration
  return {
    timeoutMs: it?.timeoutMs ?? DEFAULT_BLOCK_SETTINGS.timeoutMs,
    retry: { ...DEFAULT_BLOCK_SETTINGS.retry, ...stripUndefined(it?.retry ?? {}) },
  }
}

/** The output ports a block exposes. `error` exists only when the block continues on failure. */
export function blockPorts(block: Block): string[] {
  const ports =
    block.type === 'branch' ? [...block.config.conditions.map((c) => `cond:${c.id}`), 'else'] : ['out']
  if ('settings' in block && block.settings?.finally === 'continue') ports.push('error')
  return ports
}

/** The blocks that start a run: the start trigger, and the error handler when the run fails. */
export function isTrigger(block: Block): block is BlockOf<'startTrigger' | 'errorTrigger'> {
  return block.type === 'startTrigger' || block.type === 'errorTrigger'
}

/**
 * Blocks that park the run as `waiting` (a Wait, a User Task, or a sync child workflow). Functions can't contain them, since a
 * function call isn't checkpointed.
 */
export function suspends(block: Block): boolean {
  if (block.type === 'wait' || block.type === 'userTask') return true
  if (block.type === 'workflow') return (block.config.mode ?? 'sync') === 'sync'
  if (block.type === 'loop' && block.config.runner.kind === 'workflow') {
    return (block.config.runner.mode ?? 'sync') === 'sync'
  }
  return false
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export type TaskField = z.output<typeof taskFieldSchema>
export type TaskOutcome = z.output<typeof taskOutcomeSchema>
