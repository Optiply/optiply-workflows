import {
  blockNameSchema,
  conditionIdSchema,
  libraryVersionSchema,
  resourceSlugSchema,
  workflowSlugSchema,
} from '@ow/definition'
import { z } from 'zod'

/**
 * The stored shape of an app: what the editor autosaves as the draft and what a release freezes.
 *
 * Like a workflow definition, it is built for Git: every component, query, transformer and variable has a **name**
 * that is a JS identifier and its identity (`{{ table1.selectedRow }}`), they share one namespace, resources are
 * referenced by slug, the grid layout is kept apart from the logic, and nothing secret appears here.
 *
 * Values are JSON; **every string is a template** (`"Hello {{ user.name }}"`), so a property, a query field or a
 * variable's initial value can hold a constant or an expression alike. Which props a component has, and their
 * types, come from the component registry (`components.ts`); the validator checks them, the schema doesn't, so a
 * half-edited draft still saves.
 */

export const APP_SCHEMA_VERSION = 1

/** Columns of the layout grid. */
export const GRID_COLUMNS = 12

/** Components, queries, transformers and variables are all named like workflow blocks. */
export const appNameSchema = blockNameSchema

/** Event handlers have stable ids, so the editor can reorder and edit them in place. */
export const handlerIdSchema = conditionIdSchema

const MAX_ENTITIES = 1000

/** A position on the 12-column grid of the component's parent (the page, a container, a form or a modal). */
export const positionSchema = z
  .strictObject({
    x: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(100_000),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(1000),
  })
  .refine((p) => p.x + p.w <= GRID_COLUMNS, { message: `Must fit in ${GRID_COLUMNS} columns` })

/** What an event handler does. String fields are templates unless noted. */
export const handlerActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('controlQuery'),
    query: appNameSchema,
    method: z.enum(['trigger', 'reset']),
  }),
  z.strictObject({
    type: z.literal('controlComponent'),
    component: appNameSchema,
    /** One of the component type's methods (`setValue`, `open`, `clearChangeset`, …). */
    method: z.string().max(64),
    /** Arguments by position, each a template. */
    args: z.array(z.string()).max(10).optional(),
  }),
  z.strictObject({
    type: z.literal('setVariable'),
    variable: appNameSchema,
    value: z.string(),
  }),
  z.strictObject({
    type: z.literal('runScript'),
    /** JavaScript run as an async function body, with the same scope as a JS query. */
    code: z.string(),
  }),
  z.strictObject({
    type: z.literal('notify'),
    message: z.string(),
    tone: z.enum(['info', 'success', 'error']).optional(),
  }),
  z.strictObject({
    type: z.literal('openUrl'),
    url: z.string(),
    newTab: z.boolean().optional(),
  }),
  z.strictObject({
    /** In a module (M14): fires one of the module's events in the app it's placed in. */
    type: z.literal('moduleEvent'),
    event: appNameSchema,
  }),
])

export const eventHandlerSchema = z.strictObject({
  id: handlerIdSchema,
  /** One of the owner's events: a component type's (`click`, `change`, `save`, …), or `success`/`failure`. */
  event: z.string().max(64),
  action: handlerActionSchema,
  /** A template; the handler runs only when it is truthy. */
  onlyIf: z.string().optional(),
  debounceMs: z.number().int().min(0).max(60_000).optional(),
})

const handlersSchema = z.array(eventHandlerSchema).max(50)

export const componentSchema = z.strictObject({
  name: appNameSchema,
  /** A component type from the registry (`table`, `textInput`, …). */
  type: z.string().max(64),
  /** The container, form or modal this component sits in; on the page when missing. */
  parent: appNameSchema.optional(),
  /**
   * The page a top-level component is on; on every page when missing (the app's frame, above each page). A
   * component inside another is on its container's page.
   */
  page: appNameSchema.optional(),
  /**
   * Where it sits in its parent (M24): inside a container, one of its views (by name) or its `header` or `footer`;
   * at the top, the app frame's `sidebar` (or `header`, the default). Missing: the parent's body (a container's
   * first view when it has views). See `slotOf`.
   */
  slot: appNameSchema.optional(),
  /** Prop values by prop name, sparse: a missing prop takes the registry's default. */
  props: z.record(z.string().max(64), z.json()).optional(),
  events: handlersSchema.optional(),
})

