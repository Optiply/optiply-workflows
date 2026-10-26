import { describe, expect, it } from 'vitest'
import {
  decodeRepo,
  encodeObject,
  encodeSettingsDir,
  type Files,
  MANIFEST_FILE,
  manifestFile,
  objectDir,
  type RepoObject,
  type SettingsObject,
  splitRepo,
  workflowForGit,
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

const resource: SettingsObject = {
  kind: 'resource',
  slug: 'orders_db',
  value: {
    name: 'Orders DB',
    description: null,
    type: 'postgres',
    environments: {
      production: {
        config: { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'require' } },
      },
      staging: { config: { host: 'db.staging', port: 5432, database: 'orders' } },
    },
  },
}
const apiBase: SettingsObject = {
  kind: 'config_var',
  slug: 'API_BASE',
  value: {
    description: 'Where the API is',
    secret: false,
    values: { production: 'https://api.example.com/' },
  },
}
const token: SettingsObject = {
  kind: 'config_var',
  slug: 'TOKEN',
  value: { description: null, secret: true, values: {} },
}

const withSettings = (): Files => {
  const files = repo()
  for (const object of [resource, apiBase, token]) {
    const { dir, files: inside } = encodeSettingsDir(object)
    for (const [path, content] of Object.entries(inside)) files[`${dir}/${path}`] = content
  }
  return files
}

describe('resources and config vars (M22)', () => {
  it('have directories of their own: resources/<slug>/resource.json and config-vars/<NAME>/config-var.json', () => {
    const files = withSettings()
    expect(
      Object.keys(files).filter((p) => p.startsWith('resources/') || p.startsWith('config-vars/')),
    ).toEqual([
      'resources/orders_db/resource.json',
      'config-vars/API_BASE/config-var.json',
      'config-vars/TOKEN/config-var.json',
    ])
    expect(JSON.parse(files['config-vars/TOKEN/config-var.json']!)).toEqual({ secret: true })
    expect(JSON.parse(files['resources/orders_db/resource.json']!)).toEqual({
      name: 'Orders DB',
      type: 'postgres',
      environments: resource.value.environments,
    })
  })

  it('decode apart from the objects, which stay as they were', () => {
    const decoded = decodeRepo(withSettings())
    expect(decoded.problems).toEqual([])
    expect(decoded.objects.map((o) => o.kind)).toEqual(['app', 'workflow'])
    expect(decoded.settings.map((o) => [o.kind, o.slug])).toEqual([
      ['config_var', 'API_BASE'],
      ['config_var', 'TOKEN'],
      ['resource', 'orders_db'],
    ])
    for (const { result } of decoded.settings) expect(result.ok).toBe(true)
    const db = decoded.settings.find((o) => o.slug === 'orders_db')!.result
    expect(db.ok && db.value).toEqual(resource)
    expect(splitRepo(withSettings()).objects.map((o) => o.slug)).toEqual(['order-admin', 'sync-orders'])
  })

  it('report their own problems: names, stray files, secret values, unknown keys, a missing file', () => {
    const files = withSettings()
    files['resources/orders-db/resource.json'] = '{}'
    files['config-vars/1ST/config-var.json'] = '{}'
    files['config-vars/stray.json'] = '{}'
    files['resources/orders_db/notes.md'] = 'x'
    files['config-vars/TOKEN/config-var.json'] = JSON.stringify({
      secret: true,
      values: { production: 'hunter2' },
    })
    files['config-vars/API_BASE/config-var.json'] = JSON.stringify({ secret: false, password: 'x' })
    files['resources/empty/README.md'] = 'x'
    const decoded = decodeRepo(files)
    expect(decoded.problems.map((p) => [p.path, p.code])).toEqual([
      ['resources/orders-db', 'invalid_slug'],
      ['config-vars/1ST', 'invalid_slug'],
      ['config-vars/stray.json', 'unexpected_file'],
    ])
    expect(decoded.problems[0]!.message).toContain("isn't a valid resource slug")
    expect(decoded.problems[1]!.message).toContain("isn't a valid config var name")
    expect(decoded.problems[2]!.message).toContain('config-vars/<NAME>/')
    const problems = (slug: string) => {
      const result = decoded.settings.find((o) => o.slug === slug)!.result
      return result.ok ? [] : result.problems.map((p) => [p.path, p.code, p.message])
    }
    expect(problems('orders_db')).toEqual([
      [
        'resources/orders_db/notes.md',
        'unexpected_file',
        "resources/orders_db/notes.md doesn't belong in this directory",
      ],
    ])
    expect(problems('TOKEN')).toEqual([
      [
        'config-vars/TOKEN/config-var.json',
        'invalid_definition',
        "config-vars/TOKEN/config-var.json: values: a secret config var's values stay on each instance, not in Git",
      ],
    ])
    expect(problems('API_BASE').map(([, code]) => code)).toEqual(['invalid_definition'])
    expect(problems('empty').map(([path, code]) => [path, code])).toEqual([
      ['resources/empty/resource.json', 'missing_file'],
      ['resources/empty/README.md', 'unexpected_file'],
    ])
  })

  it('refuse a config without a type, an environment that is not a slug, and a secrets key', () => {
    const files = withSettings()
    files['resources/orders_db/resource.json'] = JSON.stringify({
      name: 'Orders DB',
      environments: { Production: { config: {} } },
      secrets: { password: 'x' },
    })
    const result = decodeRepo(files).settings.find((o) => o.slug === 'orders_db')!.result
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const messages = result.problems.map((p) => p.message).join('\n')
      expect(messages).toContain('type')
      expect(messages).toContain('Production')
      expect(messages).toContain('secrets')
    }
  })
})

describe('folders (M22)', () => {
  it('sit beside the name, are left out at the top level, and leave the definition alone', () => {
    const inFolder: RepoObject = { ...workflow, value: { ...workflow.value, folder: 'Finance/Reports' } }
    const json = JSON.parse(encodeObject(inFolder).files['workflows/sync-orders/workflow.json']!)
    expect(json.folder).toBe('Finance/Reports')
    expect('folder' in JSON.parse(encodeObject(workflow).files['workflows/sync-orders/workflow.json']!)).toBe(
      false,
    )
    const decoded = decodeRepo({ [MANIFEST_FILE]: manifestFile(), ...encodeObject(inFolder).files })
    const result = decoded.objects[0]!.result
    expect(result.ok && result.value.value).toEqual({
      ...inFolder.value,
      definition: workflowForGit(workflow.value.definition as never),
    })
  })

  it('refuse empty names, spaces at either end and long names, naming the folder', () => {
    for (const bad of [
      '',
      'Finance/',
      '/Finance',
      'a//b',
      ' Finance',
      'Finance /Reports',
      'x'.repeat(81),
      3,
    ]) {
      const files: Files = { [MANIFEST_FILE]: manifestFile(), ...encodeObject(app).files }
      const json = JSON.parse(files['apps/order-admin/app.json']!)
      files['apps/order-admin/app.json'] = JSON.stringify({ ...json, folder: bad })
      const result = decodeRepo(files).objects[0]!.result
      expect(result.ok, JSON.stringify(bad)).toBe(false)
      if (!result.ok) expect(result.problems.map((p) => p.message).join()).toContain('folder')
    }
  })
})
