/**
 * What the reader makes of a Retool export: a small, tolerant model the converters read. Retool's own shapes (and
 * their version quirks) stay in read.ts; fields Retool leaves out come back as null, empty lists or empty objects,
 * never undefined.
 */

/** One Retool "plugin": a component, query, State, Function, frame or setting of an app or workflow. */
export interface RetoolPlugin {
  /** Its name in Retool, which code uses (`table1`, `getOrders`). */
  id: string
  uuid: string | null
  /** `widget`, `datasource`, `function`, `state`, `frame`, `setting`, `screen`, … */
  type: string
  /** The kind: `TableWidget2`, `SqlQueryUnified`, `RESTQuery`, `State`, … */
  subtype: string
  /** The resource a query runs on: Retool's resource uuid or name (null for JS and the like). */
  resourceName: string | null
  resourceDisplayName: string | null
  /** Its settings, as Retool keeps them (strings with `{{ }}`, lists, maps, records with `$record`). */
  template: Record<string, unknown>
  style: Record<string, unknown>
  /** Where it sits on the grid; null for queries and other parts without a place. */
  position: RetoolPosition | null
  /** The page (Retool screen) it belongs to; null in a single-page app or for a global part. */
  screen: string | null
  folder: string | null
  comment: string | null
}

export interface RetoolPosition {
  /** The parent's id ('' or null at the top: the main frame). */
  container: string | null
  /** The parent's view (a tab or container view) it sits in. */
  subcontainer: string | null
  /** `body`, `header`, `footer` in a container. */
  rowGroup: string | null
  row: number
  col: number
  width: number
  height: number
  tabNum: number | null
  /** A stack (auto layout) position, when the parent stacks its children. */
  stack: { ordinal: number; widthType: string | null; width: number | null; height: number | null } | null
}

export interface RetoolApp {
  kind: 'app'
  uuid: string
  name: string
  plugins: RetoolPlugin[]
  /** The first page shown, in an app with screens. */
  rootScreen: string | null
  settings: {
    title: string | null
    maxWidth: string | null
    css: string | null
    theme: string | null
  }
  /** Modules the app uses, by uuid, as exported (none in the samples so far). */
  modules: Record<string, unknown>
  /** Retool's own save time, if it says. */
  updatedAt: string | null
}

export interface RetoolBlock {
  uuid: string
  /** The block's name, which other blocks' code reads (`getOrders.data`). */
  name: string
  /** `webhook` (the start), `code`, `default` (a query), `conditional`, `filter`, `loop`, `function`, `webhookReturn`… */
  blockType: string
  /** The query editor: `JavascriptQuery`, `SqlQueryUnified`, `RESTQuery`, `OpenAPIQuery`, … */
  editorType: string | null
  top: number
  left: number
  width: number | null
  height: number | null
  options: Record<string, unknown>
  /** Blocks that run this one when they succeed (their uuids). */
  incoming: string[]
  /** Ports of conditionals that lead here: `{ blockId, portId }`. */
  incomingPorts: { blockId: string; portId: string }[]
  /** A conditional's ports (one per condition, plus else). */
  outgoingPorts: { id: string; name: string; type: string }[]
  retry: { attempts: number; intervalMs: number | null } | null
  comment: string | null
  failureCondition: string | null
  resourceName: string | null
  /** The block's settings: its plugin in the workflow's template (null if the template lacks it). */
  plugin: RetoolPlugin | null
}

export interface RetoolFunction {
  /** The subflow's id, which function and loop blocks name. */
  id: string
  parameters: { id: string; name: string; exampleValue: string | null }[]
  blocks: RetoolBlock[]
}

export interface RetoolWebhookTrigger {
  uuid: string | null
  name: string | null
  /** A JSON schema of the body (Retool keeps `properties` as a list). */
  inputSchema: unknown
  /** The example body, as text. It can hold real data or secrets: the importer never keeps it as it is. */
  exampleInput: string | null
  useHeaderApiKey: boolean
}

export interface RetoolWorkflow {
  kind: 'workflow'
  /** Workflow exports carry no uuid of their own. */
  uuid: null
  name: string
  description: string | null
  enabled: boolean
  timezone: string | null
  crontab: string | null
  blocks: RetoolBlock[]
  functions: RetoolFunction[]
  webhooks: RetoolWebhookTrigger[]
  setupScript: { javascript: string; python: string }
  libraries: { name: string; version: string | null; variable: string | null; language: string | null }[]
  memoryLimitMb: number | null
}

export type RetoolExport = RetoolApp | RetoolWorkflow
