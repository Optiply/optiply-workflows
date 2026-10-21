import {
  type AppDefinition,
  addComponent,
  addPage,
  addQuery,
  addTransformer,
  addVariable,
  appDefinitionSchema,
  type EventHandler,
  emptyApp,
  removeCode,
  removeComponent,
  removePage,
  renameAppEntity,
  setHandlers,
  setPositions,
  setProp,
  updateQuery,
  updateTransformer,
  updateVariable,
  usedNames,
} from '@ow/app-definition'
import {
  type Block,
  blockPorts,
  copyBlocks,
  pasteBlocks,
  renameBlock,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { appSpec, type CollabSpec, equal, SharedDefinition, workflowSpec } from '../src'

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

/** mulberry32: small, fast and seedable. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(items: readonly T[]): T | undefined => items[int(items.length)]
  return { next, int, pick, chance: (p: number) => next() < p }
}
type Random = ReturnType<typeof random>

/** Types into a text: inserts, deletes or replaces a few characters, never the first one. */
function typeInto(r: Random, text: string): string {
  const at = 1 + r.int(Math.max(text.length, 1))
  const words = ['x', ' + 1', '\n', 'value', '😀', '{{ a }}', 'é']
  switch (r.int(3)) {
    case 0:
      return text.slice(0, at) + r.pick(words) + text.slice(at)
    case 1:
      return text.slice(0, at) + text.slice(at + 1 + r.int(4))
    default:
      return text.slice(0, at) + r.pick(words) + text.slice(at + 1 + r.int(3))
  }
}

interface Run<T> {
  spec: CollabSpec
  start: T
  edit(r: Random, def: T): T | null
  parse(def: T): unknown
}

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

// --- Workflows ---------------------------------------------------------------------------------------------------

const allBlockNames = (def: WorkflowDefinition) =>
  new Set([def, ...(def.functions ?? [])].flatMap((g) => g.blocks.map((b) => b.name)))

/** Like the editor's catalog: the type's stem and the first free number. */
function freeName(def: WorkflowDefinition, stem: string): string {
  const taken = allBlockNames(def)
  for (const f of def.functions ?? []) taken.add(f.name)
  let n = 1
  while (taken.has(`${stem}${n}`)) n++
  return `${stem}${n}`
}

function newBlock(r: Random, name: string): Block {
  switch (r.int(6)) {
    case 0:
      return {
        name,
        type: 'branch',
        config: { conditions: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, expression: 'a' })) },
      }
    case 1:
      return { name, type: 'filter', config: { input: '{{ a }}', condition: 'value' } }
    case 2:
      return { name, type: 'response', config: { headers: [{ key: 'a', value: '1' }], body: '{}' } }
    case 3:
      return { name, type: 'wait', config: { kind: 'duration', amount: '1', unit: 'minutes' } }
    case 4:
      return { name, type: 'resourceQuery', config: { resource: 'pg', query: { sql: 'select 1' } } }
    default:
      return { name, type: 'code', config: { code: 'return 1' } }
  }
}

type Graph = Pick<WorkflowDefinition, 'blocks' | 'edges' | 'layout'>

/** One block's text edits, as its inspector makes them. */
function editBlock(r: Random, block: Block): Block | null {
  switch (block.type) {
    case 'code':
      return { ...block, config: { ...block.config, code: typeInto(r, block.config.code) } }
    case 'resourceQuery':
      return {
        ...block,
        config: {
          ...block.config,
          query: { ...block.config.query, sql: typeInto(r, String(block.config.query.sql)) },
        },
      }
    case 'filter':
      return r.chance(0.5)
        ? { ...block, config: { ...block.config, input: typeInto(r, block.config.input) } }
        : { ...block, config: { ...block.config, condition: typeInto(r, block.config.condition) } }
    case 'branch': {
      const conditions = [...block.config.conditions]
      const i = r.int(conditions.length)
      const c = conditions[i]
      if (!c) return null
      const choice = r.int(4)
      if (choice === 0) conditions[i] = { ...c, expression: typeInto(r, c.expression) }
      else if (choice === 1 && conditions.length > 3) conditions.splice(i, 1)
      else if (choice === 2) conditions.push({ id: `c${r.int(1e6)}`, expression: 'b' })
      else if (choice === 3 && i > 0) conditions.splice(i - 1, 2, c, conditions[i - 1] as typeof c)
      else return null
      return { ...block, config: { conditions } }
    }
    case 'response': {
      const headers = [...(block.config.headers ?? [])]
      const choice = r.int(4)
      if (choice === 0) headers.push({ key: `h${r.int(100)}`, value: 'v' })
      else if (choice === 1 && headers.length) headers.splice(r.int(headers.length), 1)
      else if (choice === 2 && headers.length) {
        const i = r.int(headers.length)
        headers[i] = { ...(headers[i] as { key: string; value: string }), value: `v${r.int(100)}` }
      } else return { ...block, config: { ...block.config, body: typeInto(r, block.config.body ?? '{}') } }
      return { ...block, config: { ...block.config, headers } }
    }
    case 'wait':
      // Switching kinds replaces the config whole; staying edits it in place.
      if (r.chance(0.4)) {
        return {
          ...block,
          config:
            block.config.kind === 'duration'
              ? { kind: 'until', until: '2030-01-01' }
              : { kind: 'duration', amount: '2', unit: 'hours' },
        }
      }
      return block.config.kind === 'duration'
        ? {
            ...block,
            config: { ...block.config, unit: r.pick(['seconds', 'minutes', 'days'] as const) ?? 'days' },
          }
        : { ...block, config: { ...block.config, until: typeInto(r, block.config.until) } }
    default:
      return null
  }
}

