/**
 * How a definition maps onto a Yjs document (architecture §2.19): which arrays match their items by identity, and
 * which strings are text that merges as people type. Everything else is a value: the last writer wins.
 */

/** Where a value sits in the definition: object keys and array indexes from the root. */
export type Path = readonly (string | number)[]

/** An array item's identity, kept from one edit to the next; `undefined` matches nothing. */
export type Identity = (item: unknown) => string | undefined

export interface CollabSpec {
  /** How the items of the array at `path` are matched across edits; by position (and content) when `undefined`. */
  identity(path: Path): Identity | undefined
  /** Whether a string at `path` is text (a `Y.Text`, merged character by character) rather than a value. */
  isText(path: Path): boolean
  /**
   * Whether the object at `path` is one value (last writer wins on the whole) rather than a `Y.Map` merged key by key:
   * for objects whose fields must agree with each other, like a grid position's `x + w`.
   */
  isAtomic(path: Path): boolean
}

/**
 * A spec from path patterns: dot-separated keys, `*` standing for any one key or index (`blocks.*.config.code`).
 */
export function defineSpec(rules: {
  identity: readonly (readonly [pattern: string, identity: Identity])[]
  text: readonly string[]
  atomic?: readonly string[]
}): CollabSpec {
  const identity = rules.identity.map(([pattern, id]) => [pattern.split('.'), id] as const)
  const text = rules.text.map((pattern) => pattern.split('.'))
  const atomic = (rules.atomic ?? []).map((pattern) => pattern.split('.'))
  return {
    identity: (path) => identity.find(([pattern]) => matches(pattern, path))?.[1],
    isText: (path) => text.some((pattern) => matches(pattern, path)),
    isAtomic: (path) => atomic.some((pattern) => matches(pattern, path)),
  }
}

function matches(pattern: readonly string[], path: Path): boolean {
  return pattern.length === path.length && pattern.every((p, i) => p === '*' || p === String(path[i]))
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const field =
  (key: string): Identity =>
  (item) => {
    const v = isRecord(item) ? item[key] : undefined
    return typeof v === 'string' ? v : undefined
  }

export const byName = field('name')
export const byId = field('id')

/** An edge is its two ends and the port between them; there is one edge per such triple. */
export const byEdge: Identity = (item) =>
  isRecord(item) &&
  typeof item.from === 'string' &&
  typeof item.port === 'string' &&
  typeof item.to === 'string'
    ? `${item.from} ${item.port} ${item.to}`
    : undefined

/** Block-relative patterns, for a workflow's blocks and each function's. */
const blockPatterns = (patterns: readonly string[]) =>
  patterns.flatMap((p) => [`blocks.*.${p}`, `functions.*.blocks.*.${p}`])

/** The connector query fields shown in Monaco: SQL, a REST call's JSON body, a Pub/Sub publish's messages. */
const queryText = ['query.sql', 'query.body.json', 'query.messages']

/**
 * Workflows: blocks and functions by name, edges by their ends, conditions and task outcomes by id. Text is every
 * string the inspectors show in a code field (code, SQL, templates and expressions); names, types, slugs, modes and
 * the rest are values, and so are canvas positions, whole.
 */
export const workflowSpec: CollabSpec = defineSpec({
  identity: [
    ['blocks', byName],
    ['edges', byEdge],
    ['functions', byName],
    ['functions.*.blocks', byName],
    ['functions.*.edges', byEdge],
    ['functions.*.params', byName],
    ['triggers.schedules', byName],
    ['triggers.pubsub', byName],
    ...blockPatterns(['config.conditions']).map((p) => [p, byId] as const),
    ...blockPatterns(['config.fields']).map((p) => [p, byName] as const),
    ...blockPatterns(['config.outcomes']).map((p) => [p, byId] as const),
  ],
  text: blockPatterns([
    'config.code',
    ...queryText.map((q) => `config.${q}`),
    'config.conditions.*.expression',
    'config.input',
    'config.condition',
    'config.body',
    'config.params.*',
    'config.amount',
    'config.until',
    'config.title',
    'config.description',
    'config.runner.code',
    ...queryText.map((q) => `config.runner.${q}`),
    'config.runner.input',
    'config.runner.params.*',
  ]),
  atomic: ['layout.blocks.*', 'functions.*.layout.blocks.*'],
})

/** An event handler's templates and script, for components' handlers and queries'. */
const handlerText = ['onlyIf', 'action.code', 'action.value', 'action.message', 'action.url', 'action.args.*']

/**
 * Apps (and modules): pages, components, queries, transformers, variables and a module's parts by name, event
 * handlers by id. Text is every string the editor shows in a code field: props, templates, SQL and code. Grid
 * positions are values, whole (`x + w` must fit the grid).
 */
export const appSpec: CollabSpec = defineSpec({
  identity: [
    ['pages', byName],
    ['components', byName],
    ['queries', byName],
    ['transformers', byName],
    ['variables', byName],
    ['components.*.events', byId],
    ['queries.*.events', byId],
    ['module.inputs', byName],
    ['module.outputs', byName],
    ['module.events', byName],
  ],
  text: [
    'components.*.props.*',
    ...handlerText.flatMap((h) => [`components.*.events.*.${h}`, `queries.*.events.*.${h}`]),
    'queries.*.code',
    'queries.*.confirm',
    'queries.*.disabled',
    'queries.*.transform',
    'queries.*.query.sql',
    'queries.*.params.*',
    'transformers.*.code',
    'variables.*.initialValue',
    'module.outputs.*.value',
  ],
  atomic: ['layout.*'],
})
