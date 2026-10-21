import { CollabProvider, collabKey, SharedDefinition, workflowSpec } from '@ow/collab'
import { definitionHash, type WorkflowDefinition } from '@ow/definition'
import * as Y from 'yjs'
import { LOCAL, type SaveStatus, useEditor } from './store'

/**
 * The open draft's shared document (M16): a Yjs document kept in sync with everyone else's through the server, the
 * editor's store on top of it. One at a time, like the editor.
 */
interface Session {
  key: string
  shared: SharedDefinition<WorkflowDefinition>
  provider: CollabProvider
  /** Synced at least once: the store shows the document. */
  attached: boolean
  /** Tells the store how things stand. */
  changed(): void
  close(): void
}

let current: Session | null = null

/** `ws(s)://<this host>/api/collab/<key>`: the same origin, so the session cookie goes along. */
export function collabUrl(key: string): string {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/collab/${key}`
}

/**
 * Opens the draft's document: the workflow's main draft, or a Git branch draft. The store shows the draft as loaded
 * until the document syncs, then edits go into the document and others' edits come out of it.
 */
export function openSession(workflowId: string, branchDraftId: string | null): void {
  const key = branchDraftId ? collabKey('branch', branchDraftId) : collabKey('workflow', workflowId)
  if (current?.key === key) {
    // The same draft loaded again (a branch draft updated from Git): the store goes back to the document.
    if (current.attached) useEditor.getState().attach(current.shared)
    current.changed()
    return
  }
  closeSession()
  const doc = new Y.Doc()
  const shared = new SharedDefinition<WorkflowDefinition>(doc, workflowSpec)
  const provider = new CollabProvider({ url: collabUrl(key), doc })
  const changed = () => {
    if (!session.attached && provider.state === 'synced') {
      session.attached = true
      useEditor.getState().attach(shared)
    }
    const { status, error } = statusOf(provider, session.attached)
    useEditor.getState().connection(status, error, provider.status?.revision)
    if (status === 'saved') {
      const definition = useEditor.getState().definition
      void definitionHash(definition).then((hash) => useEditor.getState().setDraftHash(definition, hash))
    }
  }
  const unsubscribe = provider.subscribe(changed)
  // Someone else's edit (or a reconnect's sync): the store shows the document as it is now. Its own edits, undos and
  // redos it shows itself.
  const transacted = (tr: Y.Transaction) => {
    if (!session.attached || !tr.changed.size || tr.origin === LOCAL || tr.origin instanceof Y.UndoManager)
      return
    useEditor.getState().remote()
  }
  doc.on('afterTransaction', transacted)

  const session: Session = {
    key,
    shared,
    provider,
    attached: false,
    changed,
    close: () => {
      unsubscribe()
      doc.off('afterTransaction', transacted)
      provider.destroy()
      shared.destroy()
      doc.destroy()
    },
  }
  current = session
  changed()
}

/** Presence in the open draft's document, once there is one. */
export function currentAwareness() {
  return current?.provider.awareness ?? null
}

export function closeSession(): void {
  current?.close()
  current = null
}

function statusOf(provider: CollabProvider, attached: boolean): { status: SaveStatus; error: string | null } {
  if (provider.state === 'closed') return { status: 'error', error: provider.closedReason ?? 'Disconnected' }
  if (!attached) return { status: 'connecting', error: null }
  if (provider.state !== 'synced') return { status: 'offline', error: null }
  if (provider.status?.error) return { status: 'error', error: `Couldn't save: ${provider.status.error}` }
  return { status: provider.unsaved ? 'saving' : 'saved', error: null }
}

/**
 * Resolves once the server has saved every edit made here to the draft: runs execute the draft, so Run waits for
 * this. Rejects when it can't be saved.
 */
export async function ensureSaved(): Promise<void> {
  const session = current
  if (!session || useEditor.getState().readOnly) return
  const status = await session.provider.save()
  if (status.error) throw new Error(`The draft couldn't be saved: ${status.error}`)
}
