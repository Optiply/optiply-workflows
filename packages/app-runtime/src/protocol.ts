import type { AppDefinition } from '@ow/app-definition'

/**
 * Messages between the page (the host) and the app's sandbox: an iframe with an opaque origin, so the app's code
 * can't reach the page, its cookies or the platform's API. They travel over a MessageChannel the host hands the
 * iframe once (`ow:connect`), so no other window can talk to either side.
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

export type HostMessage =
  | { type: 'start'; definition: AppDefinition; globals: RuntimeGlobals }
  /** The editor changed the app: it takes over, keeping what the user did (see `AppRuntime.start`). */
  | { type: 'update'; definition: AppDefinition }
  /** Values the user changed: typing, picking, selecting, editing a cell. */
  | { type: 'set'; updates: Record<string, unknown> }
  /** A component event the user caused (`click`, `change`, `submit`). */
  | { type: 'fire'; owner: string; event: string }
  /** A method the page calls (a modal's close button, a table row click). */
  | { type: 'call'; entity: string; method: string; args: unknown[] }
  /** Runs a query now (the editor's Run button). */
  | { type: 'trigger'; query: string }
  | { type: 'queryResult'; id: number; outcome: QueryOutcome }
  | { type: 'confirmResult'; id: number; ok: boolean }

export type SandboxMessage =
  /** The sandbox's script loaded; the host may send `start`. */
  | { type: 'ready' }
  /** The app is evaluated and its first patch was sent. */
  | { type: 'started' }
  | { type: 'patch'; patch: StatePatch }
  | { type: 'runQuery'; id: number; query: string; values: Record<string, unknown> }
  | { type: 'confirm'; id: number; message: string }
  | { type: 'effect'; effect: Effect }
  | { type: 'log'; level: LogLevel; message: string }
  /** The app couldn't start. */
  | { type: 'fatal'; message: string }

/** The first message from the host, carrying the port as its transfer. */
export const CONNECT_MESSAGE = 'ow:connect'
