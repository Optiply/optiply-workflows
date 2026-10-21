import { randomUUID } from 'node:crypto'
import {
  type CollabStatus,
  MESSAGE_AWARENESS,
  MESSAGE_SAVE,
  MESSAGE_STATUS,
  MESSAGE_SYNC,
  SharedDefinition,
} from '@ow/collab'
import type { FastifyBaseLogger } from 'fastify'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type postgres from 'postgres'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import { COLLAB_CHANNEL, type CollabStore, foldUpdate } from './store'
import type { CollabTarget } from './target'

/** Updates stored since the last compaction before a room compacts its document. */
const COMPACT_EVERY = 200
/** While edits flow, the draft is written at most this often. */
const WRITE_MS = 1000

/** One open editor: a WebSocket, as the room sees it. */
export interface CollabPeer {
  /** Who it is, as everyone's presence shows them; set by the server, whatever the browser says. */
  user: { id: string; name: string; avatarUrl: string | null }
  readOnly: boolean
  send(message: Uint8Array): void
  close(code: number, reason: string): void
}

/** The origin of the updates a room loads from the store: they're stored already. */
const LOADED = Symbol('loaded')
/** The origin of a draft folded in: the fold stores it. */
const FOLDED = Symbol('folded')
/** The origin of what another process relays: it stores its own updates, and relays its own presence. */
const RELAYED = Symbol('relayed')

/**
 * A document open in this process, with the people editing it here. Updates from one peer go to the others and to
 * the store, in order; presence (awareness) goes to everyone. The document is written to its draft (schema-checked)
 * at most once a second while edits flow and when the last peer leaves, and a draft written by anything else is
 * folded into it. Everything that touches Postgres runs one at a time, in order.
 */
export class CollabRoom {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  readonly shared: SharedDefinition<unknown>
  /** The peers here, with the awareness client ids each has spoken for. */
  readonly peers = new Map<CollabPeer, Set<number>>()
  /** Awareness client ids that peers in other processes speak for. */
  private remoteIds = new Set<number>()
  destroyed = false
  /** The draft revision the document last matched. */
  revision = 0
  /** Why the document's latest state couldn't be written to the draft; null when it could. */
  error: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private sinceCompaction = 0
  private writeTimer: NodeJS.Timeout | null = null
  /** Who last edited here: the draft's `updatedBy` when it's written. */
  private lastEditor: string | null = null
  /** Edits not written to the draft yet (or a write the schema refused). */
  private dirty = false

  constructor(
    readonly target: CollabTarget,
    private store: CollabStore,
    private log: FastifyBaseLogger,
    private failed: (room: CollabRoom, err: unknown) => void,
    /** This process, as its announcements say. */
    private source: string,
  ) {
    this.shared = new SharedDefinition(this.doc, target.spec)
    this.awareness.setLocalState(null)
    this.doc.on('update', this.updated)
    this.awareness.on('update', this.awarenessUpdated)
  }

  get key(): string {
    return this.target.key
  }

  /** Applies what the store holds. */
  load(updates: Uint8Array[], revision: number): void {
    this.revision = revision
    Y.transact(
      this.doc,
      () => {
        for (const u of updates) Y.applyUpdate(this.doc, u)
      },
      LOADED,
    )
  }

