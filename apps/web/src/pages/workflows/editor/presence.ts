import { createPresence } from '@/lib/presence'
import { useEditor } from './store'

export type { Peer, Pointer } from '@/lib/presence'

/** Presence in the workflow editor (M16): selections by block name, areas by graph, pointers in flow coordinates. */
const presence = createPresence()

export const usePresence = presence.usePresence
export const sharePointer = presence.sharePointer

export const trackPresence = (awareness: Parameters<typeof presence.track>[0]) =>
  presence.track(awareness, {
    read: () => {
      const { selection, graph } = useEditor.getState()
      return { selection, area: graph }
    },
    subscribe: (changed) =>
      useEditor.subscribe((state, before) => {
        if (state.selection !== before.selection || state.graph !== before.graph) changed()
      }),
  })
