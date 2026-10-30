import { buildGraph } from './graph'
import type { WorkflowDefinition } from './schema'
import type { Diagnostic } from './validate'
import { calledFunctions } from './walk'

/** The blocks a run of `targets` touches: the targets and their ancestors (M28's "Run block"). */
export function runScope(
  def: Pick<WorkflowDefinition, 'blocks' | 'edges'>,
  targets: readonly string[],
): Set<string> {
  const graph = buildGraph(def)
  return new Set(targets.flatMap((name) => [name, ...graph.ancestors(name)]))
}

/**
 * The errors that stop a run. A whole run: every error. A run of some blocks (`targets`): only errors in those
 * blocks and their ancestors, in the functions they call, on edges between them, cycles, and the workflow's own (not
 * its triggers', which a block run doesn't use), so a broken block elsewhere doesn't stop testing this one.
 */
export function blockingErrors(
  def: WorkflowDefinition,
  diagnostics: readonly Diagnostic[],
  targets?: readonly string[],
): Diagnostic[] {
  const errors = diagnostics.filter((d) => d.severity === 'error')
  if (!targets) return errors
  const scope = runScope(def, targets)
  const names = new Set((def.functions ?? []).map((f) => f.name))
  const called = new Set(
    def.blocks.filter((b) => scope.has(b.name)).flatMap((b) => [...calledFunctions(b, names)]),
  )
  // Functions calling functions: follow the calls.
  for (const name of [...called]) collectCalls(def, name, names, called)
  return errors.filter((d) => {
    // The engine orders every block up front: a cycle anywhere stops any run.
    if (d.code === 'cycle') return true
    if (d.function) return called.has(d.function)
    if (d.block) return scope.has(d.block)
    if (d.path[0] === 'triggers') return false
    if (d.path[0] === 'edges' && typeof d.path[1] === 'number') {
      const edge = def.edges[d.path[1]]
      return !edge || (scope.has(edge.from) && scope.has(edge.to))
    }
    return true
  })
}

function collectCalls(def: WorkflowDefinition, fn: string, names: ReadonlySet<string>, into: Set<string>) {
  const body = def.functions?.find((f) => f.name === fn)
  for (const block of body?.blocks ?? []) {
    for (const next of calledFunctions(block, names)) {
      if (into.has(next)) continue
      into.add(next)
      collectCalls(def, next, names, into)
    }
  }
}