  add(peer: CollabPeer): void {
    this.peers.set(peer, new Set())
    // Our state vector (the peer answers with what we lack: edits made offline), who's here, how the draft stands.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    sync.writeSyncStep1(encoder, this.doc)
    peer.send(encoding.toUint8Array(encoder))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) peer.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, states)))
    peer.send(this.statusMessage())
  }

  /** Removes a peer and its presence. Returns whether the room is now empty. */
  remove(peer: CollabPeer): boolean {
    const ids = this.peers.get(peer)
    this.peers.delete(peer)
    if (ids?.size) removeAwarenessStates(this.awareness, [...ids], null)
    return this.peers.size === 0
  }

  /** Handles one message from a peer; a malformed one closes its connection. */
  receive(peer: CollabPeer, message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message)
      const type = decoding.readVarUint(decoder)
      if (type === MESSAGE_SYNC) this.receiveSync(peer, decoder)
      else if (type === MESSAGE_AWARENESS) this.receiveAwareness(peer, decoding.readVarUint8Array(decoder))
      else if (type === MESSAGE_SAVE) this.receiveSave(peer, decoding.readVarUint(decoder))
      else throw new Error(`unknown message type ${type}`)
    } catch (err) {
      this.log.debug({ err, key: this.key }, 'collab: bad message')
      peer.close(1002, 'Bad message')
    }
  }

  /** The draft was written at `revision` (by anyone): fold it in if the document hasn't matched it yet. */
  drafted(revision: number): void {
    if (revision > this.revision) this.enqueue(() => this.fold())
  }

  /** Another process stored update `id`: apply it (or the whole stored document, if it was compacted meanwhile). */
  relayed(id: number): void {
    this.enqueue(async () => {
      const update = await this.store.fetch(id)
      if (this.destroyed) return
      if (update) Y.applyUpdate(this.doc, update, RELAYED)
      else await this.resync()
    })
  }

  /** Presence changed in another process. */
  relayedPresence(update: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, update, RELAYED)
  }

  /** Another process opened the document: tell it who is here. */
  announcePresence(): void {
    const ids = [...this.peers.values()].flatMap((owned) => [...owned])
    if (!ids.length) return
    this.store
      .announcePresence(this.key, encodeAwarenessUpdate(this.awareness, ids), this.source)
      .catch((err) => this.log.warn({ err, key: this.key }, 'collab: relaying presence failed'))
  }

  /** Catches up on what this process might have missed (its LISTEN connection dropped): updates, and a draft. */
  recheck(): void {
    this.enqueue(async () => {
      await this.resync()
      await this.fold()
    })
  }

  /** Writes the draft now if edits are waiting, then resolves once everything so far is stored. */
  settle(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
      this.enqueue(() => this.write())
    }
    return this.queue
  }

  /** Compacts the document if updates were stored since it was last compacted. */
  async compact(): Promise<void> {
    if (!this.sinceCompaction) return
    this.sinceCompaction = 0
    await this.store.compact(this.key)
  }

  destroy(): void {
    this.destroyed = true
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.doc.off('update', this.updated)
    this.awareness.off('update', this.awarenessUpdated)
    this.shared.destroy()
    this.awareness.destroy()
    this.doc.destroy()
  }

  /** Applies the document as stored: whatever this process lacks (applying the rest again changes nothing). */
  private async resync(): Promise<void> {
    const updates = await this.store.read(this.key)
    if (this.destroyed) return
    Y.transact(
      this.doc,
      () => {
        for (const u of updates) Y.applyUpdate(this.doc, u)
      },
      RELAYED,
    )
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err) => this.failed(this, err))
  }

  /** Writes the document to its draft, if the schema accepts it; a newer draft is folded in instead. */
  /**
   * A peer asks for the draft to have everything it sent so far: those edits are in the document (messages arrive in
   * order), so writing it now and answering after covers them. A watcher just gets the status.
   */
  private receiveSave(peer: CollabPeer, token: number): void {
    if (!peer.readOnly) {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer)
        this.writeTimer = null
      }
      this.enqueue(() => this.write())
    }
    // The queue never rejects (enqueue catches), so this answers after the write, whatever it did.
    void this.queue.then(() => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SAVE)
      encoding.writeVarUint(encoder, token)
      encoding.writeVarString(encoder, JSON.stringify(this.currentStatus()))
      peer.send(encoding.toUint8Array(encoder))
    })
  }

  private async write(): Promise<void> {
    if (this.destroyed || !this.dirty) return
    this.dirty = false
    const definition = this.shared.value
    const problem = this.target.check(definition)
    if (problem) {
      // Still to write once fixed.
      this.dirty = true
      if (problem !== this.error) {
        this.log.warn({ key: this.key, problem }, "collab: the merged document doesn't fit the schema")
        this.error = problem
        this.broadcastStatus()
      }
      return
    }
    const result = await this.store.write(this.target, definition, this.lastEditor)
    if ('fold' in result) return this.fold()
    const changed = result.revision !== this.revision || this.error !== null
    this.revision = result.revision
    this.error = null
    if (changed) this.broadcastStatus()
  }

  /** Folds a draft written by something else into the document (stored once, whichever process gets there first). */
  private async fold(): Promise<void> {
    if (this.destroyed) return
    const folded = await this.store.fold(
      this.target,
      (definition) => foldUpdate(this.doc, this.target, definition, FOLDED),
      this.source,
    )
    if (!folded || folded.revision === this.revision) return
    this.revision = folded.revision
    this.error = null
    this.broadcastStatus()
  }

  private scheduleWrite(): void {
    this.writeTimer ??= setTimeout(() => {
      this.writeTimer = null
      this.enqueue(() => this.write())
    }, WRITE_MS)
  }

  private currentStatus(): CollabStatus {
    return { revision: this.revision, error: this.error }
  }

  private statusMessage(): Uint8Array {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_STATUS)
    encoding.writeVarString(encoder, JSON.stringify(this.currentStatus()))
    return encoding.toUint8Array(encoder)
  }

  private broadcastStatus(): void {
    const message = this.statusMessage()
    for (const peer of this.peers.keys()) peer.send(message)
  }

  private receiveSync(peer: CollabPeer, decoder: decoding.Decoder): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    if (peer.readOnly) {
      // A watcher may ask for the document; what it sends is dropped.
      if (decoding.readVarUint(decoder) === sync.messageYjsSyncStep1)
        sync.readSyncStep1(decoder, encoder, this.doc)
    } else sync.readSyncMessage(decoder, encoder, this.doc, peer)
    if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder))
  }

  /**
   * Applies a peer's presence: only for client ids no other peer here speaks for, and with `user` set to who the
   * peer is, so nobody shows up as someone else.
   */
  private receiveAwareness(peer: CollabPeer, update: Uint8Array): void {
    const owned = this.peers.get(peer)
    if (!owned) return
    const decoder = decoding.createDecoder(update)
    const entries: [clientId: number, clock: number, state: string][] = []
    const count = decoding.readVarUint(decoder)
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder)
      const clock = decoding.readVarUint(decoder)
      const raw = JSON.parse(decoding.readVarString(decoder)) as unknown
      const taken =
        this.remoteIds.has(clientId) ||
        [...this.peers].some(([other, ids]) => other !== peer && ids.has(clientId))
      if (taken) continue
      owned.add(clientId)
      const state = raw !== null && typeof raw === 'object' ? { ...raw, user: peer.user } : null
      entries.push([clientId, clock, JSON.stringify(state)])
    }
    if (!entries.length) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, entries.length)
    for (const [clientId, clock, state] of entries) {
      encoding.writeVarUint(encoder, clientId)
      encoding.writeVarUint(encoder, clock)
      encoding.writeVarString(encoder, state)
    }
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), peer)
  }

  private updated = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOADED) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    sync.writeUpdate(encoder, update)
    const message = encoding.toUint8Array(encoder)
    for (const peer of this.peers.keys()) if (peer !== origin) peer.send(message)
    // A fold is stored with its revision, and already matches the draft; another process stores its own updates.
    if (origin === FOLDED || origin === RELAYED) return
    if (this.peers.has(origin as CollabPeer)) this.lastEditor = (origin as CollabPeer).user.id
    this.enqueue(async () => {
      await this.store.append(this.key, update, this.source)
      if (++this.sinceCompaction >= COMPACT_EVERY) await this.compact()
    })
    this.dirty = true
    this.scheduleWrite()
  }

  private awarenessUpdated = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin && this.peers.has(origin as CollabPeer)) {
      for (const id of removed) this.peers.get(origin as CollabPeer)?.delete(id)
    }
    if (origin === RELAYED) {
      for (const id of [...added, ...updated]) this.remoteIds.add(id)
      for (const id of removed) this.remoteIds.delete(id)
    }
    const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])
    const message = awarenessMessage(update)
    for (const peer of this.peers.keys()) peer.send(message)
    // Ours (a peer here, or one leaving): to the other processes too.
    if (origin !== RELAYED) {
      this.store.announcePresence(this.key, update, this.source).then(
        (sent) => {
          if (!sent) this.log.warn({ key: this.key }, 'collab: presence too large to relay')
        },
        (err) => this.log.warn({ err, key: this.key }, 'collab: relaying presence failed'),
      )
    }
  }
}

function awarenessMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * The rooms of this process: one per open document, made when the first peer arrives (loading the document from the
 * store) and, once the last one leaves and the draft is written, compacted and closed. With a LISTEN connection, a
 * draft written by anything is folded into its open document.
 */
export class CollabHub {
  private rooms = new Map<string, Promise<CollabRoom>>()
  /** The rooms opened so far, by key, for announcements. */
  private open = new Map<string, CollabRoom>()
  private listening: Promise<unknown> | undefined
  /** This process, in its announcements, so it ignores its own. */
  private readonly source = randomUUID()

  constructor(
    private store: CollabStore,
    private log: FastifyBaseLogger,
    private listener?: postgres.Sql,
  ) {}

  /** Puts a peer in the target's room, opening it if needed. */
  async join(target: CollabTarget, peer: CollabPeer): Promise<CollabRoom> {
    await this.listen()
    for (;;) {
      let opening = this.rooms.get(target.key)
      if (!opening) {
        opening = this.openRoom(target)
        this.rooms.set(target.key, opening)
        opening.catch(() => this.rooms.delete(target.key))
      }
      const room = await opening
      // Closed while we waited: open it again.
      if (room.destroyed) continue
      room.add(peer)
      return room
    }
  }

  /** Takes a peer out; the last one out writes the draft, then the room closes and its document is compacted. */
  async leave(room: CollabRoom, peer: CollabPeer): Promise<void> {
    if (!room.remove(peer)) return
    try {
      await room.settle()
      if (room.peers.size || room.destroyed) return
      this.forget(room)
      await room.compact()
    } catch (err) {
      this.log.error({ err, key: room.key }, 'collab: closing a document failed')
    }
  }

