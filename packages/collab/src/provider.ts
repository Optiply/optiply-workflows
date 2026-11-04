import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as sync from 'y-protocols/sync'
import type * as Y from 'yjs'
import {
  CLOSE_ACCESS_LOST,
  type CollabStatus,
  MESSAGE_AWARENESS,
  MESSAGE_SAVE,
  MESSAGE_STATUS,
  MESSAGE_SYNC,
} from './protocol'

/**
 * `connecting`: opening the socket or syncing; `synced`: the document matches the server's (and edits go out as they
 * happen); `offline`: the connection dropped, edits wait and sync on reconnect; `closed`: the server ended it for good
 * (access lost), or `destroy`.
 */
export type ConnectionState = 'connecting' | 'synced' | 'offline' | 'closed'

export interface CollabProviderOptions {
  /** The document's WebSocket URL: `ws(s)://<host>/api/collab/<key>`. */
  url: string
  doc: Y.Doc
  awareness?: Awareness
  /** Opens a socket; browsers use `WebSocket` (with the session cookie), Node tests add the cookie header. */
  createSocket?: (url: string) => WebSocket
  /** After local edits are idle this long, the server is asked to save them. */
  saveAfterMs?: number
  /** Reconnect delays: from `minRetryMs`, doubling, up to `maxRetryMs`. */
  minRetryMs?: number
  maxRetryMs?: number
}

const DEFAULTS = { saveAfterMs: 500, minRetryMs: 500, maxRetryMs: 30_000 }

/**
 * The browser's side of `GET /api/collab/<key>` (architecture §2.19): keeps a Y.Doc and its presence in sync with the
 * server's, reconnecting with backoff (what was typed offline merges when it's back), and knows whether the server
 * has saved this side's edits to the draft (`unsaved`, `save()`).
 */
