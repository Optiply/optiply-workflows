/** Python code blocks and loop runners in the definition (docs/architecture.md §2.14). */
import { describe, expect, it } from 'vitest'
import {
  calledFunctions,
  codeFields,
  definitionHash,
  referencedNames,
  renameBlock,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '../src'
import { code, sql, start, wf } from './helpers'

const python = (name: string, src: string) => ({
  name,
  type: 'code',
  config: { code: src, language: 'python' },
})
const py = (...lines: string[]) => lines.join('\n')
const parse = (input: unknown) => workflowDefinitionSchema.parse(input)
const diagnostics = (input: unknown) =>
  validateDefinition(input).diagnostics.map(({ severity, code, block, message }) => ({
    severity,
    code,
    block,
    message,
  }))

describe('Python code', () => {
  it('is a language on code blocks and code runners, stored only for Python', async () => {
    const def = parse(
      wf(
        [
          start,
          python('shape', 'return startTrigger.data'),
          {
            name: 'each',
            type: 'loop',
            config: {
              input: '{{ [1, 2] }}',
              runner: { kind: 'code', code: 'return value * 2', language: 'python' },
            },
          },
        ],
        [
          ['startTrigger', 'shape'],
          ['shape', 'each'],
        ],
      ),
    )
    expect(codeFields(def.blocks[1]!)).toEqual([
      { path: ['config', 'code'], kind: 'python-body', source: 'return startTrigger.data' },
    ])
    expect(codeFields(def.blocks[2]!)[1]).toMatchObject({ kind: 'python-body', locals: ['value', 'index'] })
    expect(validateDefinition(def).diagnostics).toEqual([])
    // JavaScript is the absence of a language: definitions from before M12 keep their hashes.
    expect(() =>
      parse(wf([start, { ...code('c'), config: { code: 'x', language: 'javascript' } }])),
    ).toThrow()
    expect(await definitionHash(parse(wf([start, code('c')])))).toBe(
      await definitionHash(
        parse(wf([start, { ...code('c'), config: { code: 'return 1', language: undefined } }])),
      ),
    )
  })

  it('reads the blocks it names, which must run before it', () => {
    const def = wf(
      [
        start,
        sql('orders', 'select 1'),
        python(
          'summary',
          py(
            'import pandas as pd',
            'df = pd.DataFrame(orders.data)',
            'later = 1  # a local named like nothing',
            'return {"n": len(df), "env": workflowContext.environment, "late": report.data}',
          ),
        ),
        code('report'),
      ],
      [
        ['startTrigger', 'orders'],
        ['orders', 'summary'],
        ['summary', 'report'],
      ],
    )
    expect(referencedNames(parse(def).blocks[2]!)).toEqual(new Set(['orders', 'workflowContext', 'report']))
    expect(diagnostics(def)).toEqual([
      {
        severity: 'error',
        code: 'not_ancestor',
        block: 'summary',
        message: '"report" doesn\'t run before "summary"',
      },
    ])
    expect(diagnostics(wf([start, python('me', 'return me.data')], [['startTrigger', 'me']]))).toEqual([
      { severity: 'error', code: 'self_reference', block: 'me', message: '"me" can\'t read its own result' },
    ])
  })

  it("leaves Python's own names to Python, but says a block named like a builtin can't be read", () => {
    const def = wf(
      [
        start,
        code('sum', 'return 1'),
        python('use', 'import json\nreturn json.dumps(sum([1, 2])) + undefinedThing'),
      ],
      [
        ['startTrigger', 'sum'],
        ['sum', 'use'],
      ],
    )
    expect(diagnostics(def)).toEqual([
      {
        severity: 'warning',
        code: 'python_builtin',
        block: 'use',
        message: 'In Python, "sum" is the builtin, not the block "sum"',
      },
    ])
  })

  it("can't call functions or fetch", () => {
    const def = wf([start, python('p', 'return fetch("https://x") or notify({})')], [['startTrigger', 'p']], {
      functions: [
        {
          name: 'notify',
          blocks: [{ name: 'send', type: 'code', config: { code: 'return params' } }],
          edges: [],
        },
      ],
    })
    expect(diagnostics(def).map((d) => [d.code, d.message])).toEqual([
      ['python_unsupported', "Python code can't use fetch: it has no network"],
      ['python_unsupported', 'Python code can\'t call the function "notify"'],
    ])
    expect(calledFunctions(parse(def).blocks[1]!, new Set(['notify']))).toEqual(new Set())
  })

  it("reads params in a function's Python blocks", () => {
    const def = wf([start], [], {
      functions: [
        {
          name: 'double',
          params: [{ name: 'n' }],
          blocks: [
            { name: 'calc', type: 'code', config: { code: 'return params.n * 2', language: 'python' } },
          ],
          edges: [],
        },
      ],
    })
    expect(validateDefinition(def).diagnostics).toEqual([])
  })

  it('warns about blocks named like Python keywords only in workflows with Python', () => {
    // JavaScript-only workflows keep such names (they worked before M12).
    expect(validateDefinition(wf([start, code('pass')], [['startTrigger', 'pass']])).diagnostics).toEqual([])
    expect(
      diagnostics(
        wf(
          [start, code('pass'), python('p', 'return 1')],
          [
            ['startTrigger', 'pass'],
            ['pass', 'p'],
          ],
        ),
      ),
    ).toEqual([
      {
        severity: 'warning',
        code: 'python_keyword',
        block: 'pass',
        message: '"pass" is a Python keyword: Python code can\'t read this block',
      },
    ])
  })

  it('warns when Python code assigns a block or a run global, hiding it', () => {
    const def = wf(
      [
        start,
        sql('rows', 'select 1'),
        python('p', 'rows = rows.data\nconfigVars = {}\nreturn rows'),
        {
          name: 'each',
          type: 'loop',
          config: {
            input: '{{ [1] }}',
            runner: { kind: 'code', code: 'value = value * 2\nreturn value', language: 'python' },
          },
        },
      ],
      [
        ['startTrigger', 'rows'],
        ['rows', 'p'],
        ['p', 'each'],
      ],
    )
    expect(diagnostics(def).map((d) => [d.code, d.block, d.message])).toEqual([
      [
        'python_shadowed',
        'p',
        '"rows" is assigned in this code, so in Python it\'s the code\'s own variable here',
      ],
      [
        'python_shadowed',
        'p',
        '"configVars" is assigned in this code, so in Python it\'s the code\'s own variable here',
      ],
      [
        'python_shadowed',
        'each',
        '"value" is assigned in this code, so in Python it\'s the code\'s own variable here',
      ],
    ])
  })
})

describe('renaming a block read from Python', () => {
  const def = (): WorkflowDefinition =>
    parse(
      wf(
        [
          start,
          sql('orders', 'select 1'),
          python(
            'summary',
            py(
              '# orders in a comment stays',
              'label = "orders"',
              'n = len(orders.data)',
              'out = pd.DataFrame(data=orders.data)',
              'return f"{n} {orders.data[0]} {label}"',
            ),
          ),
        ],
        [
          ['startTrigger', 'orders'],
          ['orders', 'summary'],
        ],
      ),
    )

  it('rewrites its references, f-strings included, and nothing else', () => {
    const result = renameBlock(def(), 'orders', 'customerOrders')
    if (!result.ok) throw new Error(result.error)
    const summary = result.definition.blocks[2]!
    expect(summary.type === 'code' && summary.config.code).toBe(
      py(
        '# orders in a comment stays',
        'label = "orders"',
        'n = len(customerOrders.data)',
        'out = pd.DataFrame(data=customerOrders.data)',
        'return f"{n} {customerOrders.data[0]} {label}"',
      ),
    )
    expect(result.changed).toEqual([{ block: 'summary', path: ['config', 'code'] }])
  })

  it("refuses a name the code binds, or a builtin's", () => {
    expect(renameBlock(def(), 'orders', 'label')).toEqual({
      ok: false,
      error: '"label" is already a variable in block "summary"; pick another name',
    })
    expect(renameBlock(def(), 'orders', 'len')).toMatchObject({ ok: false })
    // Not reserved any more, but Python reading the block can't follow it to a keyword.
    expect(renameBlock(def(), 'orders', 'pass')).toMatchObject({ ok: false })
  })

  it('leaves a local that shares its name alone', () => {
    const local = parse(
      wf(
        [start, sql('rows', 'select 1'), python('p', 'rows = [1, 2]\nreturn rows')],
        [
          ['startTrigger', 'rows'],
          ['rows', 'p'],
        ],
      ),
    )
    const result = renameBlock(local, 'rows', 'items')
    if (!result.ok) throw new Error(result.error)
    const p = result.definition.blocks[2]!
    expect(p.type === 'code' && p.config.code).toBe('rows = [1, 2]\nreturn rows')
  })
})
