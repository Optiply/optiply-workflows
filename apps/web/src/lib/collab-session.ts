import { type Awareness, CollabProvider, type CollabSpec, SharedDefinition } from '@ow/collab'
import * as Y from 'yjs'

/** The origin of an editor's own edits to its shared document. */
export const LOCAL = Symbol('local edit')

/**
 * Where a draft stands (M16): `connecting` until the document first syncs (edits wait), `saving` while the server
 * hasn't saved this editor's edits to the draft yet, `offline` while reconnecting (edits sync when it's back), `error`
 * when the merged draft couldn't be saved or the server ended the connection.
 */
export type SaveStatus = 'connecting' | 'saved' | 'saving' | 'offline' | 'error'

/** What an editor's store does with its draft's shared document. */
export interface SessionHost<D> {
  /** The document synced: it's the definition from now on. */
  attach(shared: SharedDefinition<D>): void
  /** Someone else changed it (or it synced again). */
  remote(): void
  connection(status: SaveStatus, error: string | null, revision?: number): void
  /** Everything here is saved: the draft hash can be worked out for "unpublished changes". */
  saved(): void
  readOnly(): boolean
  /** Follows presence for the editor; returns the stop. */
  presence?(awareness: Awareness): () => void
}

interface Session<D> {
  key: string
  shared: SharedDefinition<D>
  provider: CollabProvider
  /** Synced at least once: the store shows the document. */
  attached: boolean
  changed(): void
  close(): void
}

/** `ws(s)://<this host>/api/collab/<key>`: the same origin, so the session cookie goes along. */
export function collabUrl(key: string): string {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/collab/${key}`
}

/**
 * An editor's open draft (M16): a Yjs document kept in sync with everyone else's through the server, the editor's
 * store on top of it. One at a time, like the editor.
 */
export class SessionSlot<D> {
  private current: Session<D> | null = null

  constructor(
    private spec: CollabSpec,
    private host: SessionHost<D>,
  ) {}

  /**
   * Opens the document with `key`. The store shows the draft as loaded until it syncs, then edits go into the
   * document and others' come out of it. The same key again (a branch draft replaced after a Git update) puts the
   * store back on the document.
   */
  open(key: string): void {
    const { host } = this
    if (this.current?.key === key) {
      if (this.current.attached) host.attach(this.current.shared)
      this.current.changed()
      return
    }
    this.close()
    const doc = new Y.Doc()
    const shared = new SharedDefinition<D>(doc, this.spec)
    const provider = new CollabProvider({ url: collabUrl(key), doc })
    const changed = () => {
      if (!session.attached && provider.state === 'synced') {
        session.attached = true
        host.attach(shared)
      }
      const { status, error } = statusOf(provider, session.attached)
      host.connection(status, error, provider.status?.revision)
      if (status === 'saved') host.saved()
    }
    const unsubscribe = provider.subscribe(changed)
    // Someone else's edit (or a reconnect's sync): the store shows the document as it is now. Its own edits, undos
    // and redos it shows itself.
    const transacted = (tr: Y.Transaction) => {
      if (!session.attached || !tr.changed.size || tr.origin === LOCAL || tr.origin instanceof Y.UndoManager)
        return
      host.remote()
    }
    doc.on('afterTransaction', transacted)
    const stopPresence = host.presence?.(provider.awareness)

    const session: Session<D> = {
      key,
      shared,
      provider,
      attached: false,
      changed,
      close: () => {
        stopPresence?.()
        unsubscribe()
        doc.off('afterTransaction', transacted)
        provider.destroy()
        shared.destroy()
        doc.destroy()
      },
    }
    this.current = session
    changed()
  }

  close(): void {
    this.current?.close()
    this.current = null
  }

  /** Presence in the open draft's document, once there is one. */
  get awareness(): Awareness | null {
    return this.current?.provider.awareness ?? null
  }

  /**
   * Resolves once the server has saved every edit made here to the draft (runs and server queries use the draft).
   * Rejects when it can't be saved.
   */
  async ensureSaved(): Promise<void> {
    const session = this.current
    if (!session || this.host.readOnly()) return
    const status = await session.provider.save()
    if (status.error) throw new Error(`The draft couldn't be saved: ${status.error}`)
  }
}

function statusOf(provider: CollabProvider, attached: boolean): { status: SaveStatus; error: string | null } {
  if (provider.state === 'closed') return { status: 'error', error: provider.closedReason ?? 'Disconnected' }
  if (!attached) return { status: 'connecting', error: null }
  if (provider.state !== 'synced') return { status: 'offline', error: null }
  if (provider.status?.error) return { status: 'error', error: `Couldn't save: ${provider.status.error}` }
  return { status: provider.unsaved ? 'saving' : 'saved', error: null }
}
