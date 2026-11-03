import { canonicalJson, type WorkflowDefinition, workflowDefinitionSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import {
  decodeWorkflow,
  encodeWorkflow,
  type Files,
  LAYOUT_FILE,
  REQUIREMENTS_FILE,
  WORKFLOW_FILE,
  type WorkflowObject,
  workflowForGit,
} from '../src'

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  triggers: { webhook: { enabled: true, alias: 'orders/:id' } },
  blocks: [
    { name: 'transform', type: 'code', config: { code: 'return fetchOrders.data.map((r) => r.id)\n' } },
    { name: 'startTrigger', type: 'startTrigger' },
    {
      name: 'fetchOrders',
      type: 'resourceQuery',
      config: {
        resource: 'shop',
        query: { sql: 'select * from orders\nwhere id = {{ startTrigger.data.id }}' },
      },
    },
    {
      name: 'callApi',
      type: 'resourceQuery',
      config: { resource: 'crm', query: { method: 'GET', path: '/x' } },
    },
    {
      name: 'each',
      type: 'loop',
      config: { input: '{{ transform.data }}', runner: { kind: 'code', code: 'return value * 2' } },
    },
    {
      name: 'isBig',
      type: 'branch',
      config: { conditions: [{ id: 'a', expression: 'transform.data.length > 10' }] },
    },
  ],
  edges: [
    { from: 'startTrigger', port: 'out', to: 'fetchOrders' },
    { from: 'fetchOrders', port: 'out', to: 'transform' },
  ],
  functions: [
    {
      name: 'notify',
      params: [{ name: 'text' }],
      blocks: [{ name: 'send', type: 'code', config: { code: 'console.log(params.text)' } }],
      edges: [],
      layout: { blocks: { send: { x: 1, y: 2 } } },
    },
  ],
  layout: { blocks: { startTrigger: { x: 0, y: 0 }, fetchOrders: { x: 0, y: 100 } } },
}

const workflow = { name: 'Sync orders', description: 'Nightly', definition }

describe('encodeWorkflow', () => {
  const { files, warnings } = encodeWorkflow(workflow)

  it('moves code and SQL into files named after their blocks', () => {
    expect(Object.keys(files)).toEqual([
      'blocks/each.js',
      'blocks/fetchOrders.sql',
      'blocks/transform.js',
      'functions/notify/blocks/send.js',
      LAYOUT_FILE,
      WORKFLOW_FILE,
    ])
    expect(files['blocks/fetchOrders.sql']).toBe(
      'select * from orders\nwhere id = {{ startTrigger.data.id }}\n',
    )
    // The value's own trailing newline is kept: the file gets one more.
    expect(files['blocks/transform.js']).toBe('return fetchOrders.data.map((r) => r.id)\n\n')
    expect(warnings).toEqual([])
  })

  it('keeps the rest in canonical JSON, with the name and description, and no layout', () => {
    const json = JSON.parse(files[WORKFLOW_FILE]!)
    expect(json.name).toBe('Sync orders')
    expect(json.description).toBe('Nightly')
    expect(json.layout).toBeUndefined()
    expect(json.functions[0].layout).toBeUndefined()
    expect(json.blocks.map((b: { name: string }) => b.name)).toEqual([
      'callApi',
      'each',
      'fetchOrders',
      'isBig',
      'startTrigger',
      'transform',
    ])
    const byName = Object.fromEntries(json.blocks.map((b: { name: string }) => [b.name, b]))
    expect(byName.transform.config).toEqual({})
    expect(byName.fetchOrders.config).toEqual({ resource: 'shop', query: {} })
    expect(byName.callApi.config.query).toEqual({ method: 'GET', path: '/x' })
    expect(byName.each.config.runner).toEqual({ kind: 'code' })
    expect(byName.isBig.config.conditions[0].expression).toBe('transform.data.length > 10')
    expect(files[WORKFLOW_FILE]).toBe(canonicalJson(json, { pretty: true }))
  })

  it('puts the canvas and the functions’ canvases in layout.json', () => {
    expect(JSON.parse(files[LAYOUT_FILE]!)).toEqual({
      blocks: definition.layout!.blocks,
      functions: { notify: { blocks: { send: { x: 1, y: 2 } } } },
    })
  })

  it('leaves out an empty description and layout', () => {
    const bare = encodeWorkflow({
      name: 'Bare',
      description: null,
      definition: {
        schemaVersion: 1,
        blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
        edges: [],
        layout: {},
      },
    })
    expect(Object.keys(bare.files)).toEqual([WORKFLOW_FILE])
    expect(JSON.parse(bare.files[WORKFLOW_FILE]!)).toEqual({
      name: 'Bare',
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
      edges: [],
    })
  })

  it('warns about names that differ only in case', () => {
    const { warnings } = encodeWorkflow({
      ...workflow,
      definition: {
        ...definition,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'Step', type: 'code', config: { code: '' } },
          { name: 'step', type: 'code', config: { code: '' } },
        ],
        edges: [],
        functions: [],
      },
    })
    expect(warnings).toEqual([
      { path: 'blocks/step.js', message: expect.stringContaining('differ only in case') },
    ])
  })
})

