import {
  type AppDefinition,
  AppModel,
  type AppQuery,
  browserExpressions,
  type CodeRunner,
  containerViews,
  customComponentSpec,
  customInstanceInterface,
  type Entity,
  type EventHandler,
  entityPages,
  formInputs,
  instanceRelease,
  isServerQuery,
  moduleComponentSpec,
  moduleInterface,
  OUTPUTS,
  queryTemplates,
  resolvePage,
  runsAutomatically,
  type ServerAppQuery,
  sameValue,
  tableFilters,
} from '@ow/app-definition'
import type {
  ComponentLibraryReleases,
  Effect,
  LogLevel,
  ModuleReleases,
  QueryModule,
  QueryOutcome,
  StatePatch,
} from './protocol'

/**
 * Runs an app inside its sandbox: the reactive model, queries (automatic and manual, resource and JS), component
 * and query methods, event handlers and `utils`. Everything outside the sandbox goes through a `HostBridge`, so
 * this runs the same in the browser and in tests.
 *
 * A module instance (M14) runs as an `AppRuntime` of its own inside the app's, isolated: the app sees it as a
 * component whose props are the module's inputs, whose state is its outputs and whose events are its events. Its
 * values reach the page under the instance's prefix (`picker1/table1.data`), and the page addresses its components
 * the same way.
 */

/** What the runtime needs from the page. */
export interface HostBridge {
  /**
   * Runs one of the app's server queries with the values of its `{{ }}`s; with `module`, one of that module
   * instance's.
   */
  runQuery(query: string, values: Record<string, unknown>, module?: QueryModule): Promise<QueryOutcome>
  /** Asks the user to confirm before a query runs. */
  confirm(message: string): Promise<boolean>
  effect(effect: Effect): void
  /**
   * Calls a custom component's method in its frame (M25) and resolves with what it answered; rejects with its error.
   * Inside a module instance, `component` carries the instance's prefix (`picker1/chart1`).
   */
  callComponent?(component: string, method: string, args: unknown[]): Promise<unknown>
  /** What changed in the state, for the page to render. */
  publish(patch: StatePatch): void
  log(level: LogLevel, message: string): void
}

export interface AppRuntimeOptions {
  /** `current_user`, `appContext` and the stdlib (`_`, `dayjs`, `console`); `utils` is added here. */
  globals?: Record<string, unknown>
  runner?: CodeRunner
  /** How long an automatic query waits for more changes before it runs. Default 100 ms (typing runs it once). */
  autoRunDelayMs?: number
  /** The page the app opens on (its first when missing or unknown) and the URL's query parameters. */
  url?: { page?: string | null; params?: Record<string, string> }
  /**
   * The module releases the app's instances run (M14), by `slug@version` (`instanceRelease`). An instance whose
   * release isn't here doesn't run, and takes any props.
   */
  modules?: ModuleReleases
  /**
   * The component library releases the app's custom components run (M25), by `slug@version`. A custom component
   * whose release isn't here takes any props and has no methods.
   */
  libraries?: ComponentLibraryReleases
  /** In a module instance (M14): what `inputs.<name>` starts as. */
  inputs?: Record<string, unknown>
  /** What the app kept in this browser before (session 41): `localStorage.values` starts as it. */
  storage?: Record<string, unknown>
  /** In a module instance (M14): fires one of the module's events on the instance in the app. */
  onEvent?: (event: string) => Promise<boolean>
}

/** A module instance running in the app (M14). */
interface Instance {
  runtime: AppRuntime
  slug: string
  releaseId: string
  /** The module's inputs: the instance's props passed on to `inputs.<name>`. */
  inputs: ReadonlySet<string>
  /** The instance's own errors, by its node keys (the app prefixes them). */
  errors: Record<string, string>
}

/** A query failure, marked once the user has been told so callers up the chain don't tell them again. */
class QueryFailure extends Error {
  notified = false
}

export class AppRuntime {
  readonly model: AppModel
  private readonly queries: Map<string, AppQuery>
  private readonly runs = new Map<string, number>()
  /** What each resource query last sent, so an edit (`start({ previous })`) can tell whether it must run again. */
  private readonly sent = new Map<string, string>()
  private readonly autoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each throttled handler last ran (session 41). */
  private readonly throttled = new Map<string, number>()
  private readonly methodCache = new Map<string, Record<string, unknown>>()
  private readonly notified = new WeakSet<object>()
  private readonly autoRunDelayMs: number
  /** Each query's page; null for global ones. */
  private readonly pages: Map<string, string | null>
  /** Automatic queries on another page whose values changed meanwhile: they run when their page opens. */
  private readonly stale = new Set<string>()
  private lastErrors = '{}'
  private stopped = false
  /** Module instances by component name (M14). */
  private readonly instances = new Map<string, Instance>()
  /** While instances start: what they publish waits for the app's first patch. */
  private early: Record<string, unknown> | null = null

