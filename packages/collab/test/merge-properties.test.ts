import { appDefinitionSchema } from '@ow/app-definition'
import { workflowDefinitionSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import { type MergeConflict, type MergeObject, mergeObject, type Path, type Resolution } from '../src'
import { appRun, type Random, type Run, random, workflowRun } from './generate'

/** A definition after `n` random edits (each one schema-valid, as the editors make them). */
function evolve<T>(run: Run<T>, r: Random, def: T, n: number): T {
  let d = def
  for (let i = 0; i < n; i++) d = run.edit(r, d) ?? d
  return d
}

const object = <D>(definition: D, name = 'Orders'): MergeObject<D> => ({
  name,
  description: null,
  definition,
})

/** Where a definition breaks its schema. */
const checker =
  (schema: { safeParse(d: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }) =>
  (d: unknown): Path[] => {
    const parsed = schema.safeParse(d)
    return parsed.success
      ? []
      : (parsed.error?.issues ?? []).map((i) => i.path.filter((k) => typeof k !== 'symbol'))
  }

/** Resolves every conflict with one side, round after round (a resolution can reveal a misfit), until none is left. */
function resolveAll<D>(
  spec: Run<D>['spec'],
  sides: [MergeObject<D>, MergeObject<D>, MergeObject<D>],
  side: 'ours' | 'theirs',
  check: (d: D) => Path[],
) {
  const resolutions: Record<string, Resolution> = {}
  for (let round = 0; round < 10; round++) {
    const result = mergeObject(spec, ...sides, { check, resolutions })
    if (result.conflicts.length === 0) return result.merged
    for (const c of result.conflicts) resolutions[c.id] = side
  }
  throw new Error('conflicts kept coming')
}

const shape = (c: MergeConflict, swap = false) =>
  JSON.stringify([c.kind, c.at, swap ? c.theirs : c.ours, swap ? c.ours : c.theirs, c.base])

function properties<D>(run: Run<D>, check: (d: D) => Path[], seed: number): void {
  const r = random(seed)
  const base = object(evolve(run, r, run.start, r.int(6)))
  const ours = object(evolve(run, r, base.definition, 1 + r.int(8)), r.chance(0.2) ? 'Ours' : 'Orders')
  const theirs = object(evolve(run, r, base.definition, 1 + r.int(8)), r.chance(0.2) ? 'Theirs' : 'Orders')
  const m = (b: MergeObject<D>, o: MergeObject<D>, t: MergeObject<D>) =>
    mergeObject(run.spec, b, o, t, { check })
  const msg = (what: string) => `seed ${seed}: ${what}`

  // One side unchanged: the other side, exactly.
  expect(m(base, ours, base), msg('theirs unchanged')).toEqual({ merged: ours, conflicts: [] })
  expect(m(base, base, theirs), msg('ours unchanged')).toEqual({ merged: theirs, conflicts: [] })
  // The same change on both sides.
  expect(m(base, ours, structuredClone(ours)), msg('the same change')).toEqual({
    merged: ours,
    conflicts: [],
  })

  // Swapping the sides swaps each conflict's sides.
  const forward = m(base, ours, theirs)
  const backward = m(base, theirs, ours)
  expect(backward.conflicts.map((c) => shape(c)).sort(), msg('symmetric conflicts')).toEqual(
    forward.conflicts.map((c) => shape(c, true)).sort(),
  )
  // Without conflicts, the merge fits the schema; the same either way round.
  if (forward.conflicts.length === 0) {
    expect(check(forward.merged.definition), msg('a clean merge fits')).toEqual([])
  }

  // Resolved all ours or all theirs, it fits the schema too.
  for (const side of ['ours', 'theirs'] as const) {
    const merged = resolveAll(run.spec, [base, ours, theirs], side, check)
    expect(check(merged.definition), msg(`resolved with ${side}, it fits`)).toEqual([])
  }
}

describe('merge properties over generated edits', () => {
  const seeds = Array.from({ length: Number(process.env.MERGE_SEEDS ?? 300) }, (_, i) => i + 1)

  it('workflows', () => {
    const check = checker(workflowDefinitionSchema)
    for (const seed of seeds) properties(workflowRun, check, seed)
  })

  it('apps', () => {
    const check = checker(appDefinitionSchema)
    for (const seed of seeds) properties(appRun, check, 5000 + seed)
  })
})