function editGraph(r: Random, def: WorkflowDefinition, graph: Graph): Graph | null {
  const blocks = graph.blocks
  const others = blocks.filter((b) => b.type !== 'startTrigger')
  switch (r.int(8)) {
    case 0: {
      const block = newBlock(r, freeName(def, r.pick(['code', 'query', 'step']) ?? 'code'))
      const from = r.pick(blocks)
      return {
        blocks: [...blocks, block],
        edges: from ? [...graph.edges, { from: from.name, port: 'out', to: block.name }] : graph.edges,
        layout: { blocks: { ...graph.layout?.blocks, [block.name]: { x: r.int(500), y: r.int(500) } } },
      }
    }
    case 1: {
      const gone = r.pick(others)
      if (!gone) return null
      const { [gone.name]: _, ...positions } = graph.layout?.blocks ?? {}
      return {
        blocks: blocks.filter((b) => b !== gone),
        edges: graph.edges.filter((e) => e.from !== gone.name && e.to !== gone.name),
        layout: { blocks: positions },
      }
    }
    case 2: {
      const from = r.pick(blocks)
      const to = r.pick(others)
      const port = from && r.pick(blockPorts(from))
      if (!from || !to || !port || from === to) return null
      if (graph.edges.some((e) => e.from === from.name && e.port === port && e.to === to.name)) return null
      return { ...graph, edges: [...graph.edges, { from: from.name, port, to: to.name }] }
    }
    case 3: {
      const edge = r.pick(graph.edges)
      return edge ? { ...graph, edges: graph.edges.filter((e) => e !== edge) } : null
    }
    case 4: {
      const moved = r.pick(others)
      if (!moved) return null
      return {
        ...graph,
        layout: { blocks: { ...graph.layout?.blocks, [moved.name]: { x: r.int(900), y: r.int(900) } } },
      }
    }
    default: {
      const block = r.pick(others)
      const edited = block && editBlock(r, block)
      return edited ? { ...graph, blocks: blocks.map((b) => (b === block ? edited : b)) } : null
    }
  }
}

function editWorkflow(r: Random, def: WorkflowDefinition): WorkflowDefinition | null {
  const fns = def.functions ?? []
  const choice = r.int(10)
  if (choice === 0) {
    const block = r.pick(def.blocks.filter((b) => b.type !== 'startTrigger'))
    const renamed = block && renameBlock(def, block.name, freeName(def, 'renamed'))
    return renamed?.ok ? renamed.definition : null
  }
  if (choice === 1) {
    const names = def.blocks.filter(() => r.chance(0.3)).map((b) => b.name)
    const clip = copyBlocks(def, null, names)
    return clip ? pasteBlocks(def, null, clip).definition : null
  }
  if (choice === 2 && fns.length < 3) {
    const name = freeName(def, 'fn')
    const block = freeName(def, 'calc')
    return {
      ...def,
      functions: [
        ...fns,
        { name, blocks: [{ name: block, type: 'code', config: { code: 'return 1' } }], edges: [] },
      ],
    }
  }
  if (choice === 3) {
    const fn = r.pick(fns)
    if (!fn) return null
    const graph = editGraph(r, def, fn)
    return graph && { ...def, functions: fns.map((f) => (f === fn ? { ...f, ...graph } : f)) }
  }
  const graph = editGraph(r, def, def)
  return graph && { ...def, ...graph }
}

const workflowRun: Run<WorkflowDefinition> = {
  spec: workflowSpec,
  start: workflowDefinitionSchema.parse({
    schemaVersion: 1,
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      { name: 'code1', type: 'code', config: { code: 'return 1' } },
      { name: 'branch1', type: 'branch', config: { conditions: [{ id: 'a', expression: 'x' }] } },
    ],
    edges: [{ from: 'startTrigger', port: 'out', to: 'code1' }],
    layout: { blocks: { code1: { x: 0, y: 0 } } },
  }),
  edit: editWorkflow,
  parse: (def) => workflowDefinitionSchema.parse(def),
}