  constructor(
    readonly definition: AppDefinition,
    private readonly bridge: HostBridge,
    private readonly options: AppRuntimeOptions = {},
  ) {
    this.queries = new Map(definition.queries.map((q) => [q.name, q]))
    this.pages = entityPages(definition)
    this.autoRunDelayMs = options.autoRunDelayMs ?? 100
    this.model = new AppModel(definition, {
      ...(options.runner && { runner: options.runner }),
      globals: { ...options.globals, utils: this.utils() },
      methods: (entity) => this.methodsFor(entity),
      ...(options.url && { url: options.url }),
      ...(options.storage && { storage: options.storage }),
      ...(options.inputs && { inputs: options.inputs }),
      specFor: (c) => {
        if (c.type === 'custom') {
          const libraries = options.libraries ?? {}
          return customComponentSpec(
            customInstanceInterface(c, (slug) => {
              // The release the instance names, as the page resolved it: one version per key.
              const prefix = `${slug}@`
              const keys = Object.keys(libraries).filter((k) => k.startsWith(prefix))
              if (!keys.length) return undefined
              const versions = Object.fromEntries(
                keys.map((k) => [k.slice(prefix.length), libraries[k]!.components]),
              )
              return { liveVersion: Object.hasOwn(versions, 'latest') ? 'latest' : null, versions }
            }),
          )
        }
        const release = c.type === 'module' ? this.releaseOf(c) : undefined
        return release ? moduleComponentSpec(moduleInterface(release.definition)) : undefined
      },
    })
  }

  /** The release a module instance runs; undefined when the page didn't send it. */
  private releaseOf(component: AppDefinition['components'][number]) {
    const ref = instanceRelease(component)
    const modules = this.options.modules
    return ref && modules && Object.hasOwn(modules, ref.key) ? { ...ref, ...modules[ref.key]! } : undefined
  }

