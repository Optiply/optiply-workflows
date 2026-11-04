import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { type CollabSpec, equal, SharedDefinition } from '../src'

/** The first place two JSON values differ, for debugging (`DEBUG_COLLAB=1`). */
function difference(a: unknown, b: unknown, path = ''): string | null {
  if (equal(a, b)) return null
  if (typeof a === 'object' && a && typeof b === 'object' && b) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = difference(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      )
      if (d) return d
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 300)} vs ${JSON.stringify(b)?.slice(0, 300)}`
}

/**
 * Property tests (M16 step 1b): replicas make random edits with the editors' own functions, exchange updates in
 * random orders (some only one way, some not until the end), and must end with the same definition, which the schema
 * accepts and which reads the same from a fresh view of the document (so the read cache never goes stale).
 *
 * Two merges the generators steer clear of, because they can break the schema whatever the mapping does (the server's
 * materializer refuses such a definition and the editors say so, §2.19): concurrent deletes that together empty a
 * branch's conditions (at least one), or a must-not-be-blank field's text. Edits never delete the last three
 * conditions, nor a text field's first character.
 */

/** Whether an identity-matched array somewhere in `json` has two items with one identity. */
function repeats(spec: CollabSpec, json: unknown, path: (string | number)[] = []): boolean {
  if (Array.isArray(json)) {
    const identity = spec.identity(path)
    const keys = identity ? json.map(identity).filter((k) => k !== undefined) : []
    return new Set(keys).size < keys.length || json.some((item, i) => repeats(spec, item, [...path, i]))
  }
  if (typeof json !== 'object' || json === null) return false
  return Object.entries(json).some(([k, v]) => repeats(spec, v, [...path, k]))
}

import { appRun, type Run, random, workflowRun } from './generate'

function converge<T>(run: Run<T>, seed: number, replicas: number, edits: number): void {
  const r = random(seed)
  const first = new SharedDefinition<T>(new Y.Doc(), run.spec)
  first.set(run.start)
  const all = [first]
  for (let i = 1; i < replicas; i++) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(first.doc))
    all.push(new SharedDefinition<T>(doc, run.spec))
  }
  const pass = (from: SharedDefinition<T>, to: SharedDefinition<T>) =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)))
  const at = (i: number) => all[i] as SharedDefinition<T>
  for (let i = 0; i < edits; i++) {
    const shared = at(r.int(replicas))
    const next = run.edit(r, shared.value)
    if (next) {
      // Every edit an editor makes is schema-valid on its own.
      run.parse(next)
      shared.set(next, 'local')
      // Unless typing split an emoji (the document keeps U+FFFD for the lone half, as every replica will), or the
      // edit repeated an identity (a rename onto a dangling edge's end): then it reads back as the document.
      if (!/\\ud[89a-f]/i.test(JSON.stringify(next)) && !repeats(run.spec, next)) {
        expect(shared.value, `seed ${seed}: a local edit reads back as itself`).toBe(next)
      }
    }
    if (r.chance(0.3)) pass(at(r.int(replicas)), at(r.int(replicas)))
  }
  for (const a of all) for (const b of all) if (a !== b) pass(a, b)
  const result = first.value
  for (const shared of all) {
    if (process.env.DEBUG_COLLAB && !equal(shared.value, result)) {
      const fresh = (s: SharedDefinition<T>) => new SharedDefinition<T>(s.doc, run.spec).value
      console.log(seed, {
        replicas: difference(shared.value, result),
        documents: difference(fresh(shared), fresh(first)),
        staleHere: difference(shared.value, fresh(shared)),
        staleFirst: difference(result, fresh(first)),
      })
    }
    expect(shared.value, `seed ${seed}: replicas converge`).toEqual(result)
    const fresh = new SharedDefinition<T>(shared.doc, run.spec)
    expect(fresh.value, `seed ${seed}: the cache matches the document`).toEqual(shared.value)
    fresh.destroy()
  }
  expect(() => run.parse(result), `seed ${seed}: the merge passes the schema`).not.toThrow()
}

describe('replicas converge on a schema-valid definition', () => {
  const seeds = Array.from({ length: 150 }, (_, i) => i + 1)

  it('workflows, two replicas', () => {
    for (const seed of seeds) converge(workflowRun, seed, 2, 40)
  })

  it('workflows, three replicas', () => {
    for (const seed of seeds) converge(workflowRun, 1000 + seed, 3, 60)
  })

  it('apps, two replicas', () => {
    for (const seed of seeds) converge(appRun, 2000 + seed, 2, 40)
  })

  it('apps, three replicas', () => {
    for (const seed of seeds) converge(appRun, 3000 + seed, 3, 60)
  })
})