// --- Apps --------------------------------------------------------------------------------------------------------

const COMPONENT_TYPES = ['button', 'text', 'textInput', 'table', 'container']

function newHandler(r: Random): EventHandler {
  const id = `h${r.int(1e6)}`
  switch (r.int(3)) {
    case 0:
      return { id, event: 'click', action: { type: 'runScript', code: 'go()' } }
    case 1:
      return { id, event: 'click', action: { type: 'notify', message: 'Hi', tone: 'info' } }
    default:
      return { id, event: 'click', action: { type: 'openUrl', url: 'https://x' } }
  }
}

function editApp(r: Random, def: AppDefinition): AppDefinition | null {
  const component = r.pick(def.components)
  const query = r.pick(def.queries)
  switch (r.int(14)) {
    case 0: {
      const parent = r.pick(def.components.filter((c) => c.type === 'container'))
      return addComponent(def, r.pick(COMPONENT_TYPES) ?? 'button', {
        parent: r.chance(0.5) ? parent?.name : undefined,
      }).definition
    }
    case 1:
      return component ? removeComponent(def, component.name) : null
    case 2: {
      if (!component) return null
      const text = component.props?.text
      return setProp(def, component.name, 'text', typeInto(r, typeof text === 'string' ? text : 'Hello'))
    }
    case 3: {
      const at = component && def.layout?.[component.name]
      if (!component || !at) return null
      const w = 1 + r.int(12)
      return setPositions(def, { [component.name]: { ...at, x: r.int(13 - w), w } })
    }
    case 4: {
      if (!component) return null
      const events = [...(component.events ?? [])]
      const i = r.int(events.length + 1)
      const handler = events[i]
      const roll = r.next()
      if (!handler || roll < 0.3) events.push(newHandler(r))
      else if (roll < 0.5) events.splice(i, 1)
      else if (handler.action.type === 'runScript' && roll < 0.85) {
        events[i] = { ...handler, action: { ...handler.action, code: typeInto(r, handler.action.code) } }
      } else events[i] = { ...newHandler(r), id: handler.id }
      return setHandlers(def, component.name, events)
    }
    case 5:
      return addQuery(def, r.chance(0.5) ? 'js' : 'resource', { resource: 'pg' }).definition
    case 6:
      return query
        ? updateQuery(def, query.name, (q) =>
            q.kind === 'js'
              ? { ...q, code: typeInto(r, q.code) }
              : q.kind === 'resource'
                ? { ...q, query: { ...q.query, sql: typeInto(r, String(q.query.sql ?? 'select 1')) } }
                : q,
          )
        : null
    case 7:
      return addTransformer(def).definition
    case 8: {
      const t = r.pick(def.transformers ?? [])
      return t ? updateTransformer(def, t.name, (x) => ({ ...x, code: typeInto(r, x.code) })) : null
    }
    case 9: {
      const v = r.pick(def.variables ?? [])
      if (!v) return addVariable(def).definition
      const values = [typeInto(r, String(v.initialValue ?? 'a')), 3, { rows: [1] }, null]
      return updateVariable(def, v.name, (x) => ({ ...x, initialValue: r.pick(values) }))
    }
    case 10: {
      const code = r.pick([...def.queries, ...(def.transformers ?? []), ...(def.variables ?? [])])
      return code ? removeCode(def, code.name) : null
    }
    case 11: {
      const names = [...usedNames(def)].filter((n) => !(def.pages ?? []).some((p) => p.name === n))
      const from = r.pick(names)
      if (!from) return null
      let n = 1
      while (usedNames(def).has(`renamed${n}`)) n++
      const renamed = renameAppEntity(def, from, `renamed${n}`)
      return renamed.ok ? renamed.definition : null
    }
    case 12:
      return (def.pages ?? []).length < 3 ? addPage(def).definition : null
    default: {
      const page = r.pick(def.pages ?? [])
      return page && (def.pages ?? []).length > 1 ? removePage(def, page.name) : null
    }
  }
}

const appRun: Run<AppDefinition> = {
  spec: appSpec,
  start: appDefinitionSchema.parse({
    ...emptyApp(),
    components: [{ name: 'button1', type: 'button', props: { text: 'Go' } }],
    queries: [{ name: 'query1', kind: 'js', code: 'return 1' }],
    layout: { button1: { x: 0, y: 0, w: 3, h: 1 } },
  }),
  edit: editApp,
  parse: (def) => appDefinitionSchema.parse(def),
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
