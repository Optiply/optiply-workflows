import { describe, expect, it } from 'vitest'
import {
  decodeRepo,
  encodeObject,
  type Files,
  MANIFEST_FILE,
  manifestFile,
  objectDir,
  type RepoObject,
  splitRepo,
} from '../src'

const workflow: RepoObject = {
  kind: 'workflow',
  slug: 'sync-orders',
  value: {
    name: 'Sync orders',
    description: null,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'step', type: 'code', config: { code: 'return 1' } },
      ],
      edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
    },
  },
}

const app: RepoObject = {
  kind: 'app',
  slug: 'order-admin',
  value: {
    name: 'Order admin',
    description: 'Orders',
    definition: { schemaVersion: 1, components: [], queries: [{ name: 'q', kind: 'js', code: 'return 1' }] },
  },
}

const repo = (): Files => ({
  [MANIFEST_FILE]: manifestFile(),
  'README.md': '# Our workflows\n',
  '.github/workflows/ci.yml': 'on: push\n',
  ...encodeObject(workflow).files,
  ...encodeObject(app).files,
})

describe('the repo', () => {
  it('puts each object under its kind and slug', () => {
    expect(objectDir('workflow', 'sync-orders')).toBe('workflows/sync-orders')
    expect(Object.keys(encodeObject(workflow).files)).toEqual([
      'workflows/sync-orders/blocks/step.js',
      'workflows/sync-orders/workflow.json',
    ])
    expect(manifestFile()).toBe('{\n  "format": 1\n}\n')
  })

  it('decodes every object, ignoring files outside workflows/ and apps/', () => {
    const decoded = decodeRepo(repo())
    expect(decoded.problems).toEqual([])
    expect(decoded.objects).toEqual([
      { kind: 'app', slug: 'order-admin', result: { ok: true, value: app } },
      { kind: 'workflow', slug: 'sync-orders', result: { ok: true, value: workflow } },
    ])
  })

  it('keeps one broken object from hiding the others, with paths from the root', () => {
    const files = repo()
    delete files['workflows/sync-orders/blocks/step.js']
    const decoded = decodeRepo(files)
    expect(decoded.objects[0]!.result.ok).toBe(true)
    expect(decoded.objects[1]!.result).toEqual({
      ok: false,
      problems: [
        {
          path: 'workflows/sync-orders/blocks/step.js',
          code: 'missing_file',
          message:
            'workflows/sync-orders/blocks/step.js is missing: the code block step keeps its code there',
        },
      ],
    })
  })

  it('reports stray files, bad slugs and the manifest', () => {
    const files = repo()
    files['workflows/notes.txt'] = 'x'
    files['apps/Bad Slug/app.json'] = '{}'
    files['apps/Bad Slug/layout.json'] = '{}'
    delete files[MANIFEST_FILE]
    expect(decodeRepo(files).problems.map((p) => [p.path, p.code])).toEqual([
      [MANIFEST_FILE, 'unsupported_format'],
      ['workflows/notes.txt', 'unexpected_file'],
      ['apps/Bad Slug', 'invalid_slug'],
    ])
    expect(decodeRepo({ ...files, [MANIFEST_FILE]: '{"format": 2}' }).problems[0]).toMatchObject({
      code: 'unsupported_format',
      message: expect.stringContaining('format 2'),
    })
  })

  it('groups files by directory', () => {
    const { objects } = splitRepo(repo())
    expect(objects.map((o) => [o.kind, o.slug, Object.keys(o.files)])).toEqual([
      ['app', 'order-admin', ['app.json', 'queries/q.js']],
      ['workflow', 'sync-orders', ['blocks/step.js', 'workflow.json']],
    ])
  })
})

const libraryQuery: RepoObject = {
  kind: 'library_query',
  slug: 'orders_by_customer',
  value: {
    name: 'Orders by customer',
    description: null,
    definition: {
      schemaVersion: 1,
      resource: 'shop',
      query: { sql: 'select * from orders\nwhere customer = {{ id }}' },
      params: [{ name: 'id', testValue: 1 }],
    },
  },
}

const picker: RepoObject = {
  kind: 'module',
  slug: 'customer-picker',
  value: {
    name: 'Customer picker',
    description: null,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'title', type: 'text', props: { value: '{{ inputs.label }}' } }],
      queries: [
        { name: 'find', kind: 'resource', resource: 'shop', query: { sql: 'select 1' }, run: 'auto' },
      ],
      layout: { title: { x: 0, y: 0, w: 6, h: 2 } },
      module: {
        inputs: [{ name: 'label', default: 'Customers' }],
        outputs: [],
        events: [{ name: 'picked' }],
      },
    },
  },
}

describe('library queries and modules (M14)', () => {
  it('have directories of their own: library/<slug>/ and modules/<slug>/', () => {
    expect(Object.keys(encodeObject(libraryQuery).files)).toEqual([
      'library/orders_by_customer/query.json',
      'library/orders_by_customer/query.sql',
    ])
    expect(encodeObject(libraryQuery).files['library/orders_by_customer/query.sql']).toBe(
      'select * from orders\nwhere customer = {{ id }}\n',
    )
    expect(Object.keys(encodeObject(picker).files)).toEqual([
      'modules/customer-picker/layout.json',
      'modules/customer-picker/module.json',
      'modules/customer-picker/queries/find.sql',
    ])
  })

  it('decode with the rest of the repo, in kind order', () => {
    const files = { ...repo(), ...encodeObject(libraryQuery).files, ...encodeObject(picker).files }
    const decoded = decodeRepo(files)
    expect(decoded.problems).toEqual([])
    expect(decoded.objects.map((o) => [o.kind, o.slug, o.result.ok])).toEqual([
      ['app', 'order-admin', true],
      ['library_query', 'orders_by_customer', true],
      ['module', 'customer-picker', true],
      ['workflow', 'sync-orders', true],
    ])
    expect(decoded.objects[1]!.result).toEqual({ ok: true, value: libraryQuery })
    expect(decoded.objects[2]!.result).toEqual({ ok: true, value: picker })
  })

  it('report their own problems: a stray file, a module without its interface, a bad slug', () => {
    const files = { ...repo(), ...encodeObject(libraryQuery).files, ...encodeObject(picker).files }
    files['library/orders_by_customer/notes.md'] = 'x'
    const module = JSON.parse(files['modules/customer-picker/module.json']!)
    delete module.module
    files['modules/customer-picker/module.json'] = JSON.stringify(module)
    files['library/Bad/query.json'] = '{}'
    const decoded = decodeRepo(files)
    expect(decoded.problems.map((p) => [p.path, p.message])).toEqual([
      [
        'library/Bad',
        'library/Bad: "Bad" isn\'t a valid library query slug (2–63 lowercase letters, digits, - or _, starting with a letter)',
      ],
    ])
    const problems = (slug: string) => {
      const result = decoded.objects.find((o) => o.slug === slug)!.result
      return result.ok ? [] : result.problems.map((p) => [p.path, p.code])
    }
    expect(problems('orders_by_customer')).toEqual([
      ['library/orders_by_customer/notes.md', 'unexpected_file'],
    ])
    expect(problems('customer-picker')).toEqual([
      ['modules/customer-picker/module.json', 'invalid_definition'],
    ])
  })
})
