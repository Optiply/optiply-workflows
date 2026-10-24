import runtimeCode from 'virtual:app-runtime'
import { type AppDefinition, instanceRelease, MAX_MODULE_DEPTH, runsAutomatically } from '@ow/app-definition'
import {
  type AppUrl,
  CONNECT_MESSAGE,
  type Effect,
  type HostMessage,
  type LogLevel,
  type ModuleReleases,
  type QueryModule,
  type QueryOutcome,
  type RuntimeGlobals,
  type SandboxMessage,
} from '@ow/app-runtime'
import { STDLIB_BUNDLE } from '@ow/sandbox/stdlib'
import { TRPCClientError } from '@trpc/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { type AuthRequired, authRequired } from '@/lib/oauth'
import { trpcClient } from '@/lib/trpc'
import { Watchdog } from './watchdog'

/**
 * The page's side of a running app. It creates the app's sandbox (a hidden iframe with an opaque origin and no
 * network access, running the app in a Worker so the app's code can't freeze the page), sends it the definition,
 * and then:
 * - runs the resource queries it asks for through the API (the server checks them against the stored app);
 * - keeps the app's state in a store for the components to render;
 * - passes the user's input and events in;
 * - carries out effects (notifications, links, downloads) after checking them, since the app's code is untrusted;
 * - stops the sandbox when it stops responding (an endless loop), until the person restarts it or edits the app.
 */

export interface AppHostState {
  /** `stopped`: the app's code stopped responding, so the sandbox was stopped (see `restart`). */
  status: 'loading' | 'ready' | 'failed' | 'stopped'
  /** Values by node key (`table1.selectedRow`). */
  values: Record<string, unknown>
  /** Errors by node key. */
  errors: Record<string, string>
  /** The module releases the app's instances run (M14), for drawing them. */
  modules: ModuleReleases
  /** Why the app couldn't start, or that a newer version is live. */
  problem: string | null
  /** The app's console, newest last (at most 500 lines). */
  logs: { id: number; level: LogLevel; message: string; at: number }[]
  /** Queries that failed for want of a connected account, per resource (see `accountConnected`). */
  connections: NeededConnection[]
}

export interface NeededConnection {
  need: AuthRequired
  message: string
  /** The queries that failed for it, in order. */
  queries: string[]
}

export interface AppHostOptions {
  definition: AppDefinition
  /** The module releases the app's instances run (M14), by `slug@version`; later changes go through `update`. */
  modules?: ModuleReleases
  /**
   * `module`: a module's draft running on its own in its editor (M14). `appId` is then the module's id, its queries
   * run through `modules.runQuery`, and `inputs.<name>` are its inputs' test values.
   */
  kind?: 'app' | 'module'
  /** The app's id (the module's, for `kind` module). */
  appId: string
  /** The release being shown, or null for the draft (the editor). */
  releaseId: string | null
  /** With `releaseId` null: a Git branch draft (M11) instead of the main draft. */
  branchDraftId?: string | null
  environmentId: string
  globals: RuntimeGlobals
  /** Shows a notification. */
  notify(message: string, tone: 'info' | 'success' | 'error'): void
  /** Asks the user to confirm before a query runs. */
  confirm(message: string): Promise<boolean>
  /** Called before each resource query runs (the editor saves the draft: the server runs what's saved). */
  beforeQuery?: () => Promise<void>
  /** The page to open on and its query parameters; later changes go through `navigate`. */
  url?: AppUrl
  /**
   * `utils.openPage`: the page this app is shown on changes its URL (then calls `navigate`). Without it (the
   * editor), the app moves to the page in place.
   */
  openPage?(page: string, params: Record<string, string>, newTab: boolean): void
}

/**
 * The sandbox's own policy: inline scripts, `new Function` and a Worker from a blob: URL only; no requests of any
 * kind. The Worker inherits it (the sandbox checks before starting the app). The frame is a srcdoc document, so a
 * CSP on the page (it has none today) would apply to it as well, and would need to allow the same.
 */
const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:"

/** A ping every second; one unanswered for 5 s means the app's code is stuck. */
const WATCHDOG = { intervalMs: 1000, stallMs: 5000 }

