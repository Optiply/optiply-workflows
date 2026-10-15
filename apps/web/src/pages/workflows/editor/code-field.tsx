import { useMemo } from 'react'
import CodeField, { type CodeFieldProps } from '@/components/code/code-field'
import { scopeDeclarations } from './scope-types'
import { graphOf, useEditor } from './store'

export type { CodeFieldProps, FieldProblem } from '@/components/code/code-field'

/** A Monaco field whose completions know the open graph's blocks, their last results and the functions. */
export default function WorkflowCodeField(props: CodeFieldProps) {
  const definition = useEditor((s) => s.definition)
  const samples = useEditor((s) => s.samples)
  const fn = useEditor((s) => s.graph)
  const scope = useMemo(() => {
    const functions = definition.functions ?? []
    const open = fn === null ? undefined : functions.find((f) => f.name === fn)
    return scopeDeclarations(graphOf(definition, fn).blocks, samples, functions, open)
  }, [definition, samples, fn])
  return <CodeField {...props} scope={scope} />
}