describe('decodeWorkflow', () => {
  const { files } = encodeWorkflow(workflow)

  it('reads the files back into the same canonical workflow', () => {
    const decoded = decodeWorkflow(files)
    expect(decoded).toEqual({
      ok: true,
      value: { name: 'Sync orders', description: 'Nightly', definition: workflowForGit(definition) },
    })
  })

  const problems = (changed: Files) => {
    const decoded = decodeWorkflow(changed)
    if (decoded.ok) throw new Error('expected problems')
    return decoded.problems.map((p) => [p.path, p.code])
  }

  it('reports a missing code file', () => {
    const { 'blocks/transform.js': _gone, ...rest } = files
    expect(problems(rest)).toEqual([['blocks/transform.js', 'missing_file']])
  })

  it('reads a missing SQL file as no SQL (the schema allows it)', () => {
    const { 'blocks/fetchOrders.sql': _gone, ...rest } = files
    const decoded = decodeWorkflow(rest)
    expect(decoded.ok && decoded.value.definition.blocks.find((b) => b.name === 'fetchOrders')).toEqual({
      name: 'fetchOrders',
      type: 'resourceQuery',
      config: { resource: 'shop', query: {} },
    })
  })

  it('reports files nothing uses', () => {
    expect(
      problems({ ...files, 'blocks/gone.js': 'x', 'README.md': '# hi', 'blocks/isBig.js': 'x' }),
    ).toEqual([
      ['README.md', 'unexpected_file'],
      ['blocks/gone.js', 'unexpected_file'],
      ['blocks/isBig.js', 'unexpected_file'],
    ])
  })

  it('accepts code written inline, and refuses it twice', () => {
    const json = JSON.parse(files[WORKFLOW_FILE]!)
    json.blocks.find((b: { name: string }) => b.name === 'transform').config.code = 'return 1'
    const { 'blocks/transform.js': _gone, ...rest } = files
    const inline = decodeWorkflow({ ...rest, [WORKFLOW_FILE]: JSON.stringify(json) })
    expect(inline.ok && inline.value.definition.blocks.find((b) => b.name === 'transform')).toMatchObject({
      config: { code: 'return 1' },
    })
    expect(problems({ ...files, [WORKFLOW_FILE]: JSON.stringify(json) })).toEqual([
      ['blocks/transform.js', 'duplicate_value'],
    ])
  })

  it('reports JSON that does not parse, and a missing workflow.json', () => {
    expect(problems({ ...files, [WORKFLOW_FILE]: '{ nope' })).toEqual([[WORKFLOW_FILE, 'invalid_json']])
    expect(problems({ ...files, [LAYOUT_FILE]: '[' })).toEqual([[LAYOUT_FILE, 'invalid_json']])
    const { [WORKFLOW_FILE]: _gone, ...rest } = files
    expect(problems(rest)).toEqual([[WORKFLOW_FILE, 'missing_file']])
  })

  it('reports schema problems with the path inside the file', () => {
    const json = JSON.parse(files[WORKFLOW_FILE]!)
    json.blocks[0].type = 'teleport'
    delete json.name
    const decoded = decodeWorkflow({ ...files, [WORKFLOW_FILE]: JSON.stringify(json) })
    expect(decoded.ok).toBe(false)
    const messages = decoded.ok ? [] : decoded.problems.map((p) => p.message)
    expect(messages).toEqual([
      expect.stringMatching(/^workflow\.json: name: /),
      expect.stringMatching(/^workflow\.json: blocks\[0\]\.type: /),
    ])
  })

  it('reports layout problems in layout.json', () => {
    const bad = { blocks: { startTrigger: { x: 'left', y: 0 } }, functions: { missing: {} } }
    expect(problems({ ...files, [LAYOUT_FILE]: JSON.stringify(bad) })).toEqual([
      [LAYOUT_FILE, 'invalid_definition'],
      [LAYOUT_FILE, 'invalid_definition'],
    ])
  })
})

