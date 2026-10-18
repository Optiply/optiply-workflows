import { Redo2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { shortcutLabel } from '@/lib/shortcuts'

/** An editor's Undo and Redo buttons, with their shortcuts in the titles (M13). */
export function UndoButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        disabled={!canUndo}
        title={`Undo (${shortcutLabel('Z')})`}
        aria-label="Undo"
        onClick={onUndo}
      >
        <Undo2 className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={!canRedo}
        title={`Redo (${shortcutLabel('Z', { shift: true })})`}
        aria-label="Redo"
        onClick={onRedo}
      >
        <Redo2 className="size-4" />
      </Button>
    </>
  )
}
