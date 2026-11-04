import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  blockPorts,
  calledWorkflows,
  canonicalize,
  definitionHash,
  functionReturnBlock,
  type QueryValidator,
  queriedResources,
  renameBlock,
  renameFunction,
  resolveBlockSettings,
  resolveIterationSettings,
  suspends,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '../src'
import { code, sql, start, wf } from './helpers'

const parse = (input: unknown) => workflowDefinitionSchema.parse(input)
const diagnostics = (input: unknown) => validateDefinition(input).diagnostics
const codes = (input: unknown) => diagnostics(input).map((d) => d.code)

const loop = (name: string, runner: object, extra: object = {}) => ({
  name,
  type: 'loop',
  config: { input: '{{ [1, 2, 3] }}', runner, ...extra },
})
const callFn = (name: string, fn: string, params?: object) => ({
  name,
  type: 'function',
  config: { function: fn, ...(params && { params }) },
})
const fnDef = (
  name: string,
  blocks: object[],
  edges: [string, string, string?][] = [],
  extra: object = {},
) => {
  const { schemaVersion: _, ...graph } = wf(blocks, edges, extra)
  return { name, ...graph }
}
const withFunctions = (blocks: object[], edges: [string, string, string?][], functions: object[]) =>
  wf(blocks, edges, { functions })

describe('M5 block schemas', () => {
  it('parses every new block type', () => {
    const def = parse(
      wf(
        [
          start,
          loop(
            'each',
            { kind: 'code', code: 'return value * 2' },
            { mode: 'batch', batchSize: 5, batchDelayMs: 100 },
          ),
          callFn('lookup', 'getCustomer', { id: '{{ startTrigger.data.id }}' }),
          {
            name: 'child',
            type: 'workflow',
            config: { workflow: 'send-mail', input: '{"to": 1}', mode: 'async' },
          },
          { name: 'pause', type: 'wait', config: { kind: 'duration', amount: '5', unit: 'minutes' } },
          { name: 'until', type: 'wait', config: { kind: 'until', until: '2026-12-01T09:00:00Z' } },
          { name: 'onFailure', type: 'errorTrigger' },
        ],
        [],
        {
          functions: [
            {
              name: 'getCustomer',
              params: [{ name: 'id', testValue: 1 }],
              blocks: [code('lookup', 'return params.id')],
              edges: [],
            },
          ],
        },
      ),
    )
    expect(def.blocks.map((b) => b.type)).toEqual([
      'startTrigger',
      'loop',
      'function',
      'workflow',
      'wait',
      'wait',
      'errorTrigger',
    ])
    expect(def.functions?.[0]?.params?.[0]).toEqual({ name: 'id', testValue: 1 })
  })

  it('keeps retries off the loop itself and gives a wait only `finally`', () => {
    const bad = (block: object) => workflowDefinitionSchema.safeParse(wf([start, block])).success
    expect(bad(loop('l', { kind: 'code', code: '' }, {}))).toBe(true)
    expect(bad({ ...loop('l', { kind: 'code', code: '' }), settings: { retry: { count: 1 } } })).toBe(false)
    expect(
      bad({ ...loop('l', { kind: 'code', code: '' }), settings: { timeoutMs: 1000, finally: 'continue' } }),
    ).toBe(true)
    const wait = { name: 'w', type: 'wait', config: { kind: 'duration', amount: '1', unit: 'seconds' } }
    expect(bad({ ...wait, settings: { finally: 'continue' } })).toBe(true)
    expect(bad({ ...wait, settings: { timeoutMs: 1000 } })).toBe(false)
    expect(bad({ name: 'e', type: 'errorTrigger', settings: {} })).toBe(false)
    expect(bad(loop('l', { kind: 'workflow', workflow: 'Bad Slug' }))).toBe(false)
  })

  it('gives long-running blocks longer default timeouts and loops their own iteration settings', () => {
    const def = parse(
      wf([
        start,
        loop('l', { kind: 'code', code: '' }, { iteration: { timeoutMs: 2000, retry: { count: 2 } } }),
        callFn('f', 'x'),
        { name: 'c', type: 'workflow', config: { workflow: 'child' } },
        code('plain'),
      ]),
    )
    const [, l, f, c, plain] = def.blocks
    expect(resolveBlockSettings(l!).timeoutMs).toBe(6 * 60 * 60_000)
    expect(resolveBlockSettings(f!).timeoutMs).toBe(15 * 60_000)
    expect(resolveBlockSettings(c!).timeoutMs).toBe(15 * 60_000)
    expect(resolveBlockSettings(plain!).timeoutMs).toBe(10_000)
    expect(resolveIterationSettings(l as never)).toMatchObject({
      timeoutMs: 2000,
      retry: { count: 2, intervalMs: 1000 },
    })
  })

  it('knows which blocks suspend the run and which have an error output', () => {
    const def = parse(
      wf([
        start,
        { name: 'w', type: 'wait', config: { kind: 'duration', amount: '1', unit: 'seconds' } },
        { name: 'sync', type: 'workflow', config: { workflow: 'child' } },
        { name: 'async', type: 'workflow', config: { workflow: 'child', mode: 'async' } },
        loop('l', { kind: 'workflow', workflow: 'child' }, {}),
        { ...loop('l2', { kind: 'code', code: '' }), settings: { finally: 'continue' } },
        { name: 'e', type: 'errorTrigger' },
      ]),
    )
    expect(def.blocks.filter(suspends).map((b) => b.name)).toEqual(['w', 'sync', 'l'])
    expect(blockPorts(def.blocks[5]!)).toEqual(['out', 'error'])
    expect(blockPorts(def.blocks[6]!)).toEqual(['out'])
  })
})