describe('Python packages', () => {
  const withPackages = (settings: object): WorkflowObject => ({
    name: 'Packages',
    description: null,
    definition: workflowDefinitionSchema.parse({
      schemaVersion: 1,
      settings,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
      edges: [],
    }),
  })

  it('go into requirements.txt, out of the JSON, and read back', () => {
    const workflow = withPackages({
      timeoutMs: 60_000,
      python: { requirements: ['polars==1.9.0', 'openpyxl>=3.1'] },
    })
    const { files } = encodeWorkflow(workflow)
    expect(files[REQUIREMENTS_FILE]).toBe('polars==1.9.0\nopenpyxl>=3.1\n')
    expect(files[WORKFLOW_FILE]).not.toContain('polars')
    expect(JSON.parse(files[WORKFLOW_FILE]!).settings).toEqual({ timeoutMs: 60_000 })
    const decoded = decodeWorkflow(files)
    expect(decoded.ok && decoded.value.definition).toEqual(workflowForGit(workflow.definition))
  })

  it('leaves settings out when the packages were all there was, and keeps no file when there are none', () => {
    const only = encodeWorkflow(withPackages({ python: { requirements: ['polars'] } })).files
    expect(JSON.parse(only[WORKFLOW_FILE]!)).not.toHaveProperty('settings')
    const decoded = decodeWorkflow(only)
    expect(decoded.ok && decoded.value.definition.settings).toEqual({ python: { requirements: ['polars'] } })
    const none = encodeWorkflow(withPackages({ python: { requirements: [] } })).files
    expect(none).not.toHaveProperty(REQUIREMENTS_FILE)
  })

  it('reads a file edited by hand: blank lines and comments left out, the rest for the validator', () => {
    const { files } = encodeWorkflow(withPackages({}))
    const decoded = decodeWorkflow({
      ...files,
      [REQUIREMENTS_FILE]: '# data work\r\npolars==1.9.0\n\n  openpyxl  \n-e git+https://x\n',
    })
    expect(decoded.ok && decoded.value.definition.settings).toEqual({
      python: { requirements: ['polars==1.9.0', 'openpyxl', '-e git+https://x'] },
    })
    const empty = decodeWorkflow({ ...files, [REQUIREMENTS_FILE]: '# nothing yet\n' })
    expect(empty.ok && empty.value.definition.settings?.python).toBeUndefined()
  })

  it('refuses packages in the JSON as well as the file', () => {
    const { files } = encodeWorkflow(withPackages({}))
    const json = JSON.parse(files[WORKFLOW_FILE]!)
    const decoded = decodeWorkflow({
      ...files,
      [WORKFLOW_FILE]: JSON.stringify({ ...json, settings: { python: { requirements: ['a'] } } }),
      [REQUIREMENTS_FILE]: 'b\n',
    })
    expect(decoded.ok ? [] : decoded.problems.map((p) => [p.path, p.message])).toEqual([
      [WORKFLOW_FILE, 'workflow.json: settings.python: the packages belong in requirements.txt'],
    ])
  })
})

describe('Python code', () => {
  const python: WorkflowObject = {
    name: 'Python',
    description: null,
    definition: workflowDefinitionSchema.parse({
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'shape', type: 'code', config: { code: 'return startTrigger.data\n', language: 'python' } },
        {
          name: 'each',
          type: 'loop',
          config: { input: '{{ [1] }}', runner: { kind: 'code', code: 'return value', language: 'python' } },
        },
        { name: 'js', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [],
    }),
  }

  it('goes into .py files (JavaScript stays .js), and reads back', () => {
    const { files } = encodeWorkflow(python)
    expect(Object.keys(files).sort()).toEqual([
      'blocks/each.py',
      'blocks/js.js',
      'blocks/shape.py',
      'workflow.json',
    ])
    expect(files['blocks/shape.py']).toBe('return startTrigger.data\n\n')
    expect(files['workflow.json']).toContain('"language": "python"')
    const decoded = decodeWorkflow(files)
    expect(decoded.ok && decoded.value.definition).toEqual(workflowForGit(python.definition))
  })

  it('reports a Python block whose code is in a .js file', () => {
    const { files } = encodeWorkflow(python)
    const { 'blocks/shape.py': code, ...rest } = files
    const decoded = decodeWorkflow({ ...rest, 'blocks/shape.js': code! })
    expect(decoded.ok ? [] : decoded.problems.map((p) => [p.path, p.code])).toEqual([
      ['blocks/shape.py', 'missing_file'],
      ['blocks/shape.js', 'unexpected_file'],
    ])
  })
})

describe('GraphQL queries and email HTML (M27)', () => {
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: 1,
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      {
        name: 'orders',
        type: 'resourceQuery',
        config: {
          resource: 'shop_gql',
          query: { query: 'query($id: ID!) {\n  order(id: $id) { id }\n}', variables: '{"id": 1}' },
        },
      },
      {
        name: 'mail',
        type: 'resourceQuery',
        config: {
          resource: 'sendgrid',
          query: { action: 'send', to: 'a@example.com', html: '<p>Hi {{ name }}</p>\n' },
        },
      },
      {
        name: 'find',
        type: 'resourceQuery',
        config: { resource: 'crm', query: { action: 'search', objectType: 'contacts', query: 'acme' } },
      },
    ],
    edges: [],
  })
  const object = { name: 'Mixed', description: null, definition }

  it('go into .graphql and .html files; a service query’s own `query` stays in the JSON', () => {
    const { files } = encodeWorkflow(object)
    expect(files['blocks/orders.graphql']).toBe('query($id: ID!) {\n  order(id: $id) { id }\n}\n')
    // Text files end in one newline more than the value: reading strips it.
    expect(files['blocks/mail.html']).toBe('<p>Hi {{ name }}</p>\n\n')
    expect(Object.keys(files).filter((f) => f.startsWith('blocks/find'))).toEqual([])
    expect(files['workflow.json']).toContain('"query": "acme"')
    expect(files['workflow.json']).not.toContain('order(id')
  })

  it('read back into the same workflow', () => {
    expect(decodeWorkflow(encodeWorkflow(object).files)).toEqual({
      ok: true,
      value: { name: 'Mixed', description: null, definition: workflowForGit(definition) },
    })
  })
})
