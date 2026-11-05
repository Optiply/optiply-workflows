import type { AppDefinition, ComponentLibraryInterface, InstanceStep } from '@ow/app-definition'

export type { InstanceStep }

/**
 * Messages between the page (the host) and the app's sandbox: a Worker started by an iframe with an opaque origin
 * and no network access, so the app's code can't reach the page, its cookies or the platform's API, and an endless
 * loop in it can't freeze the page. They travel over a MessageChannel the host hands the iframe once (`ow:connect`),
 * which passes it on to the Worker, so nothing else can talk to either side.
 *
 * Everything the sandbox sends is untrusted: the host runs only the app's own queries (the server checks them),
 * opens only http(s) and mailto URLs, and renders values as text.
 */

/** The result of running a resource query on the server. */
export type QueryOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: { code?: string; message: string } }

/** Something the app asks the page to do. */
export type Effect =
  | { type: 'notify'; message: string; tone: 'info' | 'success' | 'error' }
  | { type: 'openUrl'; url: string; newTab: boolean }
  | { type: 'copy'; text: string }
  | { type: 'download'; data: string; fileName: string; mimeType: string }
  /** `utils.openPage`: the page changes its URL, then tells the sandbox (`navigate`). */
  | { type: 'openPage'; page: string; params: Record<string, string>; newTab: boolean }

/** What changed in the app's state. */
export interface StatePatch {
  /** Values by node key (`table1.selectedRow`): every value in the first patch, then only changed ones. */
  values: Record<string, unknown>
  /** Every node's error, when they changed since the last patch. */
  errors?: Record<string, string>
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error'

/** What the app's code sees as `current_user` and `appContext`. */
export interface RuntimeGlobals {
  current_user: { id: string; email: string; name: string }
  appContext: { appSlug: string; environment: string; version: string | null }
}

/** The page shown and the query parameters of its URL (without the platform's own, like `env`). */
export interface AppUrl {
  page: string | null
  params: Record<string, string>
}

/** A module release an app's instances run (M14). */
export interface ModuleRelease {
  definition: AppDefinition
  /** Sent back with the instance's queries, so the server runs them from the release the page runs. */
  releaseId: string
}

/** The module releases an app's instances run, by `slug@version` with the version as the instance names it (`latest` or a version). */
export type ModuleReleases = Record<string, ModuleRelease>

/** A component library release an app's custom components run (M25): their interfaces and the built bundle. */
export interface ComponentLibraryRelease {
  releaseId: string
  version: string
  bundleHash: string
  allowedOrigins: string[]
  components: ComponentLibraryInterface
}

/** The library releases an app's custom components run, by `slug@version` as they name it (`latest` or a version). */
export type ComponentLibraryReleases = Record<string, ComponentLibraryRelease>

/** Which module instance a query belongs to: the instances from the app to it, outermost first (M21). */
export type QueryModule = InstanceStep[]

export type HostMessage =
  | {
      type: 'start'
      definition: AppDefinition
      globals: RuntimeGlobals
      url: AppUrl
      modules?: ModuleReleases
      /** The component library releases its custom components run (M25). */
      libraries?: ComponentLibraryReleases
      /** A module run on its own, in its editor (M14): what `inputs.<name>` are (the inputs' test values). */
      inputs?: Record<string, unknown>
    }
  /**
   * The editor changed the app: it takes over, keeping what the user did (see `AppRuntime.start`). Without
   * `modules`, its instances keep running the releases they ran; without `inputs`, a module keeps its inputs.
   */
  | {
      type: 'update'
      definition: AppDefinition
      modules?: ModuleReleases
      libraries?: ComponentLibraryReleases
      inputs?: Record<string, unknown>
      /** Components, queries and variables that start afresh instead of keeping what the user did (Reset state). */
      reset?: string[]
    }
  /**
   * Values the user changed: typing, picking, selecting, editing a cell. With `seq`, the sandbox answers `ack` once
   * it has them, so the page can ignore older values for those keys still on their way (no cursor jumps).
   */
  | { type: 'set'; updates: Record<string, unknown>; seq?: number }
  /** A component event the user caused (`click`, `change`, `submit`). */
  | { type: 'fire'; owner: string; event: string }
  /** A method the page calls (a modal's close button, a table row click). */
  | { type: 'call'; entity: string; method: string; args: unknown[] }
  /** Runs a query now (the editor's Run button). */
  | { type: 'trigger'; query: string }
  | { type: 'queryResult'; id: number; outcome: QueryOutcome }
  | { type: 'confirmResult'; id: number; ok: boolean }
  /** What a custom component's method answered (M25). */
  | { type: 'componentResult'; id: number; ok: true; value: unknown }
  | { type: 'componentResult'; id: number; ok: false; error: string }
  /** Asks whether the sandbox is still responding (the host's watchdog); answered with `pong`. */
  | { type: 'ping'; id: number }
  /** The page's URL changed (a link, `utils.openPage`, Back): show that page with those parameters. */
  | { type: 'navigate'; url: AppUrl }

export type SandboxMessage =
  /** The sandbox's script loaded; the host may send `start`. */
  | { type: 'ready' }
  /** The app is evaluated and its first patch was sent. */
  | { type: 'started' }
  | { type: 'patch'; patch: StatePatch }
  /** The `set` with this `seq` (and every earlier one) is applied; its patch came before this. */
  | { type: 'ack'; seq: number }
  /** `module`: the query is a module instance's (M14). */
  | { type: 'runQuery'; id: number; query: string; values: Record<string, unknown>; module?: QueryModule }
  | { type: 'confirm'; id: number; message: string }
  /** Calls a custom component's method in its frame (M25); `component` is prefixed inside a module instance. */
  | { type: 'callComponent'; id: number; component: string; method: string; args: unknown[] }
  | { type: 'effect'; effect: Effect }
  | { type: 'log'; level: LogLevel; message: string }
  /** The app couldn't start. */
  | { type: 'fatal'; message: string }
  | { type: 'pong'; id: number }

/** The first message from the host, carrying the port as its transfer; the iframe sends it on to its Worker. */
export const CONNECT_MESSAGE = 'ow:connect'
