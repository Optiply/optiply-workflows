import {
  type AppDefinition,
  AppModel,
  type AppQuery,
  browserExpressions,
  type CodeRunner,
  type Entity,
  type EventHandler,
  formInputs,
} from '@ow/app-definition'
import type { Effect, LogLevel, QueryOutcome, StatePatch } from './protocol'

/**
 * Runs an app inside its sandbox: the reactive model, queries (automatic and manual, resource and JS), component
 * and query methods, event handlers and `utils`. Everything outside the sandbox goes through a `HostBridge`, so
 * this runs the same in the browser and in tests.
 */

/** What the runtime needs from the page. */
export interface HostBridge {
  /** Runs one of the app's resource queries on the server with the values of its `{{ }}`s. */
  runQuery(query: string, values: Record<string, unknown>): Promise<QueryOutcome>
  /** Asks the user to confirm before a query runs. */
  confirm(message: string): Promise<boolean>
  effect(effect: Effect): void
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
}

/** A query failure, marked once the user has been told so callers up the chain don't tell them again. */
class QueryFailure extends Error {
  notified = false
}

export class AppRuntime {
  readonly model: AppModel
  private readonly queries: Map<string, AppQuery>
  private readonly runs = new Map<string, number>()
  private readonly autoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly methodCache = new Map<string, Record<string, unknown>>()
  private readonly notified = new WeakSet<object>()
  private readonly autoRunDelayMs: number
  private lastErrors = '{}'
  private stopped = false

  constructor(
    readonly definition: AppDefinition,
    private readonly bridge: HostBridge,
    options: AppRuntimeOptions = {},
  ) {
    this.queries = new Map(definition.queries.map((q) => [q.name, q]))
    this.autoRunDelayMs = options.autoRunDelayMs ?? 100
    this.model = new AppModel(definition, {
      ...(options.runner && { runner: options.runner }),
      globals: { ...options.globals, utils: this.utils() },
      methods: (entity) => this.methodsFor(entity),
    })
  }

  /** Evaluates the app, sends the first patch and runs what runs on load. Resolves when those queries finish. */
  async start(): Promise<void> {
    this.model.init()
    const values: Record<string, unknown> = {}
    for (const key of this.model.graph.order) {
      if (!this.model.graph.nodes.get(key)!.property.startsWith('$')) values[key] = this.model.get(key)
    }
    this.publish(values)
    const onLoad = this.definition.queries.filter(
      (q) => (q.kind === 'resource' && q.run === 'auto') || q.runOnLoad,
    )
    await Promise.allSettled(onLoad.map((q) => this.runQuiet(q.name)))
  }

  /** Stops timers; later results are ignored. */
  stop(): void {
    this.stopped = true
    for (const timer of [...this.autoTimers.values(), ...this.debounced.values()]) clearTimeout(timer)
  }

  /** Values the user changed (typing, selecting, editing a cell). */
  set(updates: Record<string, unknown>): void {
    this.apply(updates)
  }

  /**
   * Runs the handlers of `owner`'s `event`, in parallel (like Retool). Resolves when they're done, to whether all of
   * them succeeded; a failing handler is reported to the user, not thrown.
   */
  async fire(owner: string, event: string, locals: Record<string, unknown> = {}): Promise<boolean> {
    const entity = this.model.graph.entities.get(owner)
    const handlers = entity ? handlersOf(entity).filter((h) => h.event === event) : []
    const results = await Promise.all(
      handlers.map((h) => {
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
      if (query.kind === 'resource') {
        const values: Record<string, unknown> = {}
        for (const code of browserExpressions(query.query)) {
          try {
            values[code] = this.model.evaluateExpression(code, locals)
          } catch (err) {
            throw new QueryFailure(`Error in {{${code}}}: ${message(err)}`)
          }
        }
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

  /** Sets values, publishes what changed and schedules the automatic queries whose inputs changed. */
  private apply(updates: Record<string, unknown>): void {
    if (this.stopped) return
    const changed = this.model.set(updates)
    const values: Record<string, unknown> = {}
    for (const key of changed) {
      const node = this.model.graph.nodes.get(key)!
      if (node.kind === 'trigger') this.scheduleAuto(node.entity)
      else values[key] = this.model.get(key)
    }
    this.publish(values)
  }

  private publish(values: Record<string, unknown>) {
    const errors = Object.fromEntries(this.model.allErrors())
    const text = JSON.stringify(errors)
    const errorsChanged = text !== this.lastErrors
    this.lastErrors = text
    if (!Object.keys(values).length && !errorsChanged) return
    this.bridge.publish({ values, ...(errorsChanged && { errors }) })
  }

  private scheduleAuto(name: string) {
    clearTimeout(this.autoTimers.get(name))
    this.autoTimers.set(
      name,
      setTimeout(() => {
        this.autoTimers.delete(name)
        void this.runQuiet(name)
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
          methods.clearChangeset = () => this.apply({ [key('changesetArray')]: [] })
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
