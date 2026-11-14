import { AI_RESOURCE_TYPES } from '@ow/connectors/ai-models'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import CodeField, { type CodeFieldProps } from '@/components/code/code-field'
import type { TextBinding } from '@/components/code/text-binding'
import { useTRPC } from '@/lib/trpc'
import { currentAwareness } from './collab'
import { scopeDeclarations } from './scope-types'
import { graphOf, useEditor } from './store'

export type { CodeFieldProps, FieldProblem } from '@/components/code/code-field'

export interface WorkflowCodeFieldProps extends CodeFieldProps {
  /** Where the field's text sits in the definition, to edit it together with others (M16). */
  text?: (string | number)[]
  /** Cleared, the field is removed from the definition (optional fields where absent means something else). */
  removeEmpty?: boolean
}

/**
 * A Monaco field whose completions know the open graph's blocks, their last results and the functions; bound to its
 * text in the shared document when it has one there.
 */
export default function WorkflowCodeField({ text: at, removeEmpty, ...props }: WorkflowCodeFieldProps) {
  const definition = useEditor((s) => s.definition)
  const samples = useEditor((s) => s.samples)
  const fn = useEditor((s) => s.graph)
  const shared = useEditor((s) => s.shared)
  const readOnly = useEditor((s) => s.readOnly)
  const trpc = useTRPC()
  const { data: resources } = useQuery(trpc.resources.list.queryOptions())
  const aiResources = useMemo(
    () =>
      new Set<string>(
        (resources?.resources ?? []).filter((r) => AI_RESOURCE_TYPES.has(r.type)).map((r) => r.slug),
      ),
    [resources],
  )
  const scope = useMemo(() => {
    const functions = definition.functions ?? []
    const open = fn === null ? undefined : functions.find((f) => f.name === fn)
    const bodySchema = open ? undefined : definition.triggers?.webhook?.bodySchema
    return scopeDeclarations(
      graphOf(definition, fn).blocks,
      samples,
      functions,
      open,
      bodySchema,
      aiResources,
    )
  }, [definition, samples, fn, aiResources])
  // Looked up again as the definition changes: the text appears with the field's first value, and is replaced when
  // its block or field is.
  const key = at?.join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `at`; `definition` marks the document changing
  const binding = useMemo((): TextBinding | null => {
    const text = at && shared && !readOnly ? shared.textAt(at) : null
    if (!text || !at) return null
    return {
      text,
      write: (change) => useEditor.getState().editText(at, change, { removeEmpty }),
      undo: () => useEditor.getState().undo(),
      redo: () => useEditor.getState().redo(),
      awareness: currentAwareness(),
    }
  }, [key, shared, readOnly, definition, removeEmpty])
  return <CodeField {...props} binding={binding} scope={scope} />
}
