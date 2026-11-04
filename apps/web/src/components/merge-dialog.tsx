import type { MergeConflict, Resolution, TextChunk } from '@ow/collab'
import { useState } from 'react'
import CodeField from '@/components/code/code-field'
import { Button, Dialog, ErrorNote } from '@/components/ui'
import {
  type Choice,
  type ChunkChoice,
  chooseChunk,
  conflictingChunks,
  conflictLabel,
  conflictLanguage,
  isRenameConflict,
  isResolved,
  resolutionOf,
  resolvedCount,
  showValue,
  textOf,
} from '@/lib/merge-choices'
import { cn } from '@/lib/utils'

/** An object's conflicts (Update from main can bring several; Update from branch has the draft's own). */
export interface ConflictGroup {
  /** What resolutions are keyed by: the object's directory, or '' for the draft's own. */
  key: string
  /** Shown above its conflicts when there are several groups. */
  label: string
  conflicts: MergeConflict[]
}

/** Lines of an unchanged stretch shown around a conflicting chunk. */
const CONTEXT = 3

/**
 * The merge dialog (architecture §2.23): each conflict with Mine / Theirs (a text's chunks one by one, Both, or the
 * text edited by hand), a count of what's left, and Apply once all are settled. It never saves anything: Apply hands
 * the resolutions over, and conflicts that come back (someone changed the same lines meanwhile) replace the list,
 * keeping the choices whose conflicts are still there.
 */
export function MergeDialog(props: {
  title: string
  /** Says what "mine" and "theirs" are here. */
  intro: string
  groups: ConflictGroup[]
  applying: boolean
  error: unknown
  /** Another way out, left of Cancel (Update from branch: drop the draft's changes). */
  secondary?: { label: string; onClick(): void }
  onApply(resolutions: Record<string, Record<string, Resolution>>): void
  onClose(): void
}) {
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({})
  const all = props.groups.flatMap((g) => g.conflicts)
  const done = resolvedCount(all, choices)
  const choose = (id: string, choice: Choice) => setChoices((c) => ({ ...c, [id]: choice }))
  const apply = () => {
    const resolutions: Record<string, Record<string, Resolution>> = {}
    for (const group of props.groups) {
      const mine: Record<string, Resolution> = {}
      for (const conflict of group.conflicts) {
        const r = resolutionOf(conflict, choices[conflict.id])
        if (r !== undefined) mine[conflict.id] = r
      }
      resolutions[group.key] = mine
    }
    props.onApply(resolutions)
  }
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      className="max-w-4xl"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted" data-testid="merge-progress">
            {done} of {all.length} resolved
          </span>
          {props.secondary && (
            <Button variant="danger" onClick={props.secondary.onClick} data-testid="merge-secondary">
              {props.secondary.label}
            </Button>
          )}
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={done < all.length}
            loading={props.applying}
            onClick={apply}
            data-testid="merge-apply"
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="mb-3 text-muted">{props.intro}</p>
      <div className="flex flex-col gap-4" data-testid="merge-dialog">
        {props.groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-3">
            {props.groups.length > 1 && <h3 className="font-medium">{group.label}</h3>}
            {group.conflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                choice={choices[conflict.id]}
                onChoose={(choice) => choose(conflict.id, choice)}
              />
            ))}
          </section>
        ))}
      </div>
      <ErrorNote error={props.error} />
    </Dialog>
  )
}

