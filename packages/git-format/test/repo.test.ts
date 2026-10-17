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
