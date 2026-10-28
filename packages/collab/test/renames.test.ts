import type { AppDefinition } from '@ow/app-definition'
import { renameAppEntity } from '@ow/app-definition'
import { renameBlock, type WorkflowDefinition } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import {
  appRenamer,
  appSpec,
  findRenames,
  type MergeObject,
  mergeObject,
  type Renamer,
  workflowRenamer,
  workflowSpec,
} from '../src'
import { appRun, random, workflowRun } from './generate'

const object = <D>(definition: D): MergeObject<D> => ({ name: 'Orders', description: null, definition })

const flow = (fetchCode = 'return 1', useCode = 'return fetch.data'): WorkflowDefinition =>
  ({
    schemaVersion: 1,
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      { name: 'fetch', type: 'code', config: { code: fetchCode } },
      { name: 'use', type: 'code', config: { code: useCode } },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'fetch' },
      { from: 'fetch', port: 'out', to: 'use' },
    ],
  }) as WorkflowDefinition

const renamed = (def: WorkflowDefinition, from: string, to: string) => {
  const result = renameBlock(def, from, to)
  if (!result.ok) throw new Error(result.error)
  return result.definition
}

const blocks = (def: WorkflowDefinition) =>
  Object.fromEntries(
    def.blocks.map((b) => [b.name, (b as { config?: { code?: string } }).config?.code ?? null]),
  )

