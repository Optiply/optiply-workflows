import { useMemo } from 'react'
import CodeField, { type CodeFieldProps } from '@/components/code/code-field'
import type { TextBinding } from '@/components/code/text-binding'
import { currentAwareness } from './collab'
import { scopeDeclarations } from './scope-types'
import { graphOf, useEditor } from './store'

export type { CodeFieldProps, FieldProblem } from '@/components/code/code-field'

export interface WorkflowCodeFieldProps extends CodeFieldProps {
  /** Where the field's text sits in the definition, to edit it together with others (M16). */
  text?: (string | number)[]
}

/**
 * A Monaco field whose completions know the open graph's blocks, their last results and the functions; bound to its
 * text in the shared document when it has one there.
 */
export default function WorkflowCodeField({ text: at, ...props }: WorkflowCodeFieldProps) {
  const definition = useEditor((s) => s.definition)
  const samples = useEditor((s) => s.samples)
  const fn = useEditor((s) => s.graph)
  const shared = useEditor((s) => s.shared)
  const readOnly = useEditor((s) => s.readOnly)
  const scope = useMemo(() => {
    const functions = definition.functions ?? []
    const open = fn === null ? undefined : functions.find((f) => f.name === fn)
    const bodySchema = open ? undefined : definition.triggers?.webhook?.bodySchema
    return scopeDeclarations(graphOf(definition, fn).blocks, samples, functions, open, bodySchema)
  }, [definition, samples, fn])
  // Looked up again as the definition changes: the text appears with the field's first value, and is replaced when
  // its block or field is.
  const key = at?.join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `at`; `definition` marks the document changing
  const binding = useMemo((): TextBinding | null => {
    const text = at && shared && !readOnly ? shared.textAt(at) : null
    if (!text || !at) return null
    return {
      text,
      write: (change) => useEditor.getState().editText(at, change),
      undo: () => useEditor.getState().undo(),
      redo: () => useEditor.getState().redo(),
      awareness: currentAwareness(),
    }
  }, [key, shared, readOnly, definition])
  return <CodeField {...props} binding={binding} scope={scope} />
}
