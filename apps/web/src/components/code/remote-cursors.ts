import type { Awareness } from '@ow/collab'
import * as Y from 'yjs'
import { type PresenceUser, presenceColour } from '@/lib/presence'
import { monaco } from './monaco'

/**
 * Where someone's cursor is, in their presence (M16): relative positions in a `Y.Text`, which keep pointing at the
 * same characters as the text changes. A code field shows the ones that fall in its own text.
 */
interface CursorState {
  anchor: unknown
  head: unknown
}

/**
 * Shares this editor's cursor and selection in `text` while it has focus, and shows everyone else's that fall in
 * `text`: a caret and a selection in their colour, their name on hover.
 */
export function showCursors(
  editor: monaco.editor.IStandaloneCodeEditor,
  text: Y.Text,
  awareness: Awareness,
): monaco.IDisposable {
  const doc = text.doc
  const model = editor.getModel()
  if (!doc || !model) return { dispose: () => {} }

  const share = () => {
    const selection = editor.getSelection()
    if (!selection || !editor.hasTextFocus()) return
    const at = (lineNumber: number, column: number) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt({ lineNumber, column })),
      )
    const cursor: CursorState = {
      anchor: at(selection.selectionStartLineNumber, selection.selectionStartColumn),
      head: at(selection.positionLineNumber, selection.positionColumn),
    }
    awareness.setLocalStateField('cursor', cursor)
  }
  // Leaving the field takes the cursor away, unless another field has already put its own.
  const mine = () => {
    const cursor = awareness.getLocalState()?.cursor as CursorState | null | undefined
    return cursor ? offset(cursor.head) !== null : false
  }
  const unshare = () => {
    if (mine()) awareness.setLocalStateField('cursor', null)
  }

  const offset = (json: unknown): number | null => {
    try {
      const absolute = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(json),
        doc,
      )
      return absolute && absolute.type === text ? absolute.index : null
    } catch {
      return null
    }
  }

  const decorations = editor.createDecorationsCollection()
  const render = () => {
    const shown: monaco.editor.IModelDeltaDecoration[] = []
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue
      const cursor = state.cursor as CursorState | null | undefined
      if (!cursor) continue
      const head = offset(cursor.head)
      const anchor = offset(cursor.anchor)
      if (head === null || anchor === null) continue
      const user = state.user as PresenceUser | undefined
      const colour = `ow-presence-${presenceColour(user?.id)}`
      const hover = { value: user?.name ?? 'Someone' }
      if (anchor !== head) {
        const from = model.getPositionAt(Math.min(anchor, head))
        const to = model.getPositionAt(Math.max(anchor, head))
        shown.push({
          range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
          options: { className: `ow-remote-selection ${colour}`, hoverMessage: hover },
        })
      }
      const caret = model.getPositionAt(head)
      shown.push({
        range: new monaco.Range(caret.lineNumber, caret.column, caret.lineNumber, caret.column),
        options: {
          beforeContentClassName: `ow-remote-caret ${colour}`,
          hoverMessage: hover,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })
    }
    decorations.set(shown)
  }

  const disposables = [
    editor.onDidChangeCursorSelection(share),
    editor.onDidFocusEditorText(share),
    editor.onDidBlurEditorText(unshare),
  ]
  awareness.on('change', render)
  // Others' positions move with the text: drawn again after it changes (the model has it by then).
  text.observe(render)
  render()

  return {
    dispose: () => {
      for (const d of disposables) d.dispose()
      awareness.off('change', render)
      text.unobserve(render)
      decorations.clear()
      unshare()
    },
  }
}
