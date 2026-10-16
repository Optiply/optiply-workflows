import {
  type AppDefinition,
  appDefinitionHash,
  appDefinitionSchema,
  canonicalizeApp,
} from '@ow/app-definition'
import {
  type Block,
  canonicalJson,
  definitionHash,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import { describe, expect, it } from 'vitest'
import { decodeApp, decodeWorkflow, encodeApp, encodeWorkflow, workflowForGit } from '../src'

/** Deterministic randomness (mulberry32), so a failing seed can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (max: number) => Math.floor(next() * max)
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!
  const chance = (p: number) => next() < p
  return { int, pick, chance }
}

type Rng = ReturnType<typeof rng>

/** Strings that tend to break file round trips: newlines at either end, CRLF, empty, unicode, templates. */
const PIECES = [
  '',
  '\n',
  '\n\n',
  '\r\n',
  ' ',
  'select 1',
  '{{ a.data }}',
  'é漢🙂',
  '\\n',
  '"quoted"',
  '\t',
  '// x',
  '}',
]

function text(r: Rng): string {
  let out = ''
  const n = r.int(5)
  for (let i = 0; i < n; i++) out += r.pick(PIECES)
  return out
}

function names(r: Rng, prefix: string, count: number): string[] {
  // Mixed case, so case-only differences come up (they're allowed; they only warn).
  return Array.from({ length: count }, (_, i) => `${r.chance(0.2) ? prefix.toUpperCase() : prefix}${i}`)
}

function block(r: Rng, name: string): Block {
  const settings = r.chance(0.3)
    ? { settings: { timeoutMs: 1000 + r.int(1000), finally: 'continue' as const } }
    : {}
  const query = () =>
    r.pick<Record<string, string | number>>([
      { sql: text(r) },
      { sql: text(r), extra: 1 },
      { method: 'GET', path: text(r) },
      {},
    ])
  switch (r.int(8)) {
    case 0:
      return { name, type: 'code', config: { code: text(r) }, ...settings }
    case 1:
      return { name, type: 'resourceQuery', config: { resource: 'shop', query: query() }, ...settings }
    case 2:
      return {
        name,
        type: 'loop',
        config: {
          input: '{{ x }}',
          runner: r.pick([
            { kind: 'code' as const, code: text(r) },
            { kind: 'query' as const, resource: 'shop', query: query() },
            { kind: 'function' as const, function: 'fn0' },
            { kind: 'workflow' as const, workflow: 'child-flow', input: text(r) },
          ]),
        },
      }
    case 3:
      return { name, type: 'branch', config: { conditions: [{ id: 'a', expression: `x${text(r)}` }] } }
    case 4:
      return { name, type: 'filter', config: { input: '{{ x }}', condition: 'value' } }
    case 5:
      return { name, type: 'response', config: { body: text(r) } }
    case 6:
      return { name, type: 'wait', config: { kind: 'duration', amount: '1', unit: 'minutes' } }
    default:
      return { name, type: 'userTask', config: { title: text(r), assignees: { users: ['a@optiply.nl'] } } }
  }
}

function layout(r: Rng, blockNames: string[]) {
  return r.pick([
    undefined,
    {},
    { blocks: {} },
    { blocks: Object.fromEntries(blockNames.map((n) => [n, { x: r.int(500) - 100, y: r.int(500) / 3 }])) },
  ])
}

function workflowDefinition(r: Rng): WorkflowDefinition {
  const blockNames = names(r, 'b', 1 + r.int(8))
  const def: WorkflowDefinition = {
    schemaVersion: 1,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blockNames.map((n) => block(r, n))],
    edges: blockNames.map((to) => ({ from: 'startTrigger', port: 'out', to })),
  }
  if (r.chance(0.5)) {
    def.functions = names(r, 'fn', 1 + r.int(3)).map((name) => {
      const inner = names(r, 'b', 1 + r.int(4)) // the same names as the workflow's: function blocks are local
      const fnLayout = layout(r, inner)
      return {
        name,
        blocks: inner.map((n) => block(r, n)),
        edges: [],
        ...(fnLayout ? { layout: fnLayout } : {}),
      }
    })
  }
  const top = layout(r, ['startTrigger', ...blockNames])
  if (top) def.layout = top
  if (r.chance(0.3)) def.triggers = { webhook: { enabled: true, alias: text(r) } }
  // Shuffle, so canonical ordering is part of what's tested.
  def.blocks.sort(() => r.int(3) - 1)
  return def
}

function appDefinition(r: Rng): AppDefinition {
  const componentNames = names(r, 'c', r.int(5))
  const def: AppDefinition = {
    schemaVersion: 1,
    components: componentNames.map((name) => ({
      name,
      type: 'text',
      props: { value: text(r) },
      ...(r.chance(0.3)
        ? { events: [{ id: 'h', event: 'click', action: { type: 'runScript' as const, code: text(r) } }] }
        : {}),
    })),
    queries: names(r, 'q', r.int(6)).map((name) => {
      const common = {
        name,
        ...(r.chance(0.4) ? { transform: text(r) } : {}),
        ...(r.chance(0.2) ? { description: text(r) } : {}),
      }
      return r.chance(0.5)
        ? { ...common, kind: 'js' as const, code: text(r) }
        : {
            ...common,
            kind: 'resource' as const,
            resource: 'shop',
            query: r.pick<Record<string, string>>([{ sql: text(r) }, { method: 'GET' }, {}]),
            run: r.pick(['auto', 'manual'] as const),
          }
    }),
  }
  if (r.chance(0.6)) def.transformers = names(r, 't', r.int(3)).map((name) => ({ name, code: text(r) }))
  if (r.chance(0.5)) def.variables = [{ name: 'v0', initialValue: text(r) }]
  const choice = r.int(3)
  if (choice === 1) def.layout = {}
  if (choice === 2) {
    def.layout = Object.fromEntries(componentNames.map((n, i) => [n, { x: 0, y: i, w: 1 + r.int(12), h: 1 }]))
  }
  return def
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1)

describe('round trip', () => {
  it.each(SEEDS)('workflow, seed %i', async (seed) => {
    const r = rng(seed)
    const definition = workflowDefinition(r)
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
    const object = {
      name: `Flow ${seed}`,
      description: r.chance(0.5) ? text(r).trim() || null : null,
      definition,
    }
    const { files } = encodeWorkflow(object)
    const decoded = decodeWorkflow(files)
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.problems))
    expect(canonicalJson(decoded.value.definition)).toBe(canonicalJson(workflowForGit(definition)))
    expect(decoded.value.name).toBe(object.name)
    expect(decoded.value.description).toBe(object.description)
    expect(await definitionHash(decoded.value.definition)).toBe(await definitionHash(definition))
    // Encoding what came back gives the same files.
    expect(encodeWorkflow(decoded.value).files).toEqual(files)
  })

  it.each(SEEDS)('app, seed %i', async (seed) => {
    const r = rng(seed)
    const definition = appDefinition(r)
    expect(appDefinitionSchema.safeParse(definition).success).toBe(true)
    const object = { name: `App ${seed}`, description: null, definition }
    const { files } = encodeApp(object)
    const decoded = decodeApp(files)
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.problems))
    expect(canonicalJson(decoded.value.definition)).toBe(canonicalJson(canonicalizeApp(definition)))
    expect(await appDefinitionHash(decoded.value.definition)).toBe(await appDefinitionHash(definition))
    expect(encodeApp(decoded.value).files).toEqual(files)
  })
})
