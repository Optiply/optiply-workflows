import type { Awareness } from '@ow/collab'
import type * as Y from 'yjs'
import { monaco } from './monaco'

/**
 * A code field's text in the shared document (M16): typing goes into it as one undoable edit, and what others type
 * comes out of it, merging character by character.
 */
export interface TextBinding {
  text: Y.Text
  /**
   * Runs `change` (writes to `text`) in a transaction, as this editor's edit: undoable, and grouped like typing in any
   * field. `change` gets the transaction.
   */
  write(change: (transaction: Y.Transaction) => void): void
  undo(): void
  redo(): void
  /** Presence: this editor's cursor is shared there, and others' are shown in the field. */
  awareness?: Awareness | null
}

/**
 * Keeps a Monaco model and a `Y.Text` equal: the model's changes go into the text as the fewest inserts and deletes,
 * and the text's changes from anywhere else (others, undo, a rename elsewhere in the editor) come into the model as
 * one batch of edits, so the cursor and selection stay where they were relative to the text around them.
 */
export function bindText(model: monaco.editor.ITextModel, binding: TextBinding): monaco.IDisposable {
  const { text } = binding
  // Offsets count the model's characters: one end of line, as Y.Text stores it.
  model.setEOL(monaco.editor.EndOfLineSequence.LF)
  let applying = false
  // The transactions this binding made: their changes are the model's already. (Yjs calls observers when a transaction
  // ends, after `write` has returned, so a flag set during it would be gone by then.)
  const own = new WeakSet<Y.Transaction>()

  const apply = (edits: monaco.editor.IIdentifiedSingleEditOperation[]) => {
    applying = true
    try {
      model.applyEdits(edits)
    } finally {
      applying = false
    }
  }
  const range = (from: number, to: number) => {
    const start = model.getPositionAt(from)
    const end = model.getPositionAt(to)
    return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
  }

  if (model.getValue() !== text.toString())
    apply([{ range: model.getFullModelRange(), text: text.toString() }])

  const changed = model.onDidChangeContent((event) => {
    if (applying) return
    // Each change's offset is in the model as it was before the event: applied from the end, they stay valid.
    const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
    binding.write((transaction) => {
      own.add(transaction)
      for (const c of changes) {
        if (c.rangeLength) text.delete(c.rangeOffset, c.rangeLength)
        if (c.text) text.insert(c.rangeOffset, c.text)
      }
    })
  })

  const observer = (event: Y.YTextEvent) => {
    if (own.has(event.transaction)) return
    // The delta walks the text as it was, which is the model now: spans of it to replace, in order. Touching ones
    // (an insert and a delete at one place, in either order) become one replacement.
    const spans: { from: number; to: number; text: string }[] = []
    const replace = (from: number, to: number, insert: string) => {
      const last = spans.at(-1)
      if (last && last.to === from) {
        last.to = to
        last.text += insert
      } else spans.push({ from, to, text: insert })
    }
    let index = 0
    for (const op of event.delta) {
      if (op.retain) index += op.retain
      else if (op.delete) {
        replace(index, index + op.delete, '')
        index += op.delete
      } else if (typeof op.insert === 'string') replace(index, index, op.insert)
    }
    const edits = spans.map((s) => ({ range: range(s.from, s.to), text: s.text }))
    if (edits.length) apply(edits)
  }
  text.observe(observer)

  return {
    dispose: () => {
      changed.dispose()
      text.unobserve(observer)
    },
  }
}
