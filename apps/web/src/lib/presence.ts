import type { Awareness } from '@ow/collab'
import { create } from 'zustand'

/**
 * Each person's colour while editing together (M16): one of the palette's hues, the same for them everywhere (code
 * field cursors, avatars, outlines on blocks), picked from their user id. `.ow-presence-<n>` (styles.css) sets
 * `--presence` to it, in either theme (selections mix it lighter).
 */
export const PRESENCE_COLOURS = 6

export function presenceColour(userId: string | undefined): number {
  let hash = 0
  for (const c of userId ?? '') hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return hash % PRESENCE_COLOURS
}

/** Someone else in the draft (M16): who, in which colour, and what they have selected in which area. */
export interface Peer {
  clientId: number
  user: PresenceUser
  colour: number
  /** Where they are: the workflow graph they have open (null: the workflow's own), or the app page. */
  area: string | null
  selection: string[]
}

/** Someone's mouse pointer, in the editor's canvas coordinates (so it lines up whatever each one's view). */
export interface Pointer {
  clientId: number
  user: PresenceUser
  colour: number
  area: string | null
  x: number
  y: number
}

/** What an editor shares of itself: its selection and area, and when they change. */
export interface PresenceSource {
  read(): { selection: string[]; area: string | null }
  subscribe(changed: () => void): () => void
}

/** At most this often a pointer is sent: 20 times a second. */
const POINTER_MS = 50
/** A pointer that hasn't moved this long is taken away. */
const POINTER_IDLE_MS = 30_000

/**
 * An editor's presence: everyone else in its open draft (`usePresence`), from the shared document's awareness, and
 * its own selection, area and pointer out. Selections and pointers are apart: pointers change many times a second,
 * and only the pointer layer follows them.
 */
export function createPresence() {
  const usePresence = create<{ peers: Peer[]; pointers: Pointer[] }>(() => ({ peers: [], pointers: [] }))
  let current: { awareness: Awareness; area: string | null } | null = null
  let pointerTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPointer: { x: number; y: number } | null = null

  /** This editor's pointer (canvas coordinates), or null when it leaves: sent at most 20 times a second. */
  const sharePointer = (point: { x: number; y: number } | null): void => {
    if (!current) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (!point) {
      if (pointerTimer) clearTimeout(pointerTimer)
      pointerTimer = null
      pendingPointer = null
      if (current.awareness.getLocalState()?.pointer) current.awareness.setLocalStateField('pointer', null)
      return
    }
    pendingPointer = point
    pointerTimer ??= setTimeout(() => {
      pointerTimer = null
      if (current && pendingPointer) {
        current.awareness.setLocalStateField('pointer', { ...pendingPointer, area: current.area })
      }
    }, POINTER_MS)
    idleTimer = setTimeout(() => sharePointer(null), POINTER_IDLE_MS)
  }

  /** Follows a draft's presence while it's open; returns the stop. */
  const track = (awareness: Awareness, source: PresenceSource): (() => void) => {
    let peersJson = ''
    const changed = () => {
      const peers: Peer[] = []
      const pointers: Pointer[] = []
      for (const [clientId, state] of awareness.getStates()) {
        const user = state.user as PresenceUser | undefined
        if (clientId === awareness.clientID || !user) continue
        const colour = presenceColour(user.id)
        const area = (state.area as string | null | undefined) ?? null
        peers.push({
          clientId,
          user,
          colour,
          area,
          selection: (state.selection as string[] | undefined) ?? [],
        })
        const pointer = state.pointer as { x: number; y: number; area: string | null } | null | undefined
        if (pointer) pointers.push({ clientId, user, colour, area: pointer.area, x: pointer.x, y: pointer.y })
      }
      // Selections only when they changed: every block or component follows them.
      const json = JSON.stringify(peers)
      if (json !== peersJson) {
        peersJson = json
        usePresence.setState({ peers })
      }
      usePresence.setState({ pointers })
    }
    awareness.on('change', changed)

    const publish = () => {
      const { selection, area } = source.read()
      const local = awareness.getLocalState()
      if (local?.area !== area || JSON.stringify(local?.selection) !== JSON.stringify(selection)) {
        awareness.setLocalStateField('area', area)
        awareness.setLocalStateField('selection', selection)
      }
      if (current) current.area = area
    }
    const unsubscribe = source.subscribe(publish)
    current = { awareness, area: source.read().area }
    publish()
    changed()

    return () => {
      unsubscribe()
      awareness.off('change', changed)
      sharePointer(null)
      current = null
      usePresence.setState({ peers: [], pointers: [] })
    }
  }

  return { usePresence, track, sharePointer }
}

/** Who someone is, as the server puts it in their presence. */
export interface PresenceUser {
  id: string
  name: string
  avatarUrl: string | null
}
