/**
 * What the browser and the server say over `GET /api/collab/<key>` (architecture §2.19): binary WebSocket messages,
 * each a varuint message type then its body, as y-websocket frames them.
 */

/** A y-protocols sync message: step 1 (a state vector), step 2 or an update (a Yjs update). */
export const MESSAGE_SYNC = 0
/** A y-protocols awareness update: who is here, what they have selected, where their pointer is. */
export const MESSAGE_AWARENESS = 1

/** Close codes besides the standard ones. */
export const CLOSE_ACCESS_LOST = 4403

export const COLLAB_KINDS = ['workflow', 'app', 'module', 'branch'] as const
export type CollabKind = (typeof COLLAB_KINDS)[number]

/** A document's key: the main draft of a workflow, app or module, or a Git branch draft (`branch:<draft id>`). */
export const collabKey = (kind: CollabKind, id: string): string => `${kind}:${id}`

const KEY = /^(workflow|app|module|branch):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseCollabKey(key: string): { kind: CollabKind; id: string } | null {
  const m = KEY.exec(key)
  return m ? { kind: m[1] as CollabKind, id: m[2] as string } : null
}
