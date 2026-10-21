import { MESSAGE_AWARENESS, MESSAGE_SYNC } from '@ow/collab'
import type { FastifyBaseLogger } from 'fastify'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import type { CollabStore } from './store'
import type { CollabTarget } from './target'

/** Updates stored since the last compaction before a room compacts its document. */
const COMPACT_EVERY = 200

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

/**
 * A document open in this process, with the people editing it here. Updates from one peer go to the others and to
 * the store, in order; presence (awareness) goes to everyone.
 */
export class CollabRoom {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  /** The peers here, with the awareness client ids each has spoken for. */
  readonly peers = new Map<CollabPeer, Set<number>>()
  destroyed = false
  private stored: Promise<void> = Promise.resolve()
  private sinceCompaction = 0

  constructor(
    readonly key: string,
    private store: CollabStore,
    private log: FastifyBaseLogger,
    private failed: (room: CollabRoom, err: unknown) => void,
  ) {
    this.awareness.setLocalState(null)
    this.doc.on('update', this.updated)
    this.awareness.on('update', this.awarenessUpdated)
  }

  /** Applies what the store holds. */
  load(updates: Uint8Array[]): void {
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
    // Our state vector (the peer answers with what we lack: edits made offline), then who's here.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    sync.writeSyncStep1(encoder, this.doc)
    peer.send(encoding.toUint8Array(encoder))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) peer.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, states)))
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
      else throw new Error(`unknown message type ${type}`)
    } catch (err) {
      this.log.debug({ err, key: this.key }, 'collab: bad message')
      peer.close(1002, 'Bad message')
    }
  }

  /** Resolves when every update so far is stored. */
  flush(): Promise<void> {
    return this.stored
  }

  /** Compacts the document if updates were stored since it was last compacted. */
  async compact(): Promise<void> {
    if (!this.sinceCompaction) return
    this.sinceCompaction = 0
    await this.store.compact(this.key)
  }

  destroy(): void {
    this.destroyed = true
    this.doc.off('update', this.updated)
    this.awareness.off('update', this.awarenessUpdated)
    this.awareness.destroy()
    this.doc.destroy()
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
      const taken = [...this.peers].some(([other, ids]) => other !== peer && ids.has(clientId))
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
    this.stored = this.stored
      .then(async () => {
        await this.store.append(this.key, update)
        if (++this.sinceCompaction >= COMPACT_EVERY) await this.compact()
      })
      .catch((err) => this.failed(this, err))
  }

  private awarenessUpdated = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin && this.peers.has(origin as CollabPeer)) {
      for (const id of removed) this.peers.get(origin as CollabPeer)?.delete(id)
    }
    const message = awarenessMessage(
      encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
    )
    for (const peer of this.peers.keys()) peer.send(message)
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
 * store) and, once the last one leaves and its updates are stored, compacted and closed.
 */
export class CollabHub {
  private rooms = new Map<string, Promise<CollabRoom>>()

  constructor(
    private store: CollabStore,
    private log: FastifyBaseLogger,
  ) {}

  /** Puts a peer in the target's room, opening it if needed. */
  async join(target: CollabTarget, peer: CollabPeer): Promise<CollabRoom> {
    for (;;) {
      let opening = this.rooms.get(target.key)
      if (!opening) {
        opening = this.open(target)
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

  /** Takes a peer out; the last one out closes the room once its updates are stored. */
  async leave(room: CollabRoom, peer: CollabPeer): Promise<void> {
    if (!room.remove(peer)) return
    try {
      await room.flush()
      if (room.peers.size || room.destroyed) return
      this.forget(room)
      await room.compact()
    } catch (err) {
      this.log.error({ err, key: room.key }, 'collab: closing a document failed')
    }
  }

  /** Closes every room (shutting down): peers are told to reconnect, and what they sent is stored first. */
  async close(): Promise<void> {
    const rooms = await Promise.all([...this.rooms.values()].map((p) => p.catch(() => null)))
    await Promise.all(
      rooms.map(async (room) => {
        if (!room) return
        for (const peer of room.peers.keys()) peer.close(1012, 'Server restarting')
        await room.flush()
        this.forget(room)
      }),
    )
  }

  private async open(target: CollabTarget): Promise<CollabRoom> {
    const updates = await this.store.load(target)
    const room = new CollabRoom(target.key, this.store, this.log, (r, err) => this.fail(r, err))
    room.load(updates)
    return room
  }

  /**
   * Storing an update failed: the room closes and its peers reconnect, sending again whatever the store lacks (a
   * sync exchange recovers any difference).
   */
  private fail(room: CollabRoom, err: unknown): void {
    if (room.destroyed) return
    this.log.error({ err, key: room.key }, 'collab: storing an update failed')
    for (const peer of room.peers.keys()) peer.close(1011, 'Could not save; reconnecting')
    this.forget(room)
  }

  private forget(room: CollabRoom): void {
    void this.rooms.get(room.key)?.then((current) => {
      if (current === room) this.rooms.delete(room.key)
    })
    room.destroy()
  }
}