  /** A custom component's method, through the page (M25). */
  private callComponent(component: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.bridge.callComponent) return Promise.reject(new Error('Custom components can’t be called here'))
    return this.bridge.callComponent(component, method, args)
  }

  /** The page shown; null in an app without pages. */
  get page(): string | null {
    return (this.model.get('url.page') as string | null | undefined) ?? null
  }

  /** Whether a query belongs to every page or to the one shown (only those run on their own). */
  private active(name: string): boolean {
    const page = this.pages.get(name) ?? null
    return page === null || page === this.page
  }

  /**
   * Shows another page, or the same one with other parameters (the page's URL changed: a link, Back, Forward).
   * Code reading `url` re-evaluates; on a page just opened, its automatic queries run if they never did or their
   * values changed while it was closed, and its run-on-load queries run.
   */
  navigate(page: string | null, params: Record<string, string> = {}): Promise<void> {
    const before = this.page
    const next = resolvePage(this.definition, page)
    // An app from before pages may have an entity of its own named `url` (invalid now, but still running).
    if (this.model.graph.entities.get('url')?.kind !== 'url') return Promise.resolve()
    this.apply({ 'url.page': next, 'url.params': { ...params } })
    if (next === before || next === null) return Promise.resolve()
    const opening = this.definition.queries.filter((q) => this.pages.get(q.name) === next)
    // An automatic query reading `url` was scheduled by the change itself.
    const run = opening.filter(
      (q) =>
        q.runOnLoad ||
        (runsAutomatically(q) &&
          !this.autoTimers.has(q.name) &&
          (this.stale.has(q.name) || !this.runs.has(q.name))),
    )
    for (const q of opening) this.stale.delete(q.name)
    // Module instances on the page start the first time it opens (M21), and keep their state after it closes.
    const starting = this.definition.components.flatMap((c) =>
      c.type === 'module' && this.pages.get(c.name) === next && !this.instances.has(c.name)
        ? [this.startInstance(c)]
        : [],
    )
    return Promise.allSettled([...starting, ...run.map((q) => this.runQuiet(q.name))]).then(() => {})
  }

  /**
   * Evaluates the app, sends the first patch and runs what runs on load. Resolves when those queries finish.
   *
   * With `previous` (the same app before an edit), what the user did carries over: what they typed and selected
   * (unless the input's default changed), variables (unless their initial value changed) and query results. Only
   * the on-load queries that changed, or whose values changed, run again; `previous` stops.
   */
  async start(options: { previous?: AppRuntime; reset?: readonly string[] } = {}): Promise<void> {
    const { previous } = options
    this.model.init()
    if (previous) {
      previous.stop()
      this.model.set(this.carriedOver(previous, new Set(options.reset)))
    }
    const loading = this.startInstances(previous)
    const values: Record<string, unknown> = {}
    for (const key of this.model.graph.order) {
      // Of the internal values, only what renderers read: a table's `$rows` (M24).
      const node = this.model.graph.nodes.get(key)!
      if (!node.property.startsWith('$') || node.kind === 'rows') values[key] = this.model.get(key)
    }
    this.publish({ ...values, ...this.early })
    this.early = null
    const onLoad = this.definition.queries.filter(
      (q) =>
        (runsAutomatically(q) || q.runOnLoad) &&
        this.active(q.name) &&
        (!previous || options.reset?.includes(q.name) || this.mustRerun(q, previous)),
    )
    await Promise.allSettled([...loading, ...onLoad.map((q) => this.runQuiet(q.name))])
  }

  /**
   * Starts a runtime for each module instance on the page shown (or on every page) whose release the page sent;
   * those on other pages start when theirs first opens (M21). With `previous`, an instance of the same module there
   * carries over (see `start`). Returns their loads. What they publish meanwhile goes into the app's first patch, and
   * their outputs into its model, so the app's on-load queries see them (and run once).
   */
  private startInstances(previous?: AppRuntime): Promise<void>[] {
    this.early = {}
    // Those already running before an edit keep running (and their state), whatever page is shown.
    return this.definition.components.flatMap((component) =>
      component.type === 'module' && (this.active(component.name) || previous?.instances.has(component.name))
        ? [this.startInstance(component, previous)]
        : [],
    )
  }

  /** Starts one module instance, with its inputs from the instance's props; resolves when its on-load work ends. */
  private startInstance(
    component: AppDefinition['components'][number],
    previous?: AppRuntime,
  ): Promise<void> {
    const release = this.releaseOf(component)
    if (!release) return Promise.resolve()
    const name = component.name
    try {
      const iface = moduleInterface(release.definition)
      const inputs = Object.fromEntries(iface.inputs.map((i) => [i, this.model.get(`${name}.${i}`)]))
      const runtime = new AppRuntime(release.definition, this.instanceBridge(name), {
        ...(this.options.globals && { globals: this.options.globals }),
        ...(this.options.runner && { runner: this.options.runner }),
        // Its own instances run from the same releases (M21: modules inside modules).
        ...(this.options.modules && { modules: this.options.modules }),
        ...(this.options.libraries && { libraries: this.options.libraries }),
        autoRunDelayMs: this.autoRunDelayMs,
        inputs,
        // The app's local storage, as it is now: an instance writes to the same keys.
        storage: (this.model.get('localStorage.values') as Record<string, unknown> | null) ?? {},
        onEvent: (event) => this.fire(name, event),
      })
      this.instances.set(name, {
        runtime,
        slug: release.slug,
        releaseId: release.releaseId,
        inputs: new Set(iface.inputs),
        errors: {},
      })
      const before = previous?.instances.get(name)
      return runtime.start(before?.slug === release.slug ? { previous: before.runtime } : {})
    } catch (err) {
      this.bridge.log('error', `${name}: the module could not start: ${message(err)}`)
      return Promise.resolve()
    }
  }

  /**
   * What a module instance's runtime sees of the page: its queries tagged with their path (this instance first,
   * then those inside it), its values under its prefix.
   */
  private instanceBridge(name: string): HostBridge {
    return {
      runQuery: (query, values, inner) =>
        this.bridge.runQuery(query, values, [
          { instance: name, releaseId: this.instances.get(name)!.releaseId },
          ...(inner ?? []),
        ]),
      confirm: (text) => this.bridge.confirm(text),
      effect: (effect) => this.bridge.effect(effect),
      callComponent: (component, method, args) => this.callComponent(`${name}/${component}`, method, args),
      log: (level, text) => this.bridge.log(level, `${name}/${text}`),
      publish: (patch) => this.fromInstance(name, patch),
    }
  }

  /** A module instance's patch: its values for the page (prefixed), its outputs into the instance's state. */
  private fromInstance(name: string, patch: StatePatch) {
    const instance = this.instances.get(name)
    if (this.stopped || !instance) return
    if (patch.errors) instance.errors = patch.errors
    const values: Record<string, unknown> = {}
    const outputs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch.values)) {
      if (!key.startsWith(`${OUTPUTS}.`)) values[`${name}/${key}`] = value
      else {
        const state = `${name}.${key.slice(OUTPUTS.length + 1)}`
        if (this.model.graph.nodes.get(state)?.kind === 'source') outputs[state] = value
      }
    }
    if (this.early) {
      Object.assign(this.early, values)
      this.forwardInputs(this.model.set(outputs))
    } else {
      this.apply(outputs, values)
    }
  }

  /** Passes the instances' changed input props on to their `inputs.<name>`. */
  private forwardInputs(changed: Iterable<string>) {
    const updates = new Map<Instance, Record<string, unknown>>()
    for (const key of changed) {
      const node = this.model.graph.nodes.get(key)
      const instance = node?.kind === 'prop' ? this.instances.get(node.entity) : undefined
      if (!instance?.inputs.has(node!.property)) continue
      const own = updates.get(instance) ?? {}
      own[`inputs.${node!.property}`] = this.model.get(key)
      updates.set(instance, own)
    }
    for (const [instance, own] of updates) instance.runtime.set(own)
  }

  /** The runtime a page-side name belongs to: a module instance's for `instance/name`, otherwise this one. */
  private route(name: string): [AppRuntime, string] {
    const slash = name.indexOf('/')
    if (slash < 0) return [this, name]
    const owner = name.slice(0, slash)
    // An instance on a page not opened yet starts when something reaches into it (M21).
    if (!this.instances.has(owner)) {
      const component = this.definition.components.find((c) => c.name === owner && c.type === 'module')
      if (component) void this.startInstance(component)
    }
    const instance = this.instances.get(owner)
    if (!instance) throw new Error(`No module instance is named ${owner}`)
    return [instance.runtime, name.slice(slash + 1)]
  }

  /** The run-time values of `previous` that still mean the same thing in this definition. */
  private carriedOver(previous: AppRuntime, reset: ReadonlySet<string> = new Set()): Record<string, unknown> {
    const carried: Record<string, unknown> = {}
    const before = previous.model
    for (const [key, node] of this.model.graph.nodes) {
      if (node.kind !== 'source' && node.kind !== 'state') continue
      // Reset state (the editor's ··· menu): this entity starts afresh.
      if (reset.has(node.entity)) continue
      const old = before.graph.nodes.get(key)
      if (!old || old.kind !== node.kind) continue
      // A module's inputs come from the app, as they are now.
      if (node.entity === 'inputs' && this.model.graph.entities.get('inputs')?.kind === 'inputs') continue
      // An input whose default changed starts from the new default.
      if (node.from && !sameValue(before.get(old.from!), this.model.get(node.from))) continue
      const entity = this.model.graph.entities.get(node.entity)!
      if (entity.kind === 'variable') {
        const initial = `${node.entity}.$initial`
        if (!sameValue(before.get(initial), this.model.get(initial))) continue
      }
      // A run in flight belonged to the old app; whether to run again is decided by mustRerun.
      if (entity.kind === 'query' && node.property === 'isFetching') continue
      carried[key] = before.get(key)
    }
    return carried
  }

  /** Whether an on-load query must run again after an edit; when not, what it last sent carries over. */
  private mustRerun(query: AppQuery, previous: AppRuntime): boolean {
    const before = previous.queries.get(query.name)
    if (!before || JSON.stringify(before) !== JSON.stringify(query)) return true
    if (previous.model.get(`${query.name}.isFetching`) === true) return true
    if (!isServerQuery(query)) return false
    const last = previous.sent.get(query.name)
    if (last === undefined) return true
    try {
      if (JSON.stringify(this.valuesFor(query, {})) !== last) return true
    } catch {
      return true
    }
    this.sent.set(query.name, last)
    return false
  }

  /** The values of a server query's `{{ }}`s (`queryTemplates`), as the browser evaluates them. */
  private valuesFor(query: ServerAppQuery, locals: Record<string, unknown>) {
    const values: Record<string, unknown> = {}
    for (const code of browserExpressions(queryTemplates(query))) {
      try {
        values[code] = this.model.evaluateExpression(code, locals)
      } catch (err) {
        throw new QueryFailure(`Error in {{${code}}}: ${message(err)}`)
      }
    }
    return values
  }

  /** Stops timers and module instances; later results are ignored. */
  stop(): void {
    this.stopped = true
    for (const timer of [...this.autoTimers.values(), ...this.debounced.values()]) clearTimeout(timer)
    for (const instance of this.instances.values()) instance.runtime.stop()
  }

  /** Values the user changed (typing, selecting, editing a cell); a module instance's as `instance/key`. */
  set(updates: Record<string, unknown>): void {
    const own: Record<string, unknown> = {}
    const routed = new Map<AppRuntime, Record<string, unknown>>()
    for (const [key, value] of Object.entries(updates)) {
      const [runtime, inner] = this.route(key)
      if (runtime === this) own[key] = value
      else routed.set(runtime, { ...routed.get(runtime), [inner]: value })
    }
    if (Object.keys(own).length) this.apply(own)
    for (const [runtime, inner] of routed) runtime.set(inner)
  }

  /**
   * Runs the handlers of `owner`'s `event`, in parallel (like Retool). Resolves when they're done, to whether all of
   * them succeeded; a failing handler is reported to the user, not thrown.
   */
  async fire(owner: string, event: string, locals: Record<string, unknown> = {}): Promise<boolean> {
    const [runtime, inner] = this.route(owner)
    if (runtime !== this) return runtime.fire(inner, event, locals)
    const entity = this.model.graph.entities.get(owner)
    const handlers = entity ? handlersOf(entity).filter((h) => h.event === event) : []
    const results = await Promise.all(
      handlers.map((h) => {
        if (h.throttleMs) {
          // At most once per window; an event within it is dropped.
          const key = `${owner}:${h.id}`
          const last = this.throttled.get(key)
          const now = Date.now()
          if (last !== undefined && now - last < h.throttleMs) return true
          this.throttled.set(key, now)
          return this.runHandler(owner, h, locals)
        }
        if (!h.debounceMs) return this.runHandler(owner, h, locals)
        const key = `${owner}:${h.id}`
        clearTimeout(this.debounced.get(key))
        this.debounced.set(
          key,
          setTimeout(() => {
            this.debounced.delete(key)
            void this.runHandler(owner, h, locals)
          }, h.debounceMs),
        )
        return true
      }),
    )
    return results.every(Boolean)
  }

  /** Calls a method the way an event handler or script would (`modal1.close()`, `table1.selectRow(3)`). */
  async call(entity: string, method: string, args: unknown[] = []): Promise<unknown> {
    const [runtime, inner] = this.route(entity)
    if (runtime !== this) return runtime.call(inner, method, args)
    const target = this.model.graph.entities.get(entity)
    const fn = target && (this.methodsFor(target)[method] as ((...a: unknown[]) => unknown) | undefined)
    if (!fn) throw new Error(`${entity} has no method ${method}`)
    return fn(...args)
  }

  /**
   * Runs a query: checks `disabled`, asks for confirmation, evaluates its values (resource) or runs its code (JS),
   * applies the transform, stores the result and fires `success` or `failure`. Resolves to the data. A newer run of
   * the same query wins: an older one finishing late doesn't overwrite its result.
   */
  async trigger(name: string, options: { additionalScope?: Record<string, unknown> } = {}): Promise<unknown> {
    const [runtime, inner] = this.route(name)
    if (runtime !== this) return runtime.trigger(inner, options)
    const query = this.queries.get(name)
    if (!query) throw new Error(`No query is named ${name}`)
    const locals = options.additionalScope ?? {}
    if (query.disabled !== undefined && truthy(this.model.evaluateTemplate(query.disabled, locals)))
      return undefined
    if (query.confirm !== undefined) {
      const message = String(this.model.evaluateTemplate(query.confirm, locals) ?? '')
      if (!(await this.bridge.confirm(message || `Run ${name}?`))) return undefined
    }
    const run = (this.runs.get(name) ?? 0) + 1
    this.runs.set(name, run)
    const current = () => this.runs.get(name) === run && !this.stopped
    this.apply({ [`${name}.isFetching`]: true })

    try {
      let data: unknown
      if (isServerQuery(query)) {
        const values = this.valuesFor(query, locals)
        this.sent.set(name, JSON.stringify(values))
        const outcome = await this.bridge.runQuery(name, values)
        if (!outcome.ok) throw new QueryFailure(outcome.error.message)
        data = outcome.data
      } else {
        data = await this.model.runScript(query.code, locals)
      }
      if (query.transform !== undefined) {
        try {
          data = this.model.runFunctionBody(query.transform, { data })
        } catch (err) {
          throw new QueryFailure(`Error in the transform: ${message(err)}`)
        }
      }
      if (current()) {
        this.apply({
          [`${name}.data`]: data,
          [`${name}.error`]: null,
          [`${name}.isFetching`]: false,
          [`${name}.lastRunAt`]: new Date().toISOString(),
        })
        void this.fire(name, 'success')
      }
      return data
    } catch (err) {
      const failure = err instanceof QueryFailure ? err : new QueryFailure(message(err))
      if (current()) {
        this.apply({
          [`${name}.error`]: { message: failure.message },
          [`${name}.isFetching`]: false,
          [`${name}.lastRunAt`]: new Date().toISOString(),
        })
        void this.fire(name, 'failure')
        // Reads re-run as people type; only what someone asked for gets a notification.
        if (query.kind === 'js' || query.run === 'manual') {
          this.notifyError(failure, `${name} failed: ${failure.message}`)
        }
      }
      throw failure
    }
  }

  /** Clears a query's result; a run in flight no longer counts. */
  resetQuery(name: string): void {
    if (!this.queries.has(name)) throw new Error(`No query is named ${name}`)
    this.runs.set(name, (this.runs.get(name) ?? 0) + 1)
    this.apply({ [`${name}.data`]: null, [`${name}.error`]: null, [`${name}.isFetching`]: false })
  }

  /**
   * Sets values, publishes what changed (with `extra`: a module instance's values) and schedules the automatic
   * queries whose inputs changed; module instances whose input props changed get them.
   */
  private apply(updates: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    if (this.stopped) return
    const changed = this.model.set(updates)
    const values: Record<string, unknown> = { ...extra }
    for (const key of changed) {
      const node = this.model.graph.nodes.get(key)!
      if (node.kind === 'trigger') this.scheduleAuto(node.entity)
      else values[key] = this.model.get(key)
    }
    this.publish(values)
    this.forwardInputs(changed)
  }

  private publish(values: Record<string, unknown>) {
    const errors = Object.fromEntries(this.model.allErrors())
    for (const [name, instance] of this.instances) {
      for (const [key, error] of Object.entries(instance.errors)) errors[`${name}/${key}`] = error
    }
    const text = JSON.stringify(errors)
    const errorsChanged = text !== this.lastErrors
    this.lastErrors = text
    if (!Object.keys(values).length && !errorsChanged) return
    this.bridge.publish({ values, ...(errorsChanged && { errors }) })
  }

  private scheduleAuto(name: string) {
    if (!this.active(name)) {
      this.stale.add(name)
      return
    }
    clearTimeout(this.autoTimers.get(name))
    this.autoTimers.set(
      name,
      setTimeout(() => {
        this.autoTimers.delete(name)
        // Its page closed while it waited: it runs when the page opens again.
        if (!this.active(name)) this.stale.add(name)
        else void this.runQuiet(name)
      }, this.autoRunDelayMs),
    )
  }

  /** Runs a query nobody awaits (on load, automatic): failures are logged and kept in `query.error`. */
  private async runQuiet(name: string) {
    try {
      await this.trigger(name)
    } catch (err) {
      this.bridge.log('warn', `${name}: ${message(err)}`)
    }
  }

  private async runHandler(
    owner: string,
    handler: EventHandler,
    locals: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      if (handler.onlyIf !== undefined && !truthy(this.model.evaluateTemplate(handler.onlyIf, locals)))
        return true
      const action = handler.action
      switch (action.type) {
        case 'controlQuery':
          if (action.method === 'trigger') await this.trigger(action.query)
          else this.resetQuery(action.query)
          break
        case 'controlComponent': {
          const args = (action.args ?? []).map((a) => this.model.evaluateTemplate(a, locals))
          await this.call(action.component, action.method, args)
          break
        }
        case 'setVariable':
          this.apply({ [`${action.variable}.value`]: this.model.evaluateTemplate(action.value, locals) })
          break
        case 'runScript':
          await this.model.runScript(action.code, locals)
          break
        case 'notify':
          this.bridge.effect({
            type: 'notify',
            message: String(this.model.evaluateTemplate(action.message, locals) ?? ''),
            tone: action.tone ?? 'info',
          })
          break
        case 'openUrl':
          this.bridge.effect({
            type: 'openUrl',
            url: String(this.model.evaluateTemplate(action.url, locals) ?? ''),
            newTab: action.newTab ?? false,
          })
          break
        case 'openPage':
          this.utils().openPage(action.page, {
            params: this.evaluateParams(action.params, locals),
            newTab: action.newTab === true,
          })
          break
        case 'setUrlParams': {
          // The page shown keeps its other parameters; one evaluating to empty is removed.
          const params: Record<string, string> = {
            ...(this.model.get('url.params') as Record<string, string>),
          }
          for (const [key, value] of Object.entries(this.evaluateParams(action.params, locals))) {
            if (value === '') delete params[key]
            else params[key] = value
          }
          const page = (this.model.get('url.page') as string | null) ?? ''
          this.bridge.effect({ type: 'openPage', page, params, newTab: false })
          break
        }
        case 'copyToClipboard':
          this.utils().copyToClipboard(this.model.evaluateTemplate(action.text, locals))
          break
        case 'download':
          this.utils().downloadFile(
            this.model.evaluateTemplate(action.data, locals),
            String(this.model.evaluateTemplate(action.fileName, locals) ?? '') || 'download.txt',
          )
          break
        case 'setLocalStorage':
          this.setStorage(action.key, this.model.evaluateTemplate(action.value, locals))
          break
        case 'clearLocalStorage':
          this.setStorage(action.key ?? null, undefined)
          break
        case 'moduleEvent':
          // Outside an app (a module run on its own) there's nobody to handle it.
          if (this.options.onEvent) await this.options.onEvent(action.event)
          else this.bridge.log('info', `Module event: ${action.event}`)
          break
      }
      return true
    } catch (err) {
      this.notifyError(err, `${owner} (${handler.event}): ${message(err)}`)
      return false
    }
  }

  /** Tells the user about an error once, however many callers it passes through. */
  private notifyError(err: unknown, text: string) {
    if (err && typeof err === 'object') {
      if (this.notified.has(err)) return
      this.notified.add(err)
    }
    this.bridge.log('error', text)
    this.bridge.effect({ type: 'notify', message: text, tone: 'error' })
  }

  /** The methods code can call on an entity, by kind and component type. */
  private methodsFor(entity: Entity): Record<string, unknown> {
    const cached = this.methodCache.get(entity.name)
    if (cached) return cached
    const name = entity.name
    const key = (property: string) => `${name}.${property}`
    let methods: Record<string, unknown> = {}
    switch (entity.kind) {
      case 'query':
        methods = {
          trigger: (options?: { additionalScope?: Record<string, unknown> }) => this.trigger(name, options),
          reset: () => this.resetQuery(name),
        }
        break
      case 'variable':
        methods = {
          setValue: (value: unknown) => this.apply({ [key('value')]: value }),
          setIn: (path: string | (string | number)[], value: unknown) =>
            this.apply({ [key('value')]: setIn(this.model.get(key('value')), path, value) }),
        }
        break
      case 'transformer':
        break
      case 'component': {
        const type = entity.component.type
        methods.setHidden = (hidden: unknown) => this.apply({ [key('hidden')]: truthy(hidden) })
        if (type === 'custom') {
          // Its declared methods run in its frame (M25), on the page.
          for (const method of Object.keys(entity.spec?.methods ?? {})) {
            if (method !== 'setHidden') {
              methods[method] = (...args: unknown[]) => this.callComponent(name, method, args)
            }
          }
        }
        if (entity.spec?.input) {
          methods.setValue = (value: unknown) => this.apply({ [key('value')]: value })
          methods.clearValue = () =>
            this.apply({ [key('value')]: type === 'textInput' ? '' : type === 'checkbox' ? false : null })
        }
        if (type === 'table') {
          methods.selectRow = (index: unknown) => this.selectRow(name, index)
          methods.clearSelection = () =>
            this.apply({
              [key('selectedRow')]: null,
              [key('selectedRows')]: [],
              [key('selectedIndex')]: null,
            })
          methods.clearChangeset = () => this.apply({ [key('changesetArray')]: [], [key('newRows')]: [] })
          methods.saveChanges = async () => {
            const ok = await this.fire(name, 'save')
            if (ok) this.apply({ [key('changesetArray')]: [], [key('newRows')]: [] })
            return ok
          }
          methods.addRow = (row?: unknown) => {
            const current = this.model.get(key('newRows'))
            const added = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {}
            this.apply({ [key('newRows')]: [...(Array.isArray(current) ? current : []), added] })
            return this.fire(name, 'addRow')
          }
          methods.setPage = (page: unknown) => {
            const n = Number(page)
            this.apply({ [key('page')]: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 })
            return this.fire(name, 'pageChange')
          }
          methods.setSort = (column: unknown, desc?: unknown) => {
            const sort =
              column === null || column === undefined || column === ''
                ? null
                : { column: String(column), desc: truthy(desc) }
            this.apply({ [key('sort')]: sort, [key('page')]: 0 })
            return this.fire(name, 'sortChange')
          }
          methods.setSearchText = (text: unknown) => {
            this.apply({
              [key('searchText')]: text === null || text === undefined ? '' : String(text),
              [key('page')]: 0,
            })
            return this.fire(name, 'searchChange')
          }
          const setFilters = (filters: unknown) => {
            this.apply({ [key('filters')]: tableFilters(filters), [key('page')]: 0 })
            return this.fire(name, 'filterChange')
          }
          methods.setFilters = setFilters
          methods.clearFilters = () => setFilters([])
        }
        if (type === 'container') {
          const views = () => containerViews(entity.component).map((v) => v.name)
          const shown = () => {
            const current = this.model.get(key('currentView'))
            return views().includes(current as string) ? (current as string) : (views()[0] ?? null)
          }
          const show = (view: string) => {
            if (view === shown()) return true
            this.apply({ [key('currentView')]: view })
            return this.fire(name, 'viewChange')
          }
          methods.setView = (view: unknown) => {
            if (typeof view !== 'string' || !views().includes(view)) {
              throw new Error(
                `${name} has no view ${JSON.stringify(view)}: it has ${views().join(', ') || 'none'}`,
              )
            }
            return show(view)
          }
          const step = (by: 1 | -1) => {
            const list = views()
            const at = list.indexOf(shown() ?? '')
            const next = list[Math.max(0, Math.min(list.length - 1, at + by))]
            return next === undefined ? true : show(next)
          }
          methods.nextView = () => step(1)
          methods.previousView = () => step(-1)
          const fold = (expanded: boolean) => {
            if ((this.model.get(key('expanded')) !== false) === expanded) return true
            this.apply({ [key('expanded')]: expanded })
            return this.fire(name, expanded ? 'expand' : 'collapse')
          }
          methods.expand = () => fold(true)
          methods.collapse = () => fold(false)
          methods.toggle = () => fold(this.model.get(key('expanded')) === false)
        }
        if (type === 'form') {
          methods.submit = () => this.submitForm(name)
          methods.reset = () => this.resetForm(name)
        }
        if (type === 'modal') {
          methods.open = () => this.setOpen(name, true)
          methods.close = () => this.setOpen(name, false)
        }
        break
      }
    }
    this.methodCache.set(name, methods)
    return methods
  }

  private selectRow(table: string, index: unknown) {
    const rows = this.model.get(`${table}.data`)
    const i = typeof index === 'number' ? index : Number(index)
    const row = Array.isArray(rows) && Number.isInteger(i) ? (rows[i] ?? null) : null
    this.apply({
      [`${table}.selectedIndex`]: row === null ? null : i,
      [`${table}.selectedRow`]: row,
      [`${table}.selectedRows`]: row === null ? [] : [row],
    })
    return this.fire(table, 'rowSelect')
  }

  /**
   * Checks the form's required inputs, fires `submit`, and resets the inputs when every handler succeeded (a failed
   * save keeps what was typed). Resolves to whether it submitted.
   */
  private async submitForm(form: string): Promise<boolean> {
    if (truthy(this.model.get(`${form}.disabled`))) return false
    const missing = formInputs(this.definition, form).filter(
      (input) =>
        truthy(this.model.get(`${input}.required`)) &&
        !truthy(this.model.get(`${input}.hidden`)) &&
        isEmpty(this.model.get(`${input}.value`)),
    )
    if (missing.length) {
      const names = missing.map((input) => String(this.model.get(`${input}.label`) || input))
      this.bridge.effect({ type: 'notify', message: `Fill in ${names.join(', ')}`, tone: 'error' })
      return false
    }
    const ok = await this.fire(form, 'submit')
    if (ok && truthy(this.model.get(`${form}.resetAfterSubmit`))) this.resetForm(form)
    return ok
  }

  private resetForm(form: string) {
    const updates: Record<string, unknown> = {}
    for (const input of formInputs(this.definition, form)) {
      updates[`${input}.value`] = this.model.get(`${input}.defaultValue`)
    }
    this.apply(updates)
  }

  private setOpen(modal: string, open: boolean) {
    if (this.model.get(`${modal}.isOpen`) === open) return
    this.apply({ [`${modal}.isOpen`]: open })
    return this.fire(modal, open ? 'open' : 'close')
  }

  /** Query parameters from templates, as strings (objects as JSON); empty for null and undefined. */
  private evaluateParams(params: Record<string, string> | undefined, locals: Record<string, unknown>) {
    const out: Record<string, string> = {}
    for (const [key, template] of Object.entries(params ?? {})) {
      const value = this.model.evaluateTemplate(template, locals)
      out[key] =
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
    }
    return out
  }

  /**
   * Local storage (session 41): `localStorage.values` changes here, and the page keeps it for the app in this
   * browser. `key` null clears every key; `value` undefined removes the key.
   */
  private setStorage(key: string | null, value: unknown) {
    const before = (this.model.get('localStorage.values') as Record<string, unknown> | null) ?? {}
    let next: Record<string, unknown> = {}
    if (key !== null) {
      next = { ...before }
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this.apply({ 'localStorage.values': next })
    this.bridge.effect(value === undefined ? { type: 'storage', key } : { type: 'storage', key, value })
  }

  /** What app code sees as `utils`. */
  private utils() {
    return {
      notify: (message: unknown, tone: unknown = 'info') =>
        this.bridge.effect({
          type: 'notify',
          message: typeof message === 'string' ? message : JSON.stringify(message),
          tone: tone === 'success' || tone === 'error' ? tone : 'info',
        }),
      openUrl: (url: unknown, options: { newTab?: boolean } = {}) =>
        this.bridge.effect({ type: 'openUrl', url: String(url), newTab: options.newTab ?? false }),
      /**
       * Opens one of the app's pages, with query parameters (`{ id: 42 }` becomes `?id=42`, read back as
       * `url.params.id`, a string). The page changes once the page's URL has (see `navigate`).
       */
      openPage: (page: unknown, options: { params?: Record<string, unknown>; newTab?: boolean } = {}) => {
        const name = String(page)
        if (!this.definition.pages?.some((p) => p.name === name)) {
          const known = (this.definition.pages ?? []).map((p) => p.name)
          throw new Error(
            known.length
              ? `No page is named "${name}"; the pages are ${known.join(', ')}`
              : 'This app has no pages',
          )
        }
        const params: Record<string, string> = {}
        for (const [key, value] of Object.entries(options.params ?? {})) {
          if (value === null || value === undefined) continue
          params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value)
        }
        this.bridge.effect({ type: 'openPage', page: name, params, newTab: options.newTab === true })
      },
      copyToClipboard: (text: unknown) =>
        this.bridge.effect({ type: 'copy', text: typeof text === 'string' ? text : JSON.stringify(text) }),
      /**
       * Saves `data` as a file: a string as-is, an array of objects as CSV when the name ends in `.csv`, anything
       * else as JSON.
       */
      downloadFile: (data: unknown, fileName: unknown = 'download.txt') => {
        const file = String(fileName)
        const csv = file.toLowerCase().endsWith('.csv')
        const text =
          typeof data === 'string'
            ? data
            : csv && Array.isArray(data)
              ? toCsv(data)
              : JSON.stringify(data, null, 2)
        const mimeType = csv
          ? 'text/csv'
          : file.toLowerCase().endsWith('.json')
            ? 'application/json'
            : 'text/plain'
        this.bridge.effect({ type: 'download', data: text, fileName: file, mimeType })
      },
    }
  }
}

