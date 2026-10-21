import type { Awareness } from '@ow/collab'
import { create } from 'zustand'
import { type PresenceUser, presenceColour } from '@/lib/presence'
import { useEditor } from './store'

/** Someone else in this draft (M16): who, in which colour, and what they have selected in which graph. */
export interface Peer {
  clientId: number
  user: PresenceUser
  colour: number
  /** The graph they have open: the workflow's (null) or a function's. */
  graph: string | null
  selection: string[]
}

/** Someone's mouse pointer on the canvas, in flow coordinates (so it lines up whatever each one's zoom). */
export interface Pointer {
  clientId: number
  user: PresenceUser
  colour: number
  graph: string | null
  x: number
  y: number
}

/**
 * Everyone else in the open draft, from the shared document's presence. Selections and pointers are apart: pointers
 * change many times a second, and only the canvas's pointer layer follows them.
 */
export const usePresence = create<{ peers: Peer[]; pointers: Pointer[] }>(() => ({ peers: [], pointers: [] }))

/** At most this often a pointer is sent: 20 times a second. */
const POINTER_MS = 50
/** A pointer that hasn't moved this long is taken away. */
const POINTER_IDLE_MS = 30_000

let shared: { awareness: Awareness; graph: string | null } | null = null
let pointerTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let pendingPointer: { x: number; y: number } | null = null

/**
 * Follows the draft's presence: others' into `usePresence`, this editor's selection and open graph out. Returns the
 * stop.
 */
export function trackPresence(awareness: Awareness): () => void {
  let peersJson = ''
  const changed = () => {
    const peers: Peer[] = []
    const pointers: Pointer[] = []
    for (const [clientId, state] of awareness.getStates()) {
      const user = state.user as PresenceUser | undefined
      if (clientId === awareness.clientID || !user) continue
      const colour = presenceColour(user.id)
      const graph = (state.graph as string | null | undefined) ?? null
      peers.push({
        clientId,
        user,
        colour,
        graph,
        selection: (state.selection as string[] | undefined) ?? [],
      })
      const pointer = state.pointer as { x: number; y: number; graph: string | null } | null | undefined
      if (pointer) pointers.push({ clientId, user, colour, graph: pointer.graph, x: pointer.x, y: pointer.y })
    }
    // Selections only when they changed: every block follows them.
    const json = JSON.stringify(peers)
    if (json !== peersJson) {
      peersJson = json
      usePresence.setState({ peers })
    }
    usePresence.setState({ pointers })
  }
  awareness.on('change', changed)

  const publish = () => {
    const { selection, graph } = useEditor.getState()
    const local = awareness.getLocalState()
    if (local?.graph !== graph || JSON.stringify(local?.selection) !== JSON.stringify(selection)) {
      awareness.setLocalStateField('graph', graph)
      awareness.setLocalStateField('selection', selection)
    }
    if (shared) shared.graph = graph
  }
  const unsubscribe = useEditor.subscribe((state, before) => {
    if (state.selection !== before.selection || state.graph !== before.graph) publish()
  })
  shared = { awareness, graph: useEditor.getState().graph }
  publish()
  changed()

  return () => {
    unsubscribe()
    awareness.off('change', changed)
    sharePointer(null)
    shared = null
    usePresence.setState({ peers: [], pointers: [] })
  }
}

/** This editor's pointer on the canvas (flow coordinates), or null when it leaves: sent at most 20 times a second. */
export function sharePointer(point: { x: number; y: number } | null): void {
  if (!shared) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (!point) {
    if (pointerTimer) clearTimeout(pointerTimer)
    pointerTimer = null
    pendingPointer = null
    if (shared.awareness.getLocalState()?.pointer) shared.awareness.setLocalStateField('pointer', null)
    return
  }
  pendingPointer = point
  pointerTimer ??= setTimeout(() => {
    pointerTimer = null
    if (shared && pendingPointer) {
      shared.awareness.setLocalStateField('pointer', { ...pendingPointer, graph: shared.graph })
    }
  }, POINTER_MS)
  idleTimer = setTimeout(() => sharePointer(null), POINTER_IDLE_MS)
}
