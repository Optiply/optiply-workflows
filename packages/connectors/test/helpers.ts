import type { Evaluate } from '@ow/expressions'
import type { ResolvedResource } from '../src'

/** Stand-in for the sandbox: `{{ a.b }}` looks the dotted path up in the scope, and unknown roots throw. */
export function scopeEvaluator(scope: Record<string, unknown>): Evaluate & { calls: string[] } {
  const calls: string[] = []
  const evaluate = (code: string) => {
    const path = code.trim()
    calls.push(path)
    const [root, ...rest] = path.split('.')
    if (!(root! in scope)) throw new Error(`${root} is not defined`)
    return rest.reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], scope[root!])
  }
  return Object.assign(evaluate, { calls })
}

let n = 0
export function resource(config: unknown, secrets: unknown = {}, version = '1'): ResolvedResource {
  n++
  return { id: `rc-${n}`, resourceId: `r-${n}`, environmentId: 'env-prod', version, config, secrets }
}