export class CollabProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  state: ConnectionState = 'connecting'
  /** The server's word on the draft, once it has spoken. */
  status: CollabStatus | null = null
  /** Local edits the server hasn't saved to the draft yet. */
  unsaved = false
  /** Why the server ended the connection for good. */
  closedReason: string | null = null

  private socket: WebSocket | null = null
  private options: typeof DEFAULTS & CollabProviderOptions
  private listeners = new Set<() => void>()
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Counts local edits; a save answered for the latest count means nothing is unsaved. */
  private edits = 0
  private nextToken = 1
  /** Saves asked for and not answered yet: the edit count they cover, and who waits. */
  private saves = new Map<number, { edits: number; resolve: (status: CollabStatus) => void }>()
  /** Saves wanted while not synced: sent once synced. */
  private waiting: ((status: CollabStatus) => void)[] = []

  constructor(options: CollabProviderOptions) {
    this.options = { ...DEFAULTS, ...options }
    this.doc = options.doc
    this.awareness = options.awareness ?? new Awareness(options.doc)
    this.doc.on('update', this.docUpdated)
    this.awareness.on('update', this.awarenessUpdated)
    this.connect()
  }

  /** Calls `listener` whenever `state`, `status` or `unsaved` changes (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Resolves with the draft's status once the server has saved every edit made here so far (waiting for the
   * connection if needed). The status's `error` says why it couldn't, when the merged document breaks the schema.
   */
  save(): Promise<CollabStatus> {
    return new Promise((resolve) => {
      if (this.state === 'closed')
        resolve(this.status ?? { revision: 0, error: this.closedReason ?? 'Closed' })
      else if (this.state === 'synced') this.requestSave(resolve)
      else this.waiting.push(resolve)
    })
  }

  destroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    this.doc.off('update', this.docUpdated)
    this.awareness.off('update', this.awarenessUpdated)
    this.setState('closed')
    this.socket?.close(1000)
    this.socket = null
    // Nobody will answer them now.
    const closed = { revision: this.status?.revision ?? 0, error: 'Closed' }
    for (const resolve of this.waiting.splice(0)) resolve(closed)
    for (const [, save] of this.saves) save.resolve(closed)
    this.saves.clear()
  }

  private connect(): void {
    if (this.state === 'closed') return
    const socket = this.options.createSocket?.(this.options.url) ?? new WebSocket(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      this.send((e) => {
        encoding.writeVarUint(e, MESSAGE_SYNC)
        sync.writeSyncStep1(e, this.doc)
      })
      if (this.awareness.getLocalState() !== null) {
        this.send((e) => {
          encoding.writeVarUint(e, MESSAGE_AWARENESS)
          encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
        })
      }
    }
    socket.onmessage = (event) => this.receive(new Uint8Array(event.data as ArrayBuffer))
    socket.onclose = (event) => this.closed(socket, event.code, event.reason)
  }

  private closed(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket || this.state === 'closed') return
    this.socket = null
    // Others' presence goes with the connection; it comes back with the next sync.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
    removeAwarenessStates(this.awareness, others, this)
    // Saves in flight are asked again once synced.
    for (const [, save] of this.saves) this.waiting.push(save.resolve)
    this.saves.clear()
    if (code === CLOSE_ACCESS_LOST) {
      this.closedReason = reason || 'Access lost'
      this.setState('closed')
      for (const resolve of this.waiting.splice(0))
        resolve({ revision: this.status?.revision ?? 0, error: this.closedReason })
      return
    }
    this.setState('offline')
    const delay = Math.min(this.options.maxRetryMs, this.options.minRetryMs * 2 ** this.retries++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.setState('connecting')
      this.connect()
    }, delay)
  }

  private receive(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      const kind = sync.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) this.socket?.send(encoding.toUint8Array(encoder))
      if (kind === sync.messageYjsSyncStep2 && this.state !== 'synced') this.synced()
    } else if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this)
    } else if (type === MESSAGE_STATUS) {
      this.status = JSON.parse(decoding.readVarString(decoder)) as CollabStatus
      this.notify()
    } else if (type === MESSAGE_SAVE) {
      const token = decoding.readVarUint(decoder)
      this.status = JSON.parse(decoding.readVarString(decoder)) as CollabStatus
      const save = this.saves.get(token)
      this.saves.delete(token)
      if (save && save.edits === this.edits && !this.status.error) this.unsaved = false
      this.notify()
      save?.resolve(this.status)
    }
  }

  /** The document matches the server's: what was typed offline went with our step 2. Waiting saves go now. */
  private synced(): void {
    // Only now: the server accepts the socket before it admits anyone, and one that fails after that would otherwise
    // be retried every half second.
    this.retries = 0
    this.setState('synced')
    for (const resolve of this.waiting.splice(0)) this.requestSave(resolve)
    if (this.unsaved && !this.saves.size) this.requestSave(() => {})
  }

  private requestSave(resolve: (status: CollabStatus) => void): void {
    const token = this.nextToken++
    this.saves.set(token, { edits: this.edits, resolve })
    this.send((e) => {
      encoding.writeVarUint(e, MESSAGE_SAVE)
      encoding.writeVarUint(e, token)
    })
  }

  private docUpdated = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return
    this.edits++
    if (!this.unsaved) {
      this.unsaved = true
      this.notify()
    }
    if (this.state === 'synced') {
      this.send((e) => {
        encoding.writeVarUint(e, MESSAGE_SYNC)
        sync.writeUpdate(e, update)
      })
    }
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.state === 'synced') this.requestSave(() => {})
    }, this.options.saveAfterMs)
  }

  private awarenessUpdated = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return
    const changed = [...added, ...updated, ...removed]
    this.send((e) => {
      encoding.writeVarUint(e, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, changed))
    })
  }

  private send(write: (encoder: encoding.Encoder) => void): void {
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) return
    const encoder = encoding.createEncoder()
    write(encoder)
    socket.send(encoding.toUint8Array(encoder))
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export type { Awareness } from 'y-protocols/awareness'
