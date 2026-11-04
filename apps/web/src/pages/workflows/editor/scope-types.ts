import type { Block, FunctionDefinition, QueueTriggerKind } from '@ow/definition'

/** What the last run produced for a block, if anything. */
export interface SampleResult {
  data: unknown
  status: string
}

const MAX_DEPTH = 6
const MAX_KEYS = 100
const SAMPLE_ITEMS = 20
/** How many `$ref`s one schema's type may expand. */
const MAX_REFS = 20

/** A TypeScript type for a JSON value. Array items are merged, so keys missing from some items become optional. */
export function typeOf(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return 'unknown'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      break
    default:
      return 'unknown'
  }
  if (Array.isArray(value)) {
    if (!value.length) return 'unknown[]'
    const items = value.slice(0, SAMPLE_ITEMS)
    const objects = items.filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
    )
    const others = items.filter((v) => !(v && typeof v === 'object' && !Array.isArray(v)))
    const types = new Set(others.map((v) => typeOf(v, depth + 1)))
    if (objects.length) types.add(mergedObjectType(objects, depth + 1))
    const union = [...types].join(' | ')
    return types.size > 1 ? `(${union})[]` : `${union}[]`
  }
  return mergedObjectType([value as Record<string, unknown>], depth)
}

function mergedObjectType(objects: Record<string, unknown>[], depth: number): string {
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].slice(0, MAX_KEYS)
  if (!keys.length) return 'Record<string, unknown>'
  const fields = keys.map((key) => {
    const present = objects.filter((o) => key in o)
    const types = [...new Set(present.map((o) => typeOf(o[key], depth + 1)))]
    const optional = present.length < objects.length ? '?' : ''
    return `${propertyName(key)}${optional}: ${types.join(' | ')}`
  })
  return `{ ${fields.join('; ')} }`
}

function propertyName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

type JsonSchema = Record<string, unknown>

