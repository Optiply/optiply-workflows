import {
  type AppDefinition,
  type AppPasteResult,
  type CodeClip,
  type ComponentClip,
  codeClipSchema,
  componentClipSchema,
  componentSpec,
  containerViews,
  copyCode,
  copyComponents,
  pasteCode,
  pasteComponents,
  runsByItself,
  slotOf,
} from '@ow/app-definition'
import { canonicalJson } from '@ow/definition'
import { confirmDialog } from '@/components/confirm'
import { copiedHere, readClip, rememberCopy } from '@/lib/clipboard'
import { shownViews } from '../grid-context'
import type { Tone } from '../notifications'
import { useAppEditor } from './store'

type Notify = (message: string, tone: Tone) => void

/** What was chosen last as clipboard content: the selected component (with what's inside it), or the open code item. */
function chosenClip(): ComponentClip | CodeClip | null {
  const { definition, focus, selection, openCode } = useAppEditor.getState()
  // Every selected component (M24), with what's inside each.
  if (focus === 'component') return selection.length ? copyComponents(definition, selection) : null
  return openCode ? copyCode(definition, [openCode]) : null
}

/** The selected component or open code item as clipboard text (remembered as copied here); null with neither. */
export function copyText(): string | null {
  const clip = chosenClip()
  if (!clip) return null
  const text = JSON.stringify(clip)
  rememberCopy(text)
  return text
}

/** These components (with what's inside each) as clipboard text, remembered as copied here (the inspector's menu). */
export function copyComponentsText(names: readonly string[]): string | null {
  const { definition } = useAppEditor.getState()
  const known = names.filter((n) => definition.components.some((c) => c.name === n))
  if (!known.length) return null
  const text = JSON.stringify(copyComponents(definition, known))
  rememberCopy(text)
  return text
}

/**
 * Pastes clipboard text: components where the palette would add one (into the selected container, else next to the
 * selected component, on the page being edited), code into the code panel. False when the text isn't app content.
 * Content this browser didn't copy is only pasted once confirmed, saying which queries would run by themselves.
 */
export function pasteText(text: string, notify: Notify): boolean {
  const components = readClip(text, 'app-components', componentClipSchema)
  const code = components ? null : readClip(text, 'app-code', codeClipSchema)
  const read = components ?? code
  if (!read) return false
  if (!read.ok) {
    notify(read.error, 'error')
    return true
  }
  // Taken either way (the browser mustn't paste it elsewhere meanwhile); from elsewhere, pasted once confirmed.
  if (!copiedHere(text)) {
    const clip = read.clip
    void confirmDialog(untrustedQuestion(clip), { title: 'Paste from elsewhere?', confirm: 'Paste' }).then(
      (ok) => ok && paste(clip, notify),
    )
    return true
  }
  paste(read.clip, notify)
  return true
}

/** Copies the chosen component or code item next to itself (⌘D). */
export function duplicateChosen(notify: Notify): void {
  const clip = chosenClip()
  if (clip) paste(clip, notify, { duplicate: true })
}

function paste(clip: ComponentClip | CodeClip, notify: Notify, opts: { duplicate?: boolean } = {}) {
  const { update, url } = useAppEditor.getState()
  let result: AppPasteResult | null = null
  update((def) => {
    result =
      clip.ow === 'app-components'
        ? pasteComponents(def, clip, targetFor(def, clip, opts))
        : pasteCode(def, clip, url.page)
    return result.definition
  })
  const done = result as AppPasteResult | null
  if (!done?.added.length) return
  if (clip.ow === 'app-components') {
    const roots = done.added.filter((name) => {
      const c = useAppEditor.getState().definition.components.find((x) => x.name === name)
      return !c?.parent || !done.added.includes(c.parent)
    })
    useAppEditor.getState().select(roots[0] ?? null)
  } else useAppEditor.getState().openCodeItem(done.added[0]!)
  const summary = pasteSummary(done)
  if (summary) notify(summary, 'info')
}

/**
 * Where pasted components go, as the palette adds them: into the selected container, else next to the selected
 * component (in its container, or at the top on its page), else on the page being edited. The selected component's
 * own copy (or a duplicate) goes next to it, not into it.
 */
function targetFor(def: AppDefinition, clip: ComponentClip, opts: { duplicate?: boolean }) {
  const { selected, url } = useAppEditor.getState()
  const chosen = def.components.find((c) => c.name === selected)
  // A copy of the selected component as it is now (not just something with the same name, from another app).
  const isCopyOfIt =
    chosen !== undefined && canonicalJson(copyComponents(def, [chosen.name])) === canonicalJson(clip)
  const into = chosen && componentSpec(chosen.type)?.container && !opts.duplicate && !isCopyOfIt
  const parent = into ? chosen.name : chosen?.parent
  const page = def.pages?.length ? (chosen && parent === undefined ? (chosen.page ?? null) : url.page) : null
  // Into the view a container shows, or beside the copied component in its slot (M24).
  let slot: string | undefined
  if (into) {
    const views = containerViews(chosen).map((v) => v.name)
    const shown = shownViews.get(chosen.name)
    slot = views.length ? (shown && views.includes(shown) ? shown : views[0]) : undefined
  } else if (chosen?.parent !== undefined) {
    slot = slotOf(def, chosen)
  }
  return { ...(parent !== undefined && { parent }), page, ...(slot !== undefined && { slot }) }
}

function untrustedQuestion(clip: ComponentClip | CodeClip): string {
  const what =
    clip.ow === 'app-components'
      ? `${clip.components.length} component${clip.components.length === 1 ? '' : 's'}`
      : `${clip.queries.length + clip.transformers.length + clip.variables.length} queries, transformers or variables`
  const running = clip.ow === 'app-code' ? clip.queries.filter(runsByItself).map((q) => q.name) : []
  const runs = running.length
    ? ` ${running.join(', ')} would run straight away, against this app's resources, as you.`
    : ''
  return `Paste ${what} from the clipboard? They weren't copied in this browser: paste them only if you know where they came from.${runs}`
}

/** What the person should know about a paste, or null when it went as expected. */
export function pasteSummary(result: AppPasteResult): string | null {
  const lines: string[] = []
  const here = result.outside.filter((o) => o.inTarget).map((o) => o.name)
  const missing = result.outside.filter((o) => !o.inTarget).map((o) => o.name)
  if (here.length) lines.push(`It reads what wasn't copied and now reads this app's: ${here.join(', ')}.`)
  if (missing.length) lines.push(`It reads what wasn't copied: ${missing.join(', ')}.`)
  if (result.unparsed.length)
    lines.push(
      `Check ${result.unparsed.join(', ')}: their code doesn't parse, so names in it weren't updated to the pasted items' new ones.`,
    )
  if (result.runsByItself.length) lines.push(`Running by itself: ${result.runsByItself.join(', ')}.`)
  return lines.length ? lines.join(' ') : null
}