/** Only these can be opened from an app. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const DOWNLOAD_TYPES = new Set(['text/plain', 'text/csv', 'application/json'])

function inlineScript(code: string): string {
  // `</script` would end the element early; `<\/script` means the same in JavaScript.
  return `<script>${code.replaceAll('</script', '<\\/script')}</script>`
}

/** A string literal safe inside a `<script>`: no `<` at all, so nothing in it can end or reopen the element. */
function scriptString(text: string): string {
  return JSON.stringify(text).replaceAll('<', '\\u003c')
}

/**
 * The frame's own script: it starts the Worker running the app (the stdlib, then the runtime) and hands it the
 * page's port. The frame can't load anything, so the Worker's code comes as a string, through a blob: URL.
 */
function bootstrap(): string {
  return `
const source = ${scriptString(`${STDLIB_BUNDLE}\n;${runtimeCode}`)};
let worker = null;
let failure = '';
try {
  worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
} catch (err) {
  failure = String((err && err.message) || err);
}
let connected = false;
window.addEventListener('message', (event) => {
  // Only the page that holds this frame, only once.
  if (connected || event.source !== window.parent || event.data !== ${JSON.stringify(CONNECT_MESSAGE)}) return;
  const port = event.ports[0];
  if (!port) return;
  connected = true;
  if (worker) worker.postMessage(event.data, [port]);
  else port.postMessage({ type: 'fatal', message: "The app's sandbox could not start: " + failure });
});`
}

export function sandboxDocument(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '</head><body>',
    inlineScript(bootstrap()),
    '</body></html>',
  ].join('')
}

export class AppHost {
  readonly store: StoreApi<AppHostState>
  private container: HTMLElement | null = null
  private iframe: HTMLIFrameElement | null = null
  private port: MessagePort | null = null
  private watchdog: { dog: Watchdog; timer: ReturnType<typeof setInterval> } | null = null
  private destroyed = false
  private logId = 0
  /** The last `set` sent, and per key the `set` whose value the page shows until the sandbox has it. */
  private setSeq = 0
  private pending = new Map<string, number>()
  /** The definition the sandbox should run; an update before it started goes out with `start`. */
  private definition: AppDefinition
  /** The module releases the sandbox should run, like `definition`. */
  private modules: ModuleReleases
  /** What `start` sent; an edit made while the sandbox was starting follows as an update. */
  private startedWith: { definition: AppDefinition; modules: ModuleReleases } | null = null
  /** Where the app is: sent with `start` (a restart opens the same page), then as `navigate`. */
  private url: AppUrl

  /** The app's id; undefined for a module. */
  get appId(): string | undefined {
    return this.options.kind === 'module' ? undefined : this.options.appId
  }

  constructor(private readonly options: AppHostOptions) {
    this.definition = options.definition
    this.modules = options.modules ?? {}
    this.url = options.url ?? { page: null, params: {} }
    this.store = createStore<AppHostState>(() => ({
      status: 'loading',
      values: {},
      errors: {},
      modules: this.modules,
      problem: null,
      logs: [],
      connections: [],
    }))
  }

  /** Creates the sandbox inside `container` (it stays hidden) and starts the app. */
  mount(container: HTMLElement): void {
    this.container = container
    this.createSandbox()
  }

  private createSandbox() {
    const iframe = document.createElement('iframe')
    // No allow-same-origin: the frame gets an opaque origin, so it can't touch this page or its cookies.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.title = 'App sandbox'
    iframe.style.display = 'none'
    iframe.srcdoc = sandboxDocument()
    iframe.addEventListener('load', () => this.connect(iframe), { once: true })
    this.container!.appendChild(iframe)
    this.iframe = iframe
  }

  /** Removes the sandbox: the browser ends the Worker with its frame, endless loop or not. */
  private removeSandbox() {
    this.stopWatchdog()
    this.port?.close()
    this.iframe?.remove()
    this.iframe = null
    this.port = null
  }

  destroy(): void {
    this.destroyed = true
    this.removeSandbox()
  }

  /**
   * Starts the app afresh in a new sandbox (after it stopped responding): what the user typed and the queries'
   * results are gone with the old one. The console and a newer-release notice stay.
   */
  restart(): void {
    if (this.destroyed || !this.container) return
    this.removeSandbox()
    this.pending.clear()
    this.startedWith = null
    this.store.setState({ status: 'loading', values: {}, errors: {}, connections: [] })
    this.createSandbox()
  }