const queryCommon = {
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  /** The page the query belongs to: automatic, it runs only while that page is open. Global when missing. */
  page: appNameSchema.optional(),
  /** A template asking the user to confirm before each run; no prompt when missing. */
  confirm: z.string().optional(),
  /** A template; while truthy, the query doesn't run. */
  disabled: z.string().optional(),
  /** Run once when the app opens (automatic queries always do). */
  runOnLoad: z.boolean().optional(),
  /**
   * JavaScript run synchronously on each result, as a function body with `data` in scope; its return value
   * becomes the query's `data`.
   */
  transform: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  /** Handlers for `success` and `failure`. */
  events: handlersSchema.optional(),
}

export const resourceAppQuerySchema = z.strictObject({
  ...queryCommon,
  kind: z.literal('resource'),
  resource: resourceSlugSchema,
  /** The connector's query (`{ sql }` for SQL resources); every string is a template. */
  query: z.record(z.string(), z.json()),
  /**
   * `auto` runs on load and whenever a value it reads changes (for reads); `manual` only when something
   * triggers it (for writes).
   */
  run: z.enum(['auto', 'manual']),
})

export const jsAppQuerySchema = z.strictObject({
  ...queryCommon,
  kind: z.literal('js'),
  /** JavaScript run in the browser as an async function body; may trigger queries and call component methods. */
  code: z.string(),
})

export { libraryVersionSchema }

/**
 * A query from the Query Library (M14): the library query's own resource and query run on the server; the app
 * passes its parameters, each a template evaluated like a resource query's `{{ }}`s (in the browser, or on the
 * server for `current_user`).
 */
export const libraryAppQuerySchema = z.strictObject({
  ...queryCommon,
  kind: z.literal('library'),
  /** The library query's slug. */
  library: workflowSlugSchema,
  version: libraryVersionSchema,
  /** Values by parameter name; a parameter not given is null. Strings are templates. */
  params: z.record(appNameSchema, z.json()).optional(),
  run: z.enum(['auto', 'manual']),
})

export const appQuerySchema = z.discriminatedUnion('kind', [
  resourceAppQuerySchema,
  jsAppQuerySchema,
  libraryAppQuerySchema,
])

export const transformerSchema = z.strictObject({
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  /** The page the transformer belongs to (it may read that page's components); global when missing. */
  page: appNameSchema.optional(),
  /** A pure function body, run synchronously whenever a value it reads changes; returns the transformer's value. */
  code: z.string(),
})

export const variableSchema = z.strictObject({
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  /** Evaluated once when the app opens; strings are templates. `null` when missing. */
  initialValue: z.json().optional(),
})

/**
 * A page of the app, at `/apps/<slug>/<name>`. Its components, queries and transformers name it in `page`; what
 * names no page is global: shown (components) and run (queries) on every page.
 */
export const pageSchema = z.strictObject({
  name: appNameSchema,
  /** Shown in navigation and the browser tab; plain text. The name when missing. */
  title: z.string().max(80).optional(),
})

/** An input of a module (M14): the app placing it passes a value; the module reads `inputs.<name>`. */
export const moduleInputSchema = z.strictObject({
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  /** When the app passes nothing (or null). */
  default: z.json().optional(),
  /** What the module's editor passes. Never used by apps. */
  testValue: z.json().optional(),
})

/** An output of a module: a template evaluated in the module; the app reads it as `<instance>.<name>`. */
export const moduleOutputSchema = z.strictObject({
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  value: z.string(),
})

/** An event of a module: the module fires it (`moduleEvent`), the app handles it on the instance. */
export const moduleEventSchema = z.strictObject({
  name: appNameSchema,
  description: z.string().max(2000).optional(),
})