describe('renames in a merge (M22)', () => {
  it('finds a rename: an item gone and one equal to it under the new name', () => {
    expect(findRenames(workflowRenamer, flow(), renamed(flow(), 'fetch', 'load'))).toEqual([
      { group: 'blocks', from: 'fetch', to: 'load' },
    ])
    // Renamed and changed on the same side: a deleted block and a new one.
    const changed = renamed(flow('return 2'), 'fetch', 'load')
    expect(findRenames(workflowRenamer, flow(), changed)).toEqual([])
  })

  it('merges a rename on one side with edits on the other, references included', () => {
    const base = flow()
    const ours = renamed(base, 'fetch', 'load')
    const theirs = flow('return 2', 'return fetch.data + fetch.data')
    // Without following it: the block was deleted on one side and changed on the other.
    expect(
      mergeObject(workflowSpec, object(base), object(ours), object(theirs)).conflicts.length,
    ).toBeGreaterThan(0)
    const result = mergeObject(workflowSpec, object(base), object(ours), object(theirs), {
      renamer: workflowRenamer,
    })
    expect(result.conflicts).toEqual([])
    expect(blocks(result.merged.definition)).toEqual({
      startTrigger: null,
      load: 'return 2',
      use: 'return load.data + load.data',
    })
    // Theirs renamed, ours edited: the same.
    const swapped = mergeObject(workflowSpec, object(base), object(theirs), object(ours), {
      renamer: workflowRenamer,
    })
    expect(swapped.conflicts).toEqual([])
    expect(blocks(swapped.merged.definition)).toEqual(blocks(result.merged.definition))
  })

  it('takes one rename made on both sides, and makes two different ones a conflict over the name', () => {
    const base = flow()
    const same = mergeObject(
      workflowSpec,
      object(base),
      object(renamed(base, 'fetch', 'load')),
      object(renamed(base, 'fetch', 'load')),
      { renamer: workflowRenamer },
    )
    expect(same.conflicts).toEqual([])

    const sides = [
      object(base),
      object(renamed(base, 'fetch', 'load')),
      object(renamed(base, 'fetch', 'read')),
    ] as const
    const conflicted = mergeObject(workflowSpec, ...sides, { renamer: workflowRenamer })
    expect(conflicted.conflicts).toEqual([
      expect.objectContaining({
        kind: 'value',
        at: ['definition', 'blocks', 'fetch', 'name'],
        base: 'fetch',
        ours: 'load',
        theirs: 'read',
      }),
    ])
    // Left at ours until resolved.
    expect(Object.keys(blocks(conflicted.merged.definition))).toContain('load')
    const id = conflicted.conflicts[0]!.id
    const theirs = mergeObject(workflowSpec, ...sides, {
      renamer: workflowRenamer,
      resolutions: { [id]: 'theirs' },
    })
    expect(theirs.conflicts).toEqual([])
    expect(blocks(theirs.merged.definition)).toEqual({
      startTrigger: null,
      read: 'return 1',
      use: 'return read.data',
    })
  })

  it('leaves a rename on one side and a delete on the other as before', () => {
    const base = flow()
    const deleted = {
      ...base,
      blocks: base.blocks.filter((b) => b.name !== 'use'),
      edges: base.edges.slice(0, 1),
    }
    const result = mergeObject(
      workflowSpec,
      object(base),
      object(renamed(base, 'use', 'consume')),
      object(deleted as WorkflowDefinition),
      { renamer: workflowRenamer },
    )
    // Not followed: consume is a new block on our side, use deleted on theirs.
    expect(Object.keys(blocks(result.merged.definition)).sort()).toEqual(['consume', 'fetch', 'startTrigger'])
  })

  it('follows an app query renamed on one side while the other edits it', () => {
    const base = appRun.start
    const query = base.queries[0]!
    expect(query).toBeDefined()
    const r = renameAppEntity(base, query.name, `${query.name}Renamed`)
    if (!r.ok) throw new Error(r.error)
    const theirs: AppDefinition = {
      ...base,
      queries: base.queries.map((q, i) =>
        i === 0 ? { ...q, run: (q as { run?: string }).run === 'auto' ? 'manual' : 'auto' } : q,
      ),
    } as AppDefinition
    const result = mergeObject(appSpec, object(base), object(r.definition), object(theirs), {
      renamer: appRenamer,
    })
    expect(result.conflicts).toEqual([])
    const merged = result.merged.definition.queries.find((q) => q.name === `${query.name}Renamed`)
    expect((merged as { run?: string } | undefined)?.run).toBe((theirs.queries[0] as { run?: string }).run)
  })

  it('finds a rename of an item whose text names it as a plain word (a table named like the block)', () => {
    const base = flow('return "select * from fetch"')
    const ours = renamed(base, 'fetch', 'orders')
    // Not a reference: the string keeps the word on the renamed side.
    expect(JSON.stringify(ours)).toContain('from fetch')
    expect(findRenames(workflowRenamer, base, ours)).toEqual([
      { group: 'blocks', from: 'fetch', to: 'orders' },
    ])
  })

  it('renames whole definitions only for likely pairs, however many items were replaced (M22 review)', () => {
    const many = (prefix: string, n: number): WorkflowDefinition => ({
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        ...Array.from({ length: n }, (_, i) => ({
          name: `${prefix}${i}`,
          type: 'code' as const,
          config: { code: `return "${prefix} ${i}"` },
        })),
      ],
      edges: [],
    })
    const base = many('old', 60)
    // Sixty blocks replaced by sixty others, and one of them renamed for real.
    const side = { ...many('new', 60) }
    side.blocks = [...side.blocks, { ...base.blocks[1]!, name: 'renamedOld0' }]
    let calls = 0
    const counting: Renamer<WorkflowDefinition> = {
      items: workflowRenamer.items,
      rename: (...args) => {
        calls++
        return workflowRenamer.rename(...args)
      },
    }
    expect(findRenames(counting, base, side)).toEqual([{ group: 'blocks', from: 'old0', to: 'renamedOld0' }])
    // One probe per gone item and one real rename for the match, not one per pair (3,600 before).
    expect(calls).toBeLessThanOrEqual(61)
  })

  it('property: a rename on one side merged with random edits on the other is the edits renamed', () => {
    let checked = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      let base = workflowRun.start
      for (let i = 0; i < 6; i++) base = workflowRun.edit(r, base) ?? base
      const block = r.pick(base.blocks.filter((b) => b.type !== 'startTrigger'))
      if (!block) continue
      const to = `${block.name}Renamed`
      const ours = renameBlock(base, block.name, to)
      if (!ours.ok) continue
      let theirs = base
      for (let i = 0; i < 4; i++) theirs = workflowRun.edit(r, theirs) ?? theirs
      // Only where the other side keeps the block (a delete stays as before) and the rename applies there.
      if (!theirs.blocks.some((b) => b.name === block.name) || theirs.blocks.some((b) => b.name === to))
        continue
      const expected = renameBlock(theirs, block.name, to)
      if (!expected.ok) continue
      const result = mergeObject(workflowSpec, object(base), object(ours.definition), object(theirs), {
        renamer: workflowRenamer,
      })
      expect(result.conflicts, `seed ${seed}`).toEqual([])
      expect(result.merged.definition, `seed ${seed}`).toEqual(expected.definition)
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })
})