  /** Closes every room (shutting down): peers are told to reconnect, and the drafts are written first. */
  async close(): Promise<void> {
    const rooms = await Promise.all([...this.rooms.values()].map((p) => p.catch(() => null)))
    await Promise.all(
      rooms.map(async (room) => {
        if (!room) return
        for (const peer of room.peers.keys()) peer.close(1012, 'Server restarting')
        await room.settle()
        this.forget(room)
      }),
    )
    const listening = this.listening
    this.listening = undefined
    const subscription = (await listening?.catch(() => undefined)) as
      | { unlisten(): Promise<void> }
      | undefined
    await subscription?.unlisten()
  }

  /** Listens for drafts written by anything; after a reconnect, every open room checks what it may have missed. */
  private async listen(): Promise<void> {
    if (!this.listener) return
    this.listening ??= this.listener.listen(
      COLLAB_CHANNEL,
      (payload) => this.announced(payload),
      () => {
        for (const room of this.open.values()) room.recheck()
      },
    )
    try {
      await this.listening
    } catch (err) {
      this.listening = undefined
      throw err
    }
  }

  private announced(payload: string): void {
    let message: { d?: unknown; r?: unknown; u?: unknown; a?: unknown; q?: unknown; p?: unknown }
    try {
      message = JSON.parse(payload)
    } catch {
      return
    }
    const room = typeof message.d === 'string' ? this.open.get(message.d) : undefined
    if (!room || message.p === this.source) return
    if (typeof message.r === 'number') room.drafted(message.r)
    else if (typeof message.u === 'number') room.relayed(message.u)
    else if (typeof message.a === 'string')
      room.relayedPresence(new Uint8Array(Buffer.from(message.a, 'base64')))
    else if (message.q) room.announcePresence()
  }

  private async openRoom(target: CollabTarget): Promise<CollabRoom> {
    const { updates, revision } = await this.store.load(target)
    const room = new CollabRoom(target, this.store, this.log, (r, err) => this.fail(r, err), this.source)
    room.load(updates, revision)
    this.open.set(target.key, room)
    // What other processes announced between the load and now, and who is there already.
    room.recheck()
    if (this.listener) {
      this.store
        .askPresence(target.key, this.source)
        .catch((err) => this.log.warn({ err, key: target.key }, 'collab: asking for presence failed'))
    }
    return room
  }

  /**
   * Storing failed: the room closes and its peers reconnect, sending again whatever the store lacks (a sync exchange
   * recovers any difference).
   */
  private fail(room: CollabRoom, err: unknown): void {
    if (room.destroyed) return
    this.log.error({ err, key: room.key }, 'collab: storing failed')
    for (const peer of room.peers.keys()) peer.close(1011, 'Could not save; reconnecting')
    this.forget(room)
  }

  private forget(room: CollabRoom): void {
    if (this.open.get(room.key) === room) {
      this.open.delete(room.key)
      this.rooms.delete(room.key)
    }
    room.destroy()
  }
}
