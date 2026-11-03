import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { type PresenceUser, presenceColour } from '@/lib/presence'
import { currentAwareness } from './collab'
import { useEditor } from './store'

/** Someone else's caret in a field's text: where it is, and who. */
export interface RemoteCaret {
  clientId: number
  offset: number
  name: string
  colour: number
}

/**
 * The carets others have in the text at `at` (M16's shared cursors, `remote-cursors.ts`), for a block's code preview
 * on the canvas: it isn't an editor until the block is inspected, but others' cursors still show in it.
 */
export function useRemoteCarets(at: (string | number)[] | undefined): RemoteCaret[] {
  const shared = useEditor((s) => s.shared)
  const definition = useEditor((s) => s.definition)
  const key = at?.join('\u0000')
  const [carets, setCarets] = useState<RemoteCaret[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `at`; `definition` marks the text being replaced
  useEffect(() => {
    const text = at && shared ? shared.textAt(at) : null
    const awareness = currentAwareness()
    const doc = text?.doc
    if (!text || !doc || !awareness) {
      setCarets([])
      return
    }
    const read = () => {
      const found: RemoteCaret[] = []
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue
        const head = (state.cursor as { head?: unknown } | null | undefined)?.head
        if (!head) continue
        try {
          const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), doc)
          if (!at || at.type !== text) continue
          const user = state.user as PresenceUser | undefined
          found.push({
            clientId,
            offset: at.index,
            name: user?.name ?? 'Someone',
            colour: presenceColour(user?.id),
          })
        } catch {
          // A position from an older document: not shown.
        }
      }
      setCarets((was) => (JSON.stringify(was) === JSON.stringify(found) ? was : found))
    }
    read()
    awareness.on('change', read)
    text.observe(read)
    return () => {
      awareness.off('change', read)
      text.unobserve(read)
    }
  }, [key, shared, definition])
  return carets
}

/** `value` with a caret at each remote caret's offset, in its person's colour, named on hover. */
export function withCarets(value: string, carets: RemoteCaret[]): ReactNode {
  if (!carets.length) return value
  const parts: ReactNode[] = []
  let from = 0
  for (const caret of [...carets].sort((a, b) => a.offset - b.offset)) {
    const at = Math.min(Math.max(caret.offset, from), value.length)
    parts.push(value.slice(from, at))
    parts.push(
      <span
        key={caret.clientId}
        title={caret.name}
        data-testid="preview-caret"
        className={`ow-presence-${caret.colour} ow-preview-caret`}
      />,
    )
    from = at
  }
  parts.push(value.slice(from))
  return parts
}