describe('validating M5 blocks', () => {
  it('accepts a workflow using every new block with no diagnostics', () => {
    const result = validateDefinition(
      withFunctions(
        [
          start,
          sql('customers', 'select id from customers'),
          loop('each', {
            kind: 'function',
            function: 'enrich',
            params: { id: '{{ value.id }}', position: '{{ index }}' },
          }),
          code('total', 'const extra = await enrich({ id: 0 })\nreturn each.data.length + extra'),
          {
            name: 'pause',
            type: 'wait',
            config: { kind: 'duration', amount: '{{ total.data }}', unit: 'seconds' },
          },
          {
            name: 'notify',
            type: 'workflow',
            config: { workflow: 'notify', input: '{"n": {{ total.data }}}' },
          },
          { name: 'onFailure', type: 'errorTrigger' },
          code(
            'report',
            'return { failed: onFailure.data.block, input: startTrigger.data, rows: customers.data }',
          ),
          { name: 'reply', type: 'response', config: { status: '500', body: '{{ report.data }}' } },
        ],
        [
          ['startTrigger', 'customers'],
          ['customers', 'each'],
          ['each', 'total'],
          ['total', 'pause'],
          ['pause', 'notify'],
          ['onFailure', 'report'],
          ['report', 'reply'],
        ],
        [
          fnDef(
            'enrich',
            [
              sql('load', 'select * from orders where customer_id = {{ params.id }}'),
              code('shape', 'return load.data'),
            ],
            [['load', 'shape']],
            { params: [{ name: 'id' }, { name: 'position' }] },
          ),
        ],
      ),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  describe('loops', () => {
    it('gives the runner value and index, and nothing else', () => {
      expect(
        codes(
          wf([start, loop('l', { kind: 'code', code: 'return value + index' })], [['startTrigger', 'l']]),
        ),
      ).toEqual([])
      expect(
        codes(
          wf(
            [
              start,
              loop('l', { kind: 'query', resource: 'warehouse', query: { sql: 'select {{ value }}' } }),
            ],
            [['startTrigger', 'l']],
          ),
        ),
      ).toEqual([])
      // The input is evaluated before any item exists.
      const d = diagnostics(
        wf(
          [
            start,
            {
              ...loop('l', { kind: 'code', code: '' }),
              config: { input: '{{ value }}', runner: { kind: 'code', code: '' } },
            },
          ],
          [['startTrigger', 'l']],
        ),
      )
      expect(d).toEqual([
        expect.objectContaining({ code: 'unknown_identifier', path: ['blocks', 1, 'config', 'input'] }),
      ])
    })

    it('checks a loop runner reads only upstream blocks', () => {
      const d = diagnostics(
        wf(
          [start, code('later'), loop('l', { kind: 'code', code: 'return later.data' })],
          [
            ['startTrigger', 'l'],
            ['l', 'later'],
          ],
        ),
      )
      expect(d).toEqual([
        expect.objectContaining({
          code: 'not_ancestor',
          path: ['blocks', 2, 'config', 'runner', 'code'],
          block: 'l',
        }),
      ])
    })
  })

  describe('functions', () => {
    const fn = (blocks: object[], edges: [string, string, string?][] = [], extra: object = {}) =>
      fnDef('helper', blocks, edges, { params: [{ name: 'id' }], ...extra })
    const using = (...functions: object[]) => withFunctions([start], [], functions)

    it('lets function blocks read params and each other, starting from every root', () => {
      const result = validateDefinition(
        using(
          fn(
            [code('a', 'return params.id'), code('b', 'return 2'), code('sum', 'return a.data + b.data')],
            [
              ['a', 'sum'],
              ['b', 'sum'],
            ],
          ),
        ),
      )
      expect(result.diagnostics).toEqual([])
    })

    it("keeps a function's blocks apart from the workflow's", () => {
      const d = diagnostics(
        withFunctions(
          [start, code('outer')],
          [['startTrigger', 'outer']],
          [fn([code('a', 'return outer.data')])],
        ),
      )
      expect(d).toEqual([
        expect.objectContaining({
          code: 'unknown_identifier',
          function: 'helper',
          block: 'a',
          path: ['functions', 0, 'blocks', 0, 'config', 'code'],
        }),
      ])
      expect(codes(wf([start, code('a', 'return params.id')], [['startTrigger', 'a']]))).toEqual([
        'unknown_identifier',
      ])
    })

    it('allows block names in a function that the workflow also uses', () => {
      expect(codes(withFunctions([start, code('a')], [['startTrigger', 'a']], [fn([code('a')])]))).toEqual([])
    })

    it('needs a block to return', () => {
      expect(diagnostics(using(fn([])))).toEqual([
        expect.objectContaining({
          code: 'function_return',
          message: '"helper" has no blocks yet',
          path: ['functions', 0],
        }),
      ])
      expect(diagnostics(using(fn([code('a'), code('b')])))).toEqual([
        expect.objectContaining({
          code: 'function_return',
          message: 'Choose the block whose result "helper" returns',
        }),
      ])
      expect(diagnostics(using(fn([code('a'), code('b')], [], { returns: 'c' })))).toEqual([
        expect.objectContaining({ code: 'function_return', path: ['functions', 0, 'returns'] }),
      ])
      expect(codes(using(fn([code('a'), code('b')], [], { returns: 'b' })))).toEqual([])
      expect(functionReturnBlock(parse(using(fn([code('a'), code('b')], [['a', 'b']]))).functions![0]!)).toBe(
        'b',
      )
    })

    it("refuses blocks a function can't run", () => {
      const d = diagnostics(
        using(
          fn(
            [
              start,
              { name: 'onError', type: 'errorTrigger' },
              { name: 'reply', type: 'response', config: {} },
              { name: 'pause', type: 'wait', config: { kind: 'duration', amount: '1', unit: 'seconds' } },
              { name: 'child', type: 'workflow', config: { workflow: 'child' } },
              loop('many', { kind: 'workflow', workflow: 'child' }),
              { name: 'fire', type: 'workflow', config: { workflow: 'child', mode: 'async' } },
              loop('fireMany', { kind: 'workflow', workflow: 'child', mode: 'async' }),
            ],
            [],
            { returns: 'fire' },
          ),
        ),
      ).filter((x) => x.code === 'not_in_function')
      expect(d.map((x) => x.block)).toEqual(['startTrigger', 'onError', 'reply', 'pause', 'child', 'many'])
    })

    it('checks Function blocks and runners name a function and its parameters', () => {
      const d = diagnostics(
        withFunctions(
          [
            start,
            callFn('a', 'missing'),
            callFn('b', 'helper', { id: '1', other: '2' }),
            loop('c', { kind: 'function', function: 'nope' }),
          ],
          [
            ['startTrigger', 'a'],
            ['startTrigger', 'b'],
            ['startTrigger', 'c'],
          ],
          [fn([code('x')])],
        ),
      )
      expect(d.map((x) => [x.code, x.path.join('.')])).toEqual([
        ['unknown_function', 'blocks.1.config.function'],
        ['unknown_param', 'blocks.2.config.params.other'],
        ['unknown_function', 'blocks.3.config.runner.function'],
      ])
    })

    it('lets code call functions with await, and nothing else', () => {
      const ok = withFunctions(
        [
          start,
          code('a', 'return await helper({ id: 1 })'),
          loop('l', { kind: 'code', code: 'return helper({ id: value })' }),
        ],
        [
          ['startTrigger', 'a'],
          ['startTrigger', 'l'],
        ],
        [fn([code('x')])],
      )
      expect(codes(ok)).toEqual([])
      const d = diagnostics(
        withFunctions(
          [start, { name: 'b', type: 'branch', config: { conditions: [{ id: 'c', expression: 'helper' }] } }],
          [['startTrigger', 'b']],
          [fn([code('x')])],
        ),
      )
      expect(d).toEqual([expect.objectContaining({ code: 'function_call', block: 'b' })])
    })

    it('allows fetch in code only', () => {
      const ok = wf(
        [
          start,
          code('a', 'const res = await fetch("https://api.test")\nreturn res.json()'),
          loop('l', { kind: 'code', code: 'return fetch(value)' }),
        ],
        [
          ['startTrigger', 'a'],
          ['startTrigger', 'l'],
        ],
      )
      expect(codes(ok)).toEqual([])
      const d = diagnostics(
        wf(
          [start, { name: 'r', type: 'response', config: { body: '{{ fetch("https://api.test") }}' } }],
          [['startTrigger', 'r']],
        ),
      )
      expect(d).toEqual([
        expect.objectContaining({
          code: 'function_call',
          message: 'fetch can only be used in code, as await fetch(...)',
        }),
      ])
      expect(codes(wf([start, code('fetch')], [['startTrigger', 'fetch']]))).toEqual(['invalid_name'])
    })

    it('refuses functions that call themselves, directly or in a circle', () => {
      const self = diagnostics(using(fn([code('x', 'return await helper({})')])))
      expect(self).toEqual([
        expect.objectContaining({
          code: 'recursive_function',
          message: '"helper" calls itself',
          function: 'helper',
        }),
      ])
      const circle = diagnostics(
        using(
          fnDef('a', [callFn('callB', 'b')]),
          fnDef('b', [loop('callC', { kind: 'function', function: 'c' })]),
          fnDef('c', [code('x', 'return a()')]),
        ),
      )
      expect(circle).toEqual([
        expect.objectContaining({
          code: 'recursive_function',
          message: "Functions can't call each other in a circle: a → b → c → a",
        }),
      ])
    })

    it('keeps function, block and parameter names apart', () => {
      expect(codes(using(fn([code('x')]), fn([code('y')])))).toEqual(['duplicate_name'])
      expect(
        diagnostics(withFunctions([start, code('helper')], [['startTrigger', 'helper']], [fn([code('x')])])),
      ).toEqual([
        expect.objectContaining({
          code: 'duplicate_name',
          message: 'A function is already named "helper"',
          block: 'helper',
        }),
      ])
      expect(codes(using(fn([code('x')], [], { params: [{ name: 'id' }, { name: 'id' }] })))).toEqual([
        'duplicate_param',
      ])
      expect(codes(using(fnDef('dayjs', [code('x')])))).toEqual(['invalid_name'])
      expect(codes(wf([start, code('params')], [['startTrigger', 'params']]))).toEqual(['invalid_name'])
    })
  })

  describe('the error handler', () => {
    const handler = { name: 'onFailure', type: 'errorTrigger' }

    it("runs its own path, which isn't unreachable and may read the main path", () => {
      const result = validateDefinition(
        wf(
          [start, code('a'), handler, code('h', 'return [onFailure.data, a.error, startTrigger.data]')],
          [
            ['startTrigger', 'a'],
            ['onFailure', 'h'],
          ],
        ),
      )
      expect(result.diagnostics).toEqual([])
    })

    it("doesn't let the main path read the handler", () => {
      const d = diagnostics(
        wf(
          [start, code('a', 'return h.data'), handler, code('h')],
          [
            ['startTrigger', 'a'],
            ['onFailure', 'h'],
          ],
        ),
      )
      expect(d).toEqual([expect.objectContaining({ code: 'not_ancestor', block: 'a' })])
    })

    it('allows one handler that nothing connects into, apart from the main path', () => {
      expect(codes(wf([start, handler, { ...handler, name: 'second' }]))).toEqual(['error_trigger'])
      expect(diagnostics(wf([start, handler], [['startTrigger', 'onFailure']]))).toEqual([
        expect.objectContaining({
          code: 'edge_into_start',
          message: 'Nothing can connect into the error handler',
        }),
      ])
      const overlap = diagnostics(
        wf(
          [start, handler, code('shared')],
          [
            ['startTrigger', 'shared'],
            ['onFailure', 'shared'],
          ],
        ),
      )
      expect(overlap).toEqual([expect.objectContaining({ code: 'handler_overlap', block: 'shared' })])
    })
  })

  describe('waits', () => {
    const wait = (config: object) => wf([start, { name: 'w', type: 'wait', config }], [['startTrigger', 'w']])

    it('checks constant durations and times now, and templates when the block runs', () => {
      expect(codes(wait({ kind: 'duration', amount: '60', unit: 'days' }))).toEqual([])
      expect(
        codes(wait({ kind: 'duration', amount: '{{ startTrigger.data.delay }}', unit: 'days' })),
      ).toEqual([])
      expect(codes(wait({ kind: 'until', until: '{{ startTrigger.data.at }}' }))).toEqual([])
      expect(codes(wait({ kind: 'until', until: '2026-11-01T08:00:00+01:00' }))).toEqual([])
      const message = (config: object) => diagnostics(wait(config)).map((d) => d.message)
      expect(message({ kind: 'duration', amount: ' ', unit: 'minutes' })).toEqual(['Enter how long to wait'])
      expect(message({ kind: 'duration', amount: '-1', unit: 'minutes' })).toEqual([
        '"-1" isn\'t a number of minutes',
      ])
      expect(message({ kind: 'duration', amount: '61', unit: 'days' })).toEqual([
        'A wait can last at most 60 days',
      ])
      expect(message({ kind: 'until', until: '' })).toEqual(['Enter when to resume'])
      expect(message({ kind: 'until', until: 'next tuesday' })).toEqual([
        '"next tuesday" isn\'t a date and time',
      ])
    })
  })

  it('checks queries in loop runners and functions against their connectors', () => {
    const connector: QueryValidator = {
      querySchema: z.strictObject({ sql: z.string() }),
      validateQuery: () => [],
    }
    const result = validateDefinition(
      withFunctions(
        [start, loop('l', { kind: 'query', resource: 'missing', query: { sql: 'select 1' } })],
        [['startTrigger', 'l']],
        [
          fnDef('f', [
            { name: 'q', type: 'resourceQuery', config: { resource: 'warehouse', query: { text: 'x' } } },
          ]),
        ],
      ),
      { resolveResource: (slug) => (slug === 'warehouse' ? connector : undefined) },
    )
    expect(result.diagnostics.map((d) => [d.code, d.path.join('.'), d.function])).toEqual([
      ['unknown_resource', 'blocks.1.config.runner.resource', undefined],
      ['invalid_query', 'functions.0.blocks.0.config.query.sql', 'f'],
      ['invalid_query', 'functions.0.blocks.0.config.query', 'f'],
    ])
  })
})

describe('child workflows', () => {
  it('checks every called workflow exists and is published, when the server can tell', () => {
    const def = withFunctions(
      [
        start,
        { name: 'a', type: 'workflow', config: { workflow: 'ready' } },
        { name: 'b', type: 'workflow', config: { workflow: 'draft-only' } },
        loop('c', { kind: 'workflow', workflow: 'gone' }),
      ],
      [
        ['startTrigger', 'a'],
        ['startTrigger', 'b'],
        ['startTrigger', 'c'],
      ],
      [fnDef('f', [{ name: 'w', type: 'workflow', config: { workflow: 'gone', mode: 'async' } }])],
    )
    expect(codes(def)).toEqual([])
    const states: Record<string, 'published' | 'unpublished'> = {
      ready: 'published',
      'draft-only': 'unpublished',
    }
    const d = validateDefinition(def, { resolveWorkflow: (slug) => states[slug] }).diagnostics
    expect(d.map((x) => [x.code, x.path.join('.'), x.function])).toEqual([
      ['unpublished_workflow', 'blocks.2.config.workflow', undefined],
      ['unknown_workflow', 'blocks.3.config.runner.workflow', undefined],
      ['unknown_workflow', 'functions.0.blocks.0.config.workflow', 'f'],
    ])
  })
})

describe('AI agents’ tools (M35)', () => {
  it('counts them as called workflows, checked like Workflow blocks', () => {
    const def = withFunctions(
      [
        start,
        {
          name: 'a',
          type: 'resourceQuery',
          config: { resource: 'claude', query: { action: 'agent', prompt: 'x', tools: 'ready, draft-only' } },
        },
        loop('l', {
          kind: 'query',
          resource: 'claude',
          query: { action: 'agent', prompt: 'x', tools: ['gone', 'ready'] },
        }),
        {
          name: 'g',
          type: 'resourceQuery',
          config: { resource: 'claude', query: { action: 'generate', prompt: 'x', tools: 'ignored' } },
        },
      ],
      [
        ['startTrigger', 'a'],
        ['startTrigger', 'l'],
        ['startTrigger', 'g'],
      ],
      [],
    )
    expect(calledWorkflows(parse(def)).sort()).toEqual(['draft-only', 'gone', 'ready'])
    const states: Record<string, 'published' | 'unpublished'> = {
      ready: 'published',
      'draft-only': 'unpublished',
    }
    const d = validateDefinition(def, { resolveWorkflow: (slug) => states[slug] }).diagnostics
    expect(d.map((x) => [x.code, x.path.join('.')])).toEqual([
      ['unpublished_workflow', 'blocks.1.config.query.tools'],
      ['unknown_workflow', 'blocks.2.config.runner.query.tools'],
    ])
  })
})

describe('walking a definition', () => {
  it('finds every resource and child workflow, functions included', () => {
    const def = parse(
      withFunctions(
        [
          start,
          sql('a', 'select 1', 'main_db'),
          loop('l', { kind: 'query', resource: 'loop_db', query: { sql: '' } }),
          { name: 'w', type: 'workflow', config: { workflow: 'child-a' } },
          loop('lw', { kind: 'workflow', workflow: 'child-b' }),
        ],
        [],
        [
          fnDef('f', [
            sql('q', 'select 1', 'fn_db'),
            { name: 'w', type: 'workflow', config: { workflow: 'child-c', mode: 'async' } },
          ]),
        ],
      ),
    )
    expect(queriedResources(def).sort()).toEqual(['fn_db', 'loop_db', 'main_db'])
    expect(calledWorkflows(def).sort()).toEqual(['child-a', 'child-b', 'child-c'])
  })
})

describe('renaming with functions', () => {
  const def = (): WorkflowDefinition =>
    parse(
      withFunctions(
        [
          start,
          code('load', 'return await enrich({ id: 1 })'),
          callFn('call', 'enrich', { id: '{{ load.data }}' }),
          loop('each', { kind: 'function', function: 'enrich', params: { id: '{{ value }}' } }),
          { name: 'reply', type: 'response', config: { body: '{"enrich": "{{ load.data }}"}' } },
        ],
        [
          ['startTrigger', 'load'],
          ['load', 'call'],
          ['call', 'each'],
          ['each', 'reply'],
        ],
        [
          {
            ...fnDef(
              'enrich',
              [code('load', 'return params.id'), code('shape', 'return load.data')],
              [['load', 'shape']],
              {
                params: [{ name: 'id' }],
                returns: 'shape',
              },
            ),
            layout: { blocks: { load: { x: 1, y: 2 } } },
          },
          fnDef('outer', [code('go', 'return enrich({ id: 2 })')]),
        ],
      ),
    )

  it('renames a block inside a function only, with its edges, layout and return', () => {
    const result = renameBlock(def(), 'shape', 'result', { function: 'enrich' })
    if (!result.ok) throw new Error(result.error)
    const fn = result.definition.functions![0]!
    expect(fn.blocks.map((b) => b.name)).toEqual(['load', 'result'])
    expect(fn.returns).toBe('result')

    const load = renameBlock(def(), 'load', 'fetched', { function: 'enrich' })
    if (!load.ok) throw new Error(load.error)
    const inner = load.definition.functions![0]!
    expect(inner.edges).toEqual([{ from: 'fetched', port: 'out', to: 'shape' }])
    expect(inner.blocks[1]).toMatchObject({ config: { code: 'return fetched.data' } })
    expect(inner.layout).toEqual({ blocks: { fetched: { x: 1, y: 2 } } })
    // The workflow's own `load` block is untouched.
    expect(load.definition.blocks[1]!.name).toBe('load')
    expect(load.changed).toEqual([{ block: 'shape', path: ['config', 'code'] }])
  })

  it("refuses a block name that's a function's", () => {
    expect(renameBlock(def(), 'load', 'outer')).toEqual({
      ok: false,
      error: 'A function is already named "outer"',
    })
    expect(renameBlock(def(), 'load', 'x', { function: 'nope' })).toEqual({
      ok: false,
      error: 'No function is named "nope"',
    })
  })

  it('renames a function and every call to it', () => {
    const result = renameFunction(def(), 'enrich', 'lookup')
    if (!result.ok) throw new Error(result.error)
    const d = result.definition
    expect(d.functions!.map((f) => f.name)).toEqual(['lookup', 'outer'])
    expect(d.blocks[1]).toMatchObject({ config: { code: 'return await lookup({ id: 1 })' } })
    expect(d.blocks[2]).toMatchObject({ config: { function: 'lookup' } })
    expect(d.blocks[3]).toMatchObject({ config: { runner: { function: 'lookup' } } })
    expect(d.functions![1]!.blocks[0]).toMatchObject({ config: { code: 'return lookup({ id: 2 })' } })
    // Strings mentioning the name stay as they are.
    expect(d.blocks[4]).toMatchObject({ config: { body: '{"enrich": "{{ load.data }}"}' } })
    expect(result.changed.map((c) => c.block).sort()).toEqual(['call', 'each', 'load', 'outer.go'])
    expect(validateDefinition(d).diagnostics).toEqual([])
  })

  it("refuses a function name that's taken or that a local would capture", () => {
    expect(renameFunction(def(), 'enrich', 'outer')).toEqual({
      ok: false,
      error: 'Another function is already named "outer"',
    })
    expect(renameFunction(def(), 'enrich', 'load')).toEqual({
      ok: false,
      error: 'A block is already named "load"',
    })
    const captured = parse(
      withFunctions(
        [start, code('a', 'const fetchIt = 1\nreturn enrich({ id: fetchIt })')],
        [['startTrigger', 'a']],
        [fnDef('enrich', [code('x')])],
      ),
    )
    expect(renameFunction(captured, 'enrich', 'fetchIt')).toEqual({
      ok: false,
      error: '"fetchIt" is already a variable in block "a"; pick another name',
    })
  })
})

describe('canonical form with functions', () => {
  it('sorts functions and their graphs, and ignores their layout in the hash', async () => {
    const one = parse(
      withFunctions([start], [], [fnDef('b', [code('y'), code('x')], [['y', 'x']]), fnDef('a', [code('z')])]),
    )
    const canonical = canonicalize(one)
    expect(canonical.functions!.map((f) => f.name)).toEqual(['a', 'b'])
    expect(canonical.functions![1]!.blocks.map((b) => b.name)).toEqual(['x', 'y'])

    const moved = structuredClone(one)
    moved.functions![0]!.layout = { blocks: { x: { x: 5, y: 5 } } }
    expect(await definitionHash(moved)).toBe(await definitionHash(one))
    const changed = structuredClone(one)
    changed.functions![1]!.blocks[0] = { name: 'z', type: 'code', config: { code: 'return 2' } }
    expect(await definitionHash(changed)).not.toBe(await definitionHash(one))
  })
})
