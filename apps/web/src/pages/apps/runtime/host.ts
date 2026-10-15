import runtimeCode from 'virtual:app-runtime'
import type { AppDefinition } from '@ow/app-definition'
import {
  CONNECT_MESSAGE,
  type Effect,
  type HostMessage,
  type LogLevel,
  type QueryOutcome,
  type RuntimeGlobals,
  type SandboxMessage,
} from '@ow/app-runtime'
import { STDLIB_BUNDLE } from '@ow/sandbox/stdlib'
import { TRPCClientError } from '@trpc/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { trpcClient } from '@/lib/trpc'

/**
 * The page's side of a running app. It creates the app's sandbox (a hidden iframe with an opaque origin and no
 * network access), sends it the definition, and then:
 * - runs the resource queries it asks for through the API (the server checks them against the stored app);
 * - keeps the app's state in a store for the components to render;
 * - passes the user's input and events in;
 * - carries out effects (notifications, links, downloads) after checking them, since the app's code is untrusted.
 */

export interface AppHostState {
  status: 'loading' | 'ready' | 'failed'
  /** Values by node key (`table1.selectedRow`). */
  values: Record<string, unknown>
  /** Errors by node key. */
  errors: Record<string, string>
  /** Why the app couldn't start, or that a newer version is live. */
  problem: string | null
  /** The app's console, newest last (at most 500 lines). */
  logs: { id: number; level: LogLevel; message: string; at: number }[]
}

export interface AppHostOptions {
  definition: AppDefinition
  appId: string
  /** The release being shown, or null for the draft (the editor). */
  releaseId: string | null
  environmentId: string
  globals: RuntimeGlobals
  /** Shows a notification. */
  notify(message: string, tone: 'info' | 'success' | 'error'): void
  /** Asks the user to confirm before a query runs. */
  confirm(message: string): Promise<boolean>
  /** Called before each resource query runs (the editor saves the draft: the server runs what's saved). */
  beforeQuery?: () => Promise<void>
}

/** The sandbox's own policy: inline scripts and `new Function` only; no requests of any kind. */
const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"

/** Only these can be opened from an app. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const DOWNLOAD_TYPES = new Set(['text/plain', 'text/csv', 'application/json'])

function inlineScript(code: string): string {
  // `</script` would end the element early; `<\/script` means the same in JavaScript.
  return `<script>${code.replaceAll('</script', '<\\/script')}</script>`
}

export function sandboxDocument(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '</head><body>',
    inlineScript(STDLIB_BUNDLE),
    inlineScript(runtimeCode),
    '</body></html>',
  ].join('')
}

export class AppHost {
  readonly store: StoreApi<AppHostState>
  private iframe: HTMLIFrameElement | null = null
  private port: MessagePort | null = null
  private destroyed = false
  private logId = 0
  /** The definition the sandbox should run; an update before it started goes out with `start`. */
  private definition: AppDefinition
  /** What `start` sent; an edit made while the sandbox was starting follows as an update. */
  private startedWith: AppDefinition | null = null

  constructor(private readonly options: AppHostOptions) {
    this.definition = options.definition
    this.store = createStore<AppHostState>(() => ({
      status: 'loading',
      values: {},
      errors: {},
      problem: null,
      logs: [],
    }))
  }

  /** Creates the sandbox inside `container` (it stays hidden) and starts the app. */
  mount(container: HTMLElement): void {
    const iframe = document.createElement('iframe')
    // No allow-same-origin: the frame gets an opaque origin, so it can't touch this page or its cookies.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.title = 'App sandbox'
    iframe.style.display = 'none'
    iframe.srcdoc = sandboxDocument()
    iframe.addEventListener('load', () => this.connect(iframe), { once: true })
    container.appendChild(iframe)
    this.iframe = iframe
  }

  destroy(): void {
    this.destroyed = true
    this.port?.close()
    this.iframe?.remove()
    this.iframe = null
    this.port = null
  }

  set(updates: Record<string, unknown>): void {
    this.store.setState((s) => ({ values: { ...s.values, ...updates } }))
    this.post({ type: 'set', updates })
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

  /** The editor changed the app: the sandbox switches to it, keeping what the user did. */
  update(definition: AppDefinition): void {
    if (definition === this.definition) return
    this.definition = definition
    if (this.store.getState().status !== 'loading') this.post({ type: 'update', definition })
  }

  private connect(iframe: HTMLIFrameElement) {
    if (this.destroyed || !iframe.contentWindow) return
    const channel = new MessageChannel()
    this.port = channel.port1
    this.port.onmessage = (e: MessageEvent<SandboxMessage>) => void this.handle(e.data)
    // The frame's origin is opaque, so `*` is the only target that reaches it; the port does the rest.
    iframe.contentWindow.postMessage(CONNECT_MESSAGE, '*', [channel.port2])
  }

  private post(message: HostMessage) {
    this.port?.postMessage(message)
  }

  private async handle(message: SandboxMessage) {
    if (this.destroyed) return
    switch (message.type) {
      case 'ready':
        this.startedWith = this.definition
        this.post({ type: 'start', definition: this.definition, globals: this.options.globals })
        return
      case 'started':
        this.store.setState({ status: 'ready' })
        if (this.definition !== this.startedWith) this.post({ type: 'update', definition: this.definition })
        return
      case 'fatal':
        this.store.setState({ status: 'failed', problem: message.message })
        return
      case 'patch': {
        const { values, errors } = message.patch
        this.store.setState((s) => ({ values: { ...s.values, ...values }, ...(errors && { errors }) }))
        return
      }
      case 'runQuery':
        this.post({
          type: 'queryResult',
          id: message.id,
          outcome: await this.runQuery(message.query, message.values),
        })
        return
      case 'confirm':
        this.post({
          type: 'confirmResult',
          id: message.id,
          ok: await this.options.confirm(String(message.message)),
        })
        return
      case 'effect':
        this.effect(message.effect)
        return
      case 'log':
        this.store.setState((s) => ({
          logs: [
            ...s.logs,
            { id: ++this.logId, level: message.level, message: String(message.message), at: Date.now() },
          ].slice(-500),
        }))
        return
    }
  }

  private async runQuery(query: string, values: Record<string, unknown>): Promise<QueryOutcome> {
    try {
      await this.options.beforeQuery?.()
      const outcome = await trpcClient.apps.runQuery.mutate({
        appId: this.options.appId,
        releaseId: this.options.releaseId,
        query: String(query),
        environmentId: this.options.environmentId,
        values,
      })
      return outcome.ok
        ? { ok: true, data: outcome.data }
        : { ok: false, error: { code: outcome.error.code, message: outcome.error.message } }
    } catch (err) {
      const code = err instanceof TRPCClientError ? (err.data?.code as string | undefined) : undefined
      const message = err instanceof Error ? err.message : 'The query could not be run'
      if (code === 'CONFLICT') this.store.setState({ problem: message })
      return { ok: false, error: { ...(code && { code }), message } }
    }
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