  /**
   * What the user changed. The page shows it at once; values for those keys still coming from the sandbox (from
   * before it had this) are ignored until it acknowledges, so typing fast never jumps back a character.
   */
  set(updates: Record<string, unknown>): void {
    const seq = ++this.setSeq
    for (const key of Object.keys(updates)) this.pending.set(key, seq)
    this.store.setState((s) => ({ values: { ...s.values, ...updates } }))
    this.post({ type: 'set', updates, seq })
  }

  fire(owner: string, event: string): void {
    this.post({ type: 'fire', owner, event })
  }

  call(entity: string, method: string, args: unknown[] = []): void {
    this.post({ type: 'call', entity, method, args })
  }

  trigger(query: string): void {
    this.post({ type: 'trigger', query })
  }

  /**
   * Opens one of the app's pages (`utils.openPage`, a Navigation link): the page this app is shown on changes its
   * URL, which comes back as `navigate`; without `openPage` (the editor), the app moves in place.
   */
  openPage(page: string, params: Record<string, string>, newTab = false): void {
    if (this.options.openPage) this.options.openPage(page, params, newTab)
    else this.navigate({ page, params })
  }

  /** The page's URL changed: the app shows that page with those parameters. */
  navigate(url: AppUrl): void {
    if (url.page === this.url.page && JSON.stringify(url.params) === JSON.stringify(this.url.params)) return
    this.url = { page: url.page, params: { ...url.params } }
    if (this.store.getState().status !== 'loading') this.post({ type: 'navigate', url: this.url })
  }

  /**
   * The editor changed the app: the sandbox switches to it, keeping what the user did. An app that stopped
   * responding starts again with the edit (likely the fix).
   */
  update(definition: AppDefinition, modules: ModuleReleases = this.modules): void {
    if (definition === this.definition && modules === this.modules) return
    const modulesChanged = modules !== this.modules
    this.definition = definition
    this.modules = modules
    if (modulesChanged) this.store.setState({ modules })
    const { status } = this.store.getState()
    if (status === 'stopped') this.restart()
    else if (status !== 'loading') {
      this.post({ type: 'update', definition, ...(modulesChanged && { modules }), ...this.testInputs() })
      // A page added or renamed with this edit: the navigation to it may have come first, when it didn't exist yet.
      this.post({ type: 'navigate', url: this.url })
    }
  }

  private connect(iframe: HTMLIFrameElement) {
    if (this.destroyed || iframe !== this.iframe || !iframe.contentWindow) return
    const channel = new MessageChannel()
    const port = channel.port1
    this.port = port
    port.onmessage = (e: MessageEvent<SandboxMessage>) => void this.handle(e.data, port)
    // The frame's origin is opaque, so `*` is the only target that reaches it; the port does the rest.
    iframe.contentWindow.postMessage(CONNECT_MESSAGE, '*', [channel.port2])
    this.startWatchdog()
  }