function ConflictCard(props: {
  conflict: MergeConflict
  choice: Choice | undefined
  onChoose(choice: Choice): void
}) {
  const { conflict, choice } = props
  const resolved = isResolved(conflict, choice)
  return (
    <div
      className={cn('rounded-md border', resolved ? 'border-border' : 'border-warning')}
      data-testid={`conflict-${conflictLabel(conflict.at)}`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-xs">{conflictLabel(conflict.at)}</span>
        {conflict.kind === 'item' && (
          <span className="text-xs text-muted">
            {conflict.ours === undefined
              ? 'you deleted it; it changed on the other side'
              : conflict.theirs === undefined
                ? 'you changed it; it was deleted on the other side'
                : 'changed into something else on each side'}
          </span>
        )}
        {isRenameConflict(conflict) && (
          <span className="text-xs text-muted">renamed differently on each side</span>
        )}
        <span className="flex-1" />
        {resolved && <span className="text-xs text-success">Resolved</span>}
      </div>
      {conflict.kind === 'text' ? (
        <TextConflict conflict={conflict} choice={choice} onChoose={props.onChoose} />
      ) : (
        <Sides
          ours={showValue(conflict.ours)}
          theirs={showValue(conflict.theirs)}
          picked={choice && 'side' in choice ? choice.side : undefined}
          onPick={(side) => side !== 'both' && props.onChoose({ side })}
        />
      )}
    </div>
  )
}

/** Mine and theirs side by side, each with its button. */
function Sides(props: {
  ours: string
  theirs: string
  picked: ChunkChoice | undefined
  onPick(side: ChunkChoice): void
  both?: boolean
}) {
  const side = (which: 'ours' | 'theirs', text: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <pre
        className={cn(
          'max-h-60 overflow-auto rounded-md bg-canvas p-2 font-mono text-xs whitespace-pre-wrap',
          (props.picked === which || props.picked === 'both') && 'ring-2 ring-accent',
        )}
      >
        {text || ' '}
      </pre>
      <Button
        size="sm"
        variant={props.picked === which ? 'primary' : 'secondary'}
        onClick={() => props.onPick(which)}
        data-testid={`pick-${which}`}
      >
        {which === 'ours' ? 'Keep mine' : 'Take theirs'}
      </Button>
    </div>
  )
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex gap-3">
        {side('ours', props.ours)}
        {side('theirs', props.theirs)}
      </div>
      {props.both && (
        <Button
          size="sm"
          variant={props.picked === 'both' ? 'primary' : 'secondary'}
          className="self-center"
          onClick={() => props.onPick('both')}
          data-testid="pick-both"
        >
          Both (mine first)
        </Button>
      )}
    </div>
  )
}

/** A text conflict: its conflicting chunks with the lines around them, or the whole text edited by hand. */
function TextConflict(props: {
  conflict: Extract<MergeConflict, { kind: 'text' }>
  choice: Choice | undefined
  onChoose(choice: Choice): void
}) {
  const { conflict, choice } = props
  const editing = choice !== undefined && 'text' in choice
  const count = conflictingChunks(conflict.chunks)
  const lang = conflictLanguage(conflict.at)
  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <CodeField
          path={`merge:${conflict.id}`}
          language={lang}
          value={choice.text}
          onChange={(text) => props.onChoose({ text })}
          height={Math.min(400, 20 * (choice.text.split('\n').length + 2))}
        />
        <Button
          size="sm"
          className="self-start"
          onClick={() => props.onChoose({ chunks: Array.from({ length: count }, () => undefined) })}
        >
          Back to choosing per change
        </Button>
      </div>
    )
  }
  let k = 0
  return (
    <div className="flex flex-col">
      {conflict.chunks.map((chunk, i) => {
        if ('ok' in chunk)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: unchanged stretches have no identity but their place
            <Context key={`ok-${i}`} chunk={chunk} first={i === 0} last={i === conflict.chunks.length - 1} />
          )
        const index = k++
        const picked = choice && 'chunks' in choice ? choice.chunks[index] : undefined
        return (
          <div key={`c-${index}`} className="border-y border-border" data-testid="conflict-chunk">
            <Sides
              ours={chunk.conflict.ours.join('\n')}
              theirs={chunk.conflict.theirs.join('\n')}
              picked={picked}
              both
              onPick={(pick) => props.onChoose(chooseChunk(choice, index, count, pick))}
            />
          </div>
        )
      })}
      <Button
        size="sm"
        variant="ghost"
        className="m-2 self-start"
        onClick={() => props.onChoose({ text: textOf(conflict, choice) })}
        data-testid="edit-by-hand"
      >
        Edit by hand
      </Button>
    </div>
  )
}

/** The unchanged lines next to conflicting chunks: a few on each side, the middle folded. */
function Context(props: { chunk: Extract<TextChunk, { ok: unknown }>; first: boolean; last: boolean }) {
  const lines = props.chunk.ok
  const head = props.first ? [] : lines.slice(0, CONTEXT)
  const tail = props.last ? [] : lines.slice(Math.max(head.length, lines.length - CONTEXT))
  const folded = lines.length - head.length - tail.length
  return (
    <pre className="px-3 py-1 font-mono text-xs whitespace-pre-wrap text-muted">
      {head.join('\n')}
      {head.length > 0 && folded > 0 && '\n'}
      {folded > 0 && `⋯ ${folded} unchanged line${folded === 1 ? '' : 's'}`}
      {tail.length > 0 && (folded > 0 || head.length > 0) && '\n'}
      {tail.join('\n')}
    </pre>
  )
}
