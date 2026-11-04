import { type BlockClip, blockClipSchema, copyBlocks, type PasteResult, pasteBlocks } from '@ow/definition'
import { confirmDialog } from '@/components/confirm'
import { copiedHere, readClip, rememberCopy } from '@/lib/clipboard'
import { NODE_WIDTH, positionsFor } from './layout'
import { graphOf, useEditor, withGraph } from './store'

/** How far a duplicate sits from what it copies. */
const DUPLICATE_OFFSET = { x: 40, y: 40 }

/** The blocks copy and duplicate act on: the canvas selection, or the block being inspected. */
function chosen(): string[] {
  const { selection, selected } = useEditor.getState()
  return selection.length ? selection : selected ? [selected] : []
}

/** The chosen blocks as a clip, with their positions as the canvas shows them (laid out or not). */
function clipOfChosen(): BlockClip | null {
  const { definition, graph: fn } = useEditor.getState()
  const graph = graphOf(definition, fn)
  const laidOut = withGraph(definition, fn, {
    ...graph,
    layout: { ...graph.layout, blocks: positionsFor(graph) },
  })
  return copyBlocks(laidOut, fn, chosen())
}

/** The chosen blocks as clipboard text (remembered as copied here), or null with nothing to copy. */
export function copyText(): string | null {
  const clip = clipOfChosen()
  if (!clip) return null
  const text = JSON.stringify(clip)
  rememberCopy(text)
  return text
}

/**
 * Pastes clipboard text into the open graph, to the right of the chosen block (connected to it, like Add) or of
 * the rightmost one. Returns false when the text isn't blocks, so the browser can paste it elsewhere. Blocks this
 * browser didn't copy are only pasted once confirmed.
 */
export function pasteText(text: string): boolean {
  const read = readClip(text, 'workflow-blocks', blockClipSchema)
  if (!read) return false
  const { notify } = useEditor.getState()
  if (!read.ok) {
    notify(read.error)
    return true
  }
  const clip = read.clip
  // Taken either way (the browser mustn't paste it elsewhere meanwhile); from elsewhere, pasted once confirmed, where
  // the graph is then.
  if (!copiedHere(text)) {
    void confirmDialog(untrustedQuestion(clip), { title: 'Paste from elsewhere?', confirm: 'Paste' }).then(
      (ok) => ok && pasteHere(clip),
    )
    return true
  }
  pasteHere(clip)
  return true
}

/** Pastes blocks to the right of the chosen block (connected to it) or of the rightmost one. */
function pasteHere(clip: BlockClip) {
  const { definition, graph: fn } = useEditor.getState()
  const positions = positionsFor(graphOf(definition, fn))
  // The one block copy would act on (highlighted, or inspected with nothing highlighted); none with several.
  const picked = chosen()
  const from = picked.length === 1 ? picked[0]! : null
  const anchor = from ? positions[from] : undefined
  const at = anchor
    ? { x: anchor.x + NODE_WIDTH + 80, y: anchor.y }
    : { x: Math.max(0, ...Object.values(positions).map((p) => p.x)) + NODE_WIDTH + 80, y: 0 }
  paste(clip, { at, connectFrom: from })
}

/** Copies the chosen blocks next to themselves (⌘D), unconnected. */
export function duplicateChosen(): void {
  const clip = clipOfChosen()
  if (clip) paste(clip, { offset: DUPLICATE_OFFSET })
}

function paste(clip: BlockClip, opts: Parameters<typeof pasteBlocks>[3]) {
  const { update, graph: fn } = useEditor.getState()
  let result: PasteResult | null = null
  update((def) => {
    result = pasteBlocks(def, fn, clip, opts)
    return result.definition
  })
  const done = result as PasteResult | null
  if (!done) return
  const { select, setSelection, notify } = useEditor.getState()
  select(done.added.length === 1 ? done.added[0]! : null)
  if (done.added.length > 1) setSelection(done.added)
  notify(pasteSummary(done))
}

function untrustedQuestion(clip: BlockClip): string {
  const blocks = `${clip.blocks.length} block${clip.blocks.length === 1 ? '' : 's'}`
  const functions = clip.functions.length
    ? ` and ${clip.functions.length} function${clip.functions.length === 1 ? '' : 's'}`
    : ''
  return `Paste ${blocks}${functions} from the clipboard? They weren't copied in this browser: paste them only if you know where they came from.`
}

/** What the person should know about a paste, or null when it went as expected. */
export function pasteSummary(result: PasteResult): string | null {
  const lines: string[] = []
  if (!result.added.length) lines.push('Nothing was pasted.')
  for (const { name, reason } of result.skipped) lines.push(`Not pasted: ${name} (${reason}).`)
  const { added, kept, conflicts } = result.functions
  if (added.length) lines.push(`Added the functions they call: ${added.join(', ')}.`)
  if (kept.length)
    lines.push(`Kept this workflow's own ${kept.join(', ')}: the pasted blocks call it, not the copy.`)
  if (conflicts.length) lines.push(`Not added: ${conflicts.join(', ')} (a block here has that name).`)
  if (result.unparsed.length)
    lines.push(
      `Check ${result.unparsed.join(', ')}: their code doesn't parse, so names in it weren't updated to the pasted blocks' new ones.`,
    )
  const here = result.outside.filter((o) => o.inTarget).map((o) => o.name)
  const missing = result.outside.filter((o) => !o.inTarget).map((o) => o.name)
  if (here.length)
    lines.push(`They read blocks that weren't copied and now read this workflow's: ${here.join(', ')}.`)
  if (missing.length) lines.push(`They read blocks that weren't copied: ${missing.join(', ')}.`)
  return lines.length ? lines.join(' ') : null
}