/**
 * What makes an app definition a module (M14): a reusable piece of app with typed inputs, outputs and events,
 * placed in apps as a `module` component that runs as an isolated instance.
 */
export const moduleSpecSchema = z.strictObject({
  inputs: z.array(moduleInputSchema).max(50),
  outputs: z.array(moduleOutputSchema).max(50),
  events: z.array(moduleEventSchema).max(20),
})

/**
 * The app frame (M24, architecture §2.27): a header bar fixed at the top and/or a sidebar at the left, around every
 * page. Components on every page sit in the header (the default) or the sidebar (`slot: 'sidebar'`).
 */
export const frameSchema = z.strictObject({
  header: z.boolean().optional(),
  sidebar: z.enum(['narrow', 'medium', 'wide']).optional(),
  /** The app's name in the header (in the sidebar without a header). */
  showTitle: z.boolean().optional(),
  /** The signed-in person in the header. */
  showUser: z.boolean().optional(),
})

export const appDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(APP_SCHEMA_VERSION),
  /** In order; the first opens by default. An app without pages is one page, holding everything. */
  pages: z.array(pageSchema).max(50).optional(),
  components: z.array(componentSchema).max(MAX_ENTITIES),
  queries: z.array(appQuerySchema).max(MAX_ENTITIES),
  transformers: z.array(transformerSchema).max(MAX_ENTITIES).optional(),
  variables: z.array(variableSchema).max(MAX_ENTITIES).optional(),
  /** Grid positions by component name. Modals have none: they open over the page. */
  layout: z.record(appNameSchema, positionSchema).optional(),
  /** Present on a module's definition (M14), never on an app's. */
  module: moduleSpecSchema.optional(),
  /** A header bar and/or a sidebar around every page (M24); without it, global components sit above each page. */
  frame: frameSchema.optional(),
})

export type Position = z.infer<typeof positionSchema>
export type AppPage = z.infer<typeof pageSchema>
export type AppFrame = z.infer<typeof frameSchema>
export type HandlerAction = z.infer<typeof handlerActionSchema>
export type EventHandler = z.infer<typeof eventHandlerSchema>
export type AppComponent = z.infer<typeof componentSchema>
export type ResourceAppQuery = z.infer<typeof resourceAppQuerySchema>
export type JsAppQuery = z.infer<typeof jsAppQuerySchema>
export type LibraryAppQuery = z.infer<typeof libraryAppQuerySchema>
/** The queries the server runs: resource and library queries. */
export type ServerAppQuery = ResourceAppQuery | LibraryAppQuery
export type AppQuery = z.infer<typeof appQuerySchema>
export type Transformer = z.infer<typeof transformerSchema>
export type Variable = z.infer<typeof variableSchema>
export type AppDefinition = z.infer<typeof appDefinitionSchema>
export type ModuleInput = z.infer<typeof moduleInputSchema>
export type ModuleOutput = z.infer<typeof moduleOutputSchema>
export type ModuleSpec = z.infer<typeof moduleSpecSchema>
/** A module's definition: an app definition with its `module` part (and no pages). */
export type ModuleDefinition = AppDefinition & { module: ModuleSpec }

/** A new, empty module. */
export function emptyModule(): ModuleDefinition {
  return { ...emptyApp(), module: { inputs: [], outputs: [], events: [] } }
}

/** Whether the server runs the query (resource and library queries); JS queries run in the browser. */
export const isServerQuery = (q: AppQuery): q is ServerAppQuery => q.kind !== 'js'

/** Whether the query runs by itself whenever what it reads changes (automatic server queries). */
export const runsAutomatically = (q: AppQuery): boolean => isServerQuery(q) && q.run === 'auto'

/**
 * The JSON whose templates the browser evaluates before a server query runs: a resource query's connector query,
 * a library query's parameters.
 */
export const queryTemplates = (q: ServerAppQuery): Record<string, unknown> =>
  q.kind === 'resource' ? q.query : (q.params ?? {})

/** A new, empty app. */
export function emptyApp(): AppDefinition {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    components: [],
    queries: [],
    transformers: [],
    variables: [],
    layout: {},
  }
}
