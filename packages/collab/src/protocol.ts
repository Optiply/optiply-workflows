/**
 * What the browser and the server say over `GET /api/collab/<key>` (architecture §2.19): binary WebSocket messages,
 * each a varuint message type then its body, as y-websocket frames them.
 */

/** A y-protocols sync message: step 1 (a state vector), step 2 or an update (a Yjs update). */
export const MESSAGE_SYNC = 0
/** A y-protocols awareness update: who is here, what they have selected, where their pointer is. */
export const MESSAGE_AWARENESS = 1
/** The draft's state, from the server: a JSON `CollabStatus` as a varstring. */
export const MESSAGE_STATUS = 2
/**
 * A save. From the browser: a varuint token, "write the draft with everything I sent before this". The server
 * answers with the token and the JSON `CollabStatus` once the draft has it (or why it can't): a WebSocket keeps
 * messages in order, so the answer covers every edit sent before the request.
 */
export const MESSAGE_SAVE = 3

/**
 * Where the draft stands: the revision the document was last saved to the draft as (what runs, publishing and Git
 * see), and why the document's latest state couldn't be saved (null when it was).
 */
export interface CollabStatus {
  revision: number
  error: string | null
}

/** Close codes besides the standard ones. */
export const CLOSE_ACCESS_LOST = 4403

export const COLLAB_KINDS = ['workflow', 'app', 'module', 'library', 'components', 'branch'] as const
export type CollabKind = (typeof COLLAB_KINDS)[number]

/**
 * A document's key: the main draft of a workflow, app, module, (M21) library query or (M25) component library
 * (`components:<id>`), or a Git branch draft
 * (`branch:<draft id>`).
 */
export const collabKey = (kind: CollabKind, id: string): string => `${kind}:${id}`

const KEY =
  /^(workflow|app|module|library|components|branch):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseCollabKey(key: string): { kind: CollabKind; id: string } | null {
  const m = KEY.exec(key)
  return m ? { kind: m[1] as CollabKind, id: m[2] as string } : null
}
