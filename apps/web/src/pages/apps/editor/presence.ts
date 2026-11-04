import { createPresence } from '@/lib/presence'
import { useAppEditor } from './store'

/**
 * Presence in the app editor (M16): the selected component, the page being edited as the area, and pointers over the
 * canvas as a fraction of its width (pages are as wide as each one's window) and pixels down (rows are fixed).
 */
const presence = createPresence()

export const usePresence = presence.usePresence
export const sharePointer = presence.sharePointer

export const trackPresence = (awareness: Parameters<typeof presence.track>[0]) =>
  presence.track(awareness, {
    read: () => {
      const { selection, url } = useAppEditor.getState()
      return { selection, area: url.page }
    },
    subscribe: (changed) =>
      useAppEditor.subscribe((state, before) => {
        if (state.selection !== before.selection || state.url.page !== before.url.page) changed()
      }),
  })