const isSchema = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A TypeScript type for a JSON Schema (a webhook's body schema), so completions follow the declared contract:
 * types, `enum`/`const` as literal unions, `properties` with `required`, `items`, `anyOf`/`oneOf`/`allOf`, local
 * `$ref`s (`#/$defs/…`) and descriptions as doc comments. Anything else is `unknown`.
 */
export function schemaType(
  schema: unknown,
  root: unknown = schema,
  depth = 0,
  budget = { refs: MAX_REFS },
): string {
  if (schema === false) return 'never'
  if (!isSchema(schema) || depth > MAX_DEPTH) return 'unknown'
  if (typeof schema.$ref === 'string') {
    // Each $ref is expanded in place: a budget keeps a schema that refers to itself several times from growing
    // exponentially (8 self-references 6 deep would be millions of types).
    if (budget.refs-- <= 0) return 'unknown'
    const target = resolveRef(root, schema.$ref)
    return target === undefined ? 'unknown' : schemaType(target, root, depth + 1, budget)
  }
  if ('const' in schema) return literal(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.length ? schema.enum.map(literal).join(' | ') : 'never'
  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined
  if (Array.isArray(union) && union.length) {
    return [...new Set(union.map((s) => group(schemaType(s, root, depth + 1, budget))))].join(' | ')
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map((s) => group(schemaType(s, root, depth + 1, budget))).join(' & ')
  }
  const declared = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const types = declared.length
    ? declared
    : schema.properties
      ? ['object']
      : schema.items || schema.prefixItems
        ? ['array']
        : []
  if (!types.length) return 'unknown'
  return [...new Set(types.map((t) => typeForType(String(t), schema, root, depth, budget)))].join(' | ')
}

function typeForType(
  type: string,
  schema: JsonSchema,
  root: unknown,
  depth: number,
  budget: { refs: number },
): string {
  switch (type) {
    case 'string':
    case 'boolean':
    case 'null':
      return type
    case 'number':
    case 'integer':
      return 'number'
    case 'array': {
      if (Array.isArray(schema.prefixItems)) {
        return `[${schema.prefixItems.map((s) => schemaType(s, root, depth + 1, budget)).join(', ')}]`
      }
      return schema.items === undefined
        ? 'unknown[]'
        : `${group(schemaType(schema.items, root, depth + 1, budget))}[]`
    }
    case 'object': {
      const properties = isSchema(schema.properties)
        ? Object.entries(schema.properties).slice(0, MAX_KEYS)
        : []
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
      const extra = schema.additionalProperties
      if (!properties.length) {
        return isSchema(extra)
          ? `Record<string, ${schemaType(extra, root, depth + 1, budget)}>`
          : 'Record<string, unknown>'
      }
      const fields = properties.map(([key, value]) => {
        const doc =
          isSchema(value) && typeof value.description === 'string' ? `${docComment(value.description)} ` : ''
        return `${doc}${propertyName(key)}${required.has(key) ? '' : '?'}: ${schemaType(value, root, depth + 1, budget)}`
      })
      // Other keys are allowed unless the schema says otherwise.
      if (extra !== false) fields.push('[key: string]: unknown')
      return `{ ${fields.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

/** A JSON Pointer inside the schema (`#/$defs/line`); remote references aren't followed. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined
  let node = root
  for (const raw of ref.slice(1).split('/').slice(1)) {
    let key: string
    try {
      key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    } catch {
      return undefined // A `%` that isn't an escape: no such pointer.
    }
    if (!isSchema(node) && !Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

function literal(value: unknown): string {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? JSON.stringify(value)
    : 'unknown'
}

/**
 * Parenthesizes a type with a `|` or `&` at its top level (not inside braces, brackets, parentheses, strings or doc
 * comments).
 */
function group(type: string): string {
  let depth = 0
  let quote = false
  for (let i = 0; i < type.length; i++) {
    const c = type[i]!
    if (!quote && type.startsWith('/*', i)) {
      // A property's doc comment: any quotes or bars in it aren't type syntax.
      const end = type.indexOf('*/', i + 2)
      i = end < 0 ? type.length : end + 1
      continue
    }
    if (quote) {
      if (c === '\\') i++
      else if (c === '"') quote = false
    } else if (c === '"') quote = true
    else if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c)) depth--
    else if (depth === 0 && (c === '|' || c === '&')) return `(${type})`
  }
  return type
}

function docComment(text: string): string {
  return `/** ${text.replaceAll('*/', '* /').replace(/\s+/g, ' ').trim()} */`
}

/** The `sql` helpers, for workflows and apps alike. */
export const SQL_HELPERS = `
/** For SQL queries: a sort column and direction, and a table's filters, chosen at run time, from a list written in the query. */
declare const sql: {
  /**
   * One of \`columns\` (or \`fallback\` when \`value\` is empty), quoted into the SQL as a column name:
   * \`ORDER BY {{ sql.column(table1.sort?.column, ['name', 'price'], 'id') }}\`. Must be the whole {{ }}, with the
   * columns written as strings; the server checks the value against them.
   */
  column(value: any, columns: string[], fallback?: string): string
  /** \`DESC\` for true or "desc", \`ASC\` for false, "asc" or nothing: \`{{ sql.direction(table1.sort?.desc) }}\`. */
  direction(value: any): 'ASC' | 'DESC'
  /**
   * A table's filters as a condition, each value bound: \`WHERE {{ sql.where(table1.filters, ['name', 'total']) }}\`
   * (\`TRUE\` without filters). Must be the whole {{ }}, with the columns written as strings; the server checks each
   * filter's column against them.
   */
  where(filters: any, columns: string[]): { column: string; op: string; value?: any; type?: string }[]
}
`

const GLOBALS = `
/** Lodash. */
declare const _: any
/** Day.js, with the utc, timezone, customParseFormat and relativeTime plugins. */
declare const dayjs: any
${SQL_HELPERS}
/** Config vars for the run's environment (secret ones only in released runs). */
declare const configVars: Record<string, string>
declare const workflowContext: { runId: string; workflowId: string; environment: string; triggerType: string }
/** The caller's Idempotency-Key, or the run id. */
declare const idempotencyKey: string
/** In a filter condition or a loop: the current item. */
declare const value: any
/** In a filter condition or a loop: the current item's index. */
declare const index: number
interface OwBlockError { code: string; message: string; details?: unknown }
/** A Pub/Sub trigger's message (runs a Pub/Sub trigger started); its data is \`startTrigger.data\`. */
interface OwPubSubMessage {
  messageId: string; publishTime: string; attributes: Record<string, string>; orderingKey?: string
  /** Pub/Sub's count, on subscriptions with a dead-letter policy. */
  deliveryAttempt?: number
  subscription: string
  /** The data's bytes, for binary payloads. */
  dataBase64: string
  /** \`startTrigger.data\` is the bytes in base64: they weren't text. */
  encoding?: 'base64'
}
/** An SQS trigger's message (runs an SQS trigger started); its body is \`startTrigger.data\`. */
interface OwSqsMessage {
  messageId: string
  /** The queue's URL. */
  queue: string
  /** SQS's own attributes (SentTimestamp, ApproximateReceiveCount, …). */
  attributes: Record<string, string>
  /** The sender's message attributes, as text. */
  messageAttributes: Record<string, string>
  /** How many times SQS has handed it out, counting this one. */
  receiveCount: number
  sentAt: string
  groupId?: string; deduplicationId?: string; sequenceNumber?: string
}
/** A Kafka trigger's message (runs a Kafka trigger started); its value is \`startTrigger.data\`. */
interface OwKafkaMessage {
  topic: string; partition: number; offset: string
  key: string | null
  headers: Record<string, string>
  timestamp: string
  /** This run's attempt at the message, counting from 1. */
  attempt: number
  groupId: string
  /** The Schema Registry schema the value was decoded with. */
  schemaId?: number
  /** Why a value in the registry's wire format couldn't be decoded. */
  schemaError?: string
  /** \`startTrigger.data\` is the bytes in base64: they weren't text. */
  encoding?: 'base64'
}
interface OwKinesisMessage {
  stream: string; shardId: string; sequenceNumber: string; partitionKey: string; arrivedAt: string
  /** This run's attempt at the record, counting from 1. */
  attempt: number
  /** \`startTrigger.data\` is the bytes in base64: they weren't text. */
  encoding?: 'base64'
}
interface OwRabbitMessage {
  queue: string
  /** Empty: the default exchange (the routing key is then the queue). */
  exchange: string; routingKey: string
  /** Delivered before and not acked (a lost connection, another worker). */
  redelivered: boolean
  headers: Record<string, any>
  messageId?: string; contentType?: string; correlationId?: string; timestamp?: string
  /** \`startTrigger.data\` is the bytes in base64: they weren't text. */
  encoding?: 'base64'
}
interface OwResponse {
  ok: boolean; status: number; statusText: string; url: string; redirected: boolean
  headers: { get(name: string): string | null; has(name: string): boolean }
  text(): Promise<string>; json(): Promise<any>
}
/** An HTTP request (code only). The body must be a string; private and internal addresses are refused. */
declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string> | [string, string][]; body?: string }): Promise<OwResponse>
`

/** An AI query's metadata (M35): who answered, the tokens and the cost. */
const AI_METADATA =
  'provider: string; model: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }; costUsd: number | null; stopReason: string; durationMs: number;'

/**
 * What an AI query's data is (M35), from its action: text, the extract schema's type, the classify labels, the
 * agent's answer and steps. Undefined when the action isn't one of them.
 */
export function aiDataType(query: unknown): string | undefined {
  if (!query || typeof query !== 'object') return undefined
  const q = query as Record<string, unknown>
  switch (q.action) {
    case 'generate':
    case 'summarize':
      return 'string'
    case 'extract': {
      let schema = q.schema
      if (typeof schema === 'string') {
        try {
          schema = JSON.parse(schema)
        } catch {
          return 'unknown'
        }
      }
      return schemaType(schema)
    }
    case 'classify': {
      const list = Array.isArray(q.labels)
        ? q.labels
        : typeof q.labels === 'string'
          ? q.labels.split(',')
          : []
      const labels = [...new Set(list.map((l) => String(l).trim()).filter((l) => l && !l.includes('{{')))]
      const label = labels.length ? labels.map(literal).join(' | ') : 'string'
      const several = q.multiple === true || q.multiple === 'true'
      return several ? `{ labels: (${label})[]; reason: string }` : `{ label: ${label}; reason: string }`
    }
    case 'agent':
      return '{ answer: string; steps: { workflow: string; input: unknown; runId: string | null; ok: boolean }[] }'
    default:
      return undefined
  }
}

/**
 * Declarations for every block's result in the open graph, typed from the last run where there is one, so
 * `query1.data[0].` completes in code. Also declares the workflow's functions (`await name(...)`) and, inside a
 * function, its `params`. Returns plain sample values for `{{ }}` completions outside JavaScript too.
 */
export function scopeDeclarations(
  blocks: readonly Block[],
  samples: Record<string, SampleResult>,
  functions: readonly FunctionDefinition[] = [],
  inFunction?: FunctionDefinition,
  /** The webhook's body schema: when there is one, `startTrigger.data` is typed from it rather than a run. */
  bodySchema?: Record<string, unknown>,
  /** The workflow's queue trigger kinds: `startTrigger.message` is their messages' type (Pub/Sub's without any). */
  queues: readonly QueueTriggerKind[] = [],
  /** Slugs of the AI resources (M35): their queries' data is typed from the action. */
  aiResources: ReadonlySet<string> = new Set(),
): { dts: string; sample: Record<string, unknown> } {
  const MESSAGE_TYPES = {
    pubsub: 'OwPubSubMessage',
    sqs: 'OwSqsMessage',
    kafka: 'OwKafkaMessage',
    rabbitmq: 'OwRabbitMessage',
    kinesis: 'OwKinesisMessage',
  } as const
  const messageType = queues.length ? queues.map((k) => MESSAGE_TYPES[k]).join(' | ') : 'OwPubSubMessage'
  const lines = [GLOBALS]
  for (const fn of functions) {
    const args = (fn.params ?? []).map((p) => `${p.name}?: any`).join(', ')
    lines.push(`/** Calls the ${fn.name} function. */\ndeclare function ${fn.name}(${args}): Promise<any>`)
  }
  if (inFunction) {
    const params = (inFunction.params ?? []).map((p) => `${p.name}: any`).join('; ')
    lines.push(`/** The arguments this function was called with. */\ndeclare const params: { ${params} }`)
  }
  const sample: Record<string, unknown> = {
    _: {},
    dayjs: {},
    sql: {},
    configVars: {},
    workflowContext: { runId: '', workflowId: '', environment: '', triggerType: '' },
    idempotencyKey: '',
  }
  if (inFunction) {
    sample.params = Object.fromEntries((inFunction.params ?? []).map((p) => [p.name, p.testValue ?? null]))
  }
  for (const block of blocks) {
    // Function blocks have no run samples (function calls aren't recorded per block).
    const result = inFunction ? undefined : samples[block.name]
    const ai =
      block.type === 'resourceQuery' && aiResources.has(block.config.resource)
        ? aiDataType(block.config.query)
        : undefined
    const data =
      block.type === 'startTrigger' && bodySchema
        ? schemaType(bodySchema)
        : ai
          ? ai
          : result
            ? typeOf(result.data)
            : 'unknown'
    const extra =
      block.type === 'startTrigger'
        ? ` headers: Record<string, string>; pathParams: Record<string, string>; urlParams: Record<string, string>; message?: ${messageType};`
        : ''
    lines.push(
      `declare const ${block.name}: { data: ${data}; error: OwBlockError | null; metadata: { status: string; ${ai ? AI_METADATA : ''} [key: string]: unknown };${extra} }`,
    )
    sample[block.name] = {
      data: result?.data ?? null,
      error: null,
      metadata: { status: result?.status ?? '' },
    }
  }
  return { dts: lines.join('\n'), sample }
}