function handlersOf(entity: Entity): EventHandler[] {
  if (entity.kind === 'component') return entity.component.events ?? []
  if (entity.kind === 'query') return entity.query.events ?? []
  return []
}

/** Truthiness as people mean it in a template: `"false"` and `""` are false. */
export function truthy(value: unknown): boolean {
  if (value === 'false') return false
  return Boolean(value)
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A copy of `target` with the value at `path` (`a.b.0` or `['a', 'b', 0]`) replaced. */
export function setIn(target: unknown, path: string | (string | number)[], value: unknown): unknown {
  const keys = Array.isArray(path) ? path : path.split('.').filter(Boolean)
  if (!keys.length) return value
  const [head, ...rest] = keys
  const index = typeof head === 'number' || /^\d+$/.test(String(head)) ? Number(head) : null
  if (index !== null && (Array.isArray(target) || target === null || target === undefined)) {
    const copy = Array.isArray(target) ? [...target] : []
    copy[index] = setIn(copy[index], rest, value)
    return copy
  }
  const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {}
  const k = String(head)
  return { ...base, [k]: setIn((base as Record<string, unknown>)[k], rest, value) }
}

/** CSV of an array of objects: the keys of every row as columns; formula-like text guarded with a `'`. */
export function toCsv(rows: unknown[]): string {
  const columns = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))]
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return ''
    let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const lines = [columns.map(cell).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => cell((row as Record<string, unknown> | null)?.[c])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