  private startWatchdog() {
    this.stopWatchdog()
    const dog = new Watchdog(WATCHDOG)
    const timer = setInterval(() => {
      const action = dog.tick(performance.now())
      if (action?.type === 'ping') this.post({ type: 'ping', id: action.id })
      else if (action?.type === 'stalled') this.stalled()
    }, WATCHDOG.intervalMs)
    this.watchdog = { dog, timer }
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog.timer)
    this.watchdog = null
  }

  private stalled() {
    this.removeSandbox()
    this.store.setState({ status: 'stopped' })
    this.log(
      'error',
      `The app's code stopped responding for ${WATCHDOG.stallMs / 1000} s (an endless loop?), so it was stopped`,
    )
  }

  private log(level: LogLevel, message: string) {
    this.store.setState((s) => ({
      logs: [...s.logs, { id: ++this.logId, level, message, at: Date.now() }].slice(-500),
    }))
  }

  private post(message: HostMessage) {
    this.port?.postMessage(message)
  }

  /** Answers the sandbox that asked, unless it was replaced meanwhile (its ids mean nothing to the new one). */
  private reply(port: MessagePort, message: HostMessage) {
    if (port === this.port) port.postMessage(message)
  }

  private async handle(message: SandboxMessage, port: MessagePort) {
    if (this.destroyed || port !== this.port) return
    switch (message.type) {
      case 'ready':
        this.startedWith = { definition: this.definition, modules: this.modules }
        this.post({
          type: 'start',
          definition: this.definition,
          globals: this.options.globals,
          url: this.url,
          modules: this.modules,
          ...this.testInputs(),
        })
        return
      case 'started': {
        this.store.setState({ status: 'ready' })
        const started = this.startedWith
        if (this.definition !== started?.definition || this.modules !== started.modules) {
          this.post({
            type: 'update',
            definition: this.definition,
            ...(this.modules !== started?.modules && { modules: this.modules }),
            ...this.testInputs(),
          })
        }
        // Moved on while it was starting.
        this.post({ type: 'navigate', url: this.url })
        return
      }
      case 'fatal':
        this.stopWatchdog()
        this.store.setState({ status: 'failed', problem: message.message })
        return
      case 'pong':
        this.watchdog?.dog.pong(message.id)
        return
      case 'patch': {
        const { errors } = message.patch
        const values = this.pending.size
          ? Object.fromEntries(Object.entries(message.patch.values).filter(([key]) => !this.pending.has(key)))
          : message.patch.values
        this.store.setState((s) => ({ values: { ...s.values, ...values }, ...(errors && { errors }) }))
        return
      }
      case 'ack':
        for (const [key, seq] of this.pending) if (seq <= message.seq) this.pending.delete(key)
        return
      case 'runQuery':
        this.reply(port, {
          type: 'queryResult',
          id: message.id,
          outcome: await this.runQuery(message.query, message.values, queryModule(message.module)),
        })
        return
      case 'confirm':
        this.reply(port, {
          type: 'confirmResult',
          id: message.id,
          ok: await this.options.confirm(String(message.message)),
        })
        return
      case 'effect':
        this.effect(message.effect)
        return
      case 'log':
        this.log(message.level, String(message.message))
        return
    }
  }

  /** A module's draft in its editor: its inputs' test values, as `inputs.<name>`. */
  private testInputs(): { inputs?: Record<string, unknown> } {
    if (this.options.kind !== 'module') return {}
    const inputs = this.definition.module?.inputs ?? []
    return { inputs: Object.fromEntries(inputs.map((i) => [i.name, i.testValue ?? null])) }
  }

  /**
   * Runs a server query; a module instance's with `module` (M14), the path of instances to it (M21), known on the
   * page as `outer/inner/query`.
   */
  private async runQuery(
    query: string,
    values: Record<string, unknown>,
    module: QueryModule | undefined,
  ): Promise<QueryOutcome> {
    const name = module ? [...module.map((m) => m.instance), query].join('/') : String(query)
    try {
      await this.options.beforeQuery?.()
      const outcome =
        this.options.kind === 'module'
          ? await trpcClient.modules.runQuery.mutate({
              moduleId: this.options.appId,
              ...(this.options.branchDraftId ? { branchDraftId: this.options.branchDraftId } : {}),
              query: String(query),
              ...(module && { path: module }),
              environmentId: this.options.environmentId,
              values,
            })
          : await trpcClient.apps.runQuery.mutate({
              appId: this.options.appId,
              releaseId: this.options.releaseId,
              ...(this.options.branchDraftId ? { branchDraftId: this.options.branchDraftId } : {}),
              query: String(query),
              ...(module && { module }),
              environmentId: this.options.environmentId,
              values,
            })
      if (outcome.ok) {
        this.connectionWorked(name)
        return { ok: true, data: outcome.data }
      }
      const need = authRequired(outcome.error)
      if (need) this.connectionNeeded(need, outcome.error.message, name)
      return { ok: false, error: { code: outcome.error.code, message: outcome.error.message } }
    } catch (err) {
      const code = err instanceof TRPCClientError ? (err.data?.code as string | undefined) : undefined
      const message = err instanceof Error ? err.message : 'The query could not be run'
      if (code === 'CONFLICT') this.store.setState({ problem: message })
      return { ok: false, error: { ...(code && { code }), message } }
    }
  }

  /**
   * The person connected an account a query needed: the automatic queries that failed for it run again (manual
   * ones wait for the person: re-running a write on its own would surprise them).
   */
  accountConnected(resourceId: string): void {
    const done = this.store.getState().connections.filter((c) => c.need.resourceId === resourceId)
    this.store.setState((s) => ({
      connections: s.connections.filter((c) => c.need.resourceId !== resourceId),
    }))
    const auto = new Set(this.definition.queries.filter(runsAutomatically).map((q) => q.name))
    // A module instance's automatic queries too, as `instance/query`.
    for (const c of this.definition.components) {
      const ref = c.type === 'module' ? instanceRelease(c) : null
      const release = ref && Object.hasOwn(this.modules, ref.key) ? this.modules[ref.key] : undefined
      for (const q of release?.definition.queries.filter(runsAutomatically) ?? [])
        auto.add(`${c.name}/${q.name}`)
    }
    for (const query of new Set(done.flatMap((c) => c.queries))) if (auto.has(query)) this.trigger(query)
  }

  private connectionNeeded(need: AuthRequired, message: string, query: string) {
    this.store.setState((s) => {
      const same = (c: NeededConnection) =>
        c.need.resourceId === need.resourceId && c.need.environmentId === need.environmentId
      const existing = s.connections.find(same)
      const entry: NeededConnection = {
        need,
        message,
        queries: existing?.queries.includes(query) ? existing.queries : [...(existing?.queries ?? []), query],
      }
      return {
        connections: existing ? s.connections.map((c) => (same(c) ? entry : c)) : [...s.connections, entry],
      }
    })
  }

  /** A query that needed a connection works now (connected elsewhere, or someone else connected the shared one). */
  private connectionWorked(query: string) {
    const { connections } = this.store.getState()
    if (!connections.some((c) => c.queries.includes(query))) return
    this.store.setState({
      connections: connections
        .map((c) => ({ ...c, queries: c.queries.filter((q) => q !== query) }))
        .filter((c) => c.queries.length),
    })
  }

  /** Carries out what the app asks for, within limits: it's the app's code asking. */
  private effect(effect: Effect) {
    switch (effect.type) {
      case 'notify': {
        const tone = effect.tone === 'success' || effect.tone === 'error' ? effect.tone : 'info'
        this.options.notify(String(effect.message).slice(0, 2000), tone)
        return
      }
      case 'openUrl': {
        let url: URL
        try {
          url = new URL(String(effect.url), window.location.href)
        } catch {
          this.options.notify(`Not a valid link: ${effect.url}`, 'error')
          return
        }
        if (!SAFE_PROTOCOLS.has(url.protocol)) {
          this.options.notify(`Links starting with ${url.protocol} can't be opened from an app`, 'error')
          return
        }
        if (effect.newTab) window.open(url.href, '_blank', 'noopener,noreferrer')
        else window.location.assign(url.href)
        return
      }
      case 'copy':
        navigator.clipboard.writeText(String(effect.text)).then(
          () => this.options.notify('Copied', 'success'),
          () => this.options.notify('Could not copy to the clipboard', 'error'),
        )
        return
      case 'openPage': {
        const params: Record<string, string> = {}
        if (effect.params && typeof effect.params === 'object') {
          for (const [key, value] of Object.entries(effect.params)) params[String(key)] = String(value)
        }
        this.openPage(String(effect.page), params, effect.newTab === true)
        return
      }
      case 'download': {
        const type = DOWNLOAD_TYPES.has(effect.mimeType) ? effect.mimeType : 'text/plain'
        const href = URL.createObjectURL(new Blob([String(effect.data)], { type }))
        const a = document.createElement('a')
        a.href = href
        a.download = String(effect.fileName).replace(/[/\\]/g, '_') || 'download.txt'
        a.click()
        setTimeout(() => URL.revokeObjectURL(href), 10_000)
        return
      }
    }
  }
}

/** The module instance path a query belongs to, as the sandbox (untrusted) says; the server checks it. */
function queryModule(module: unknown): QueryModule | undefined {
  if (!Array.isArray(module) || module.length === 0 || module.length > MAX_MODULE_DEPTH) return undefined
  const path: QueryModule = []
  for (const step of module) {
    const { instance, releaseId } = (step ?? {}) as Record<string, unknown>
    if (typeof instance !== 'string' || typeof releaseId !== 'string') return undefined
    path.push({ instance, releaseId })
  }
  return path
}
