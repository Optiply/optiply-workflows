import { z } from 'zod'

/**
 * The stored shape of a workflow: what the editor autosaves as the draft and what a release freezes.
 *
 * Built for Git: block **names** are the identity (`{{ query1.data }}` reads a block by name), resources are
 * referenced by slug, the canvas layout is kept apart from the logic, and nothing secret ever appears here.
 * Optional settings are stored sparsely; `resolveBlockSettings` fills in the defaults at run time.
 *
 * M2 covers the headless block types. Loop, Function, Workflow, Wait, User Task and the global error handler
 * arrive in M5; webhook aliases and schedule parsing are completed in M4.
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

/** Same rule as resource slugs in the resources API. */
export const resourceSlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,62}$/,
    'Use 2–63 lowercase letters, digits or underscores, starting with a letter',
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

const named = {
  name: blockNameSchema,
  description: z.string().max(2000).optional(),
}
const executable = { ...named, settings: blockSettingsSchema.optional() }

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

export const codeBlockSchema = z.strictObject({
  ...executable,
  type: z.literal('code'),
  config: z.strictObject({
    /** JavaScript run as an async function body: may `await`, and `return`s the block's data. */
    code: z.string(),
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

export const blockSchema = z.discriminatedUnion('type', [
  startTriggerBlockSchema,
  codeBlockSchema,
  resourceQueryBlockSchema,
  branchBlockSchema,
  filterBlockSchema,
  responseBlockSchema,
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

/** First cut; M4 adds webhook aliases with `:params`, cron parsing and per-trigger options. */
export const triggersSchema = z.strictObject({
  webhook: z.strictObject({ enabled: z.boolean() }).optional(),
  schedules: z
    .array(
      z
        .strictObject({
          name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Use lowercase letters, digits, - or _'),
          enabled: z.boolean(),
          cron: z.string().optional(),
          intervalMs: z.number().int().min(60_000).optional(),
          /** IANA zone; defaults to Europe/Amsterdam. */
          timezone: z.string().optional(),
          overlap: z.enum(['skip', 'queue', 'allow']).optional(),
        })
        .refine((s) => (s.cron === undefined) !== (s.intervalMs === undefined), {
          message: 'Set either cron or intervalMs',
        }),
    )
    .max(20)
    .optional(),
})

export const layoutSchema = z.strictObject({
  blocks: z.record(blockNameSchema, z.strictObject({ x: z.number(), y: z.number() })).optional(),
})

export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  settings: workflowSettingsSchema.optional(),
  triggers: triggersSchema.optional(),
  blocks: z.array(blockSchema).max(500),
  edges: z.array(edgeSchema).max(2000),
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

/** A block's settings with every default filled in. The start trigger runs nothing, so it gets the defaults. */
export function resolveBlockSettings(block: Block): ResolvedBlockSettings {
  const s = block.type === 'startTrigger' ? undefined : block.settings
  return {
    timeoutMs: s?.timeoutMs ?? DEFAULT_BLOCK_SETTINGS.timeoutMs,
    retry: { ...DEFAULT_BLOCK_SETTINGS.retry, ...stripUndefined(s?.retry ?? {}) },
    finally: s?.finally ?? DEFAULT_BLOCK_SETTINGS.finally,
  }
}

/** The output ports a block exposes. `error` exists only when the block continues on failure. */
export function blockPorts(block: Block): string[] {
  const ports =
    block.type === 'branch' ? [...block.config.conditions.map((c) => `cond:${c.id}`), 'else'] : ['out']
  if (block.type !== 'startTrigger' && block.settings?.finally === 'continue') ports.push('error')
  return ports
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
