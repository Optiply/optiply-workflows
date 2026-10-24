import { describe, expect, it } from 'vitest'
import {
  checkLibraryReference,
  type LibraryInfo,
  libraryQueryDefinitionSchema,
  libraryScope,
  usedLibraries,
  validateDefinition,
  workflowDefinitionSchema,
} from '../src'
import { code, start, wf } from './helpers'

const library = (name: string, config: object) => ({ name, type: 'libraryQuery', config })
const loop = (name: string, runner: object) => ({
  name,
  type: 'loop',
  config: { input: '{{ [1, 2, 3] }}', runner },
})

const LIBRARIES: Record<string, LibraryInfo> = {
  customers: { liveVersion: '1.1.0', versions: { '1.0.0': ['id'], '1.1.0': ['id', 'region'] } },
  drafts: { liveVersion: null, versions: {} },
  secret: { liveVersion: null, versions: {}, noUse: true },
}
const resolveLibrary = (slug: string) => LIBRARIES[slug]

describe('Library query blocks (M21)', () => {
  it('parses the block and the loop runner, and refuses a version that is neither latest nor semver', () => {
    const def = wf(
      [
        start,
        library('library1', { library: 'customers', version: 'latest', params: { id: '{{ 1 }}' } }),
        loop('loop1', {
          kind: 'library',
          library: 'customers',
          version: '1.0.0',
          params: { id: '{{ value }}' },
        }),
      ],
      [
        ['startTrigger', 'library1'],
        ['library1', 'loop1'],
      ],
    )
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true)
    const bad = wf(
      [start, library('library1', { library: 'customers', version: '1.0' })],
      [['startTrigger', 'library1']],
    )
    expect(workflowDefinitionSchema.safeParse(bad).success).toBe(false)
  })

  it("checks the parameters' templates like any block's: ancestors only, value and index in a runner", () => {
    const def = wf(
      [
        start,
        code('code1'),
        library('library1', {
          library: 'customers',
          version: 'latest',
          params: { id: '{{ code1 + later1 }}' },
        }),
        loop('loop1', {
          kind: 'library',
          library: 'customers',
          version: 'latest',
          params: { id: '{{ value + index }}' },
        }),
        code('later1'),
      ],
      [
        ['startTrigger', 'code1'],
        ['code1', 'library1'],
        ['library1', 'loop1'],
        ['loop1', 'later1'],
      ],
    )
    const d = validateDefinition(def).diagnostics
    expect(d.map((x) => [x.code, x.block, x.path.join('.')])).toEqual([
      ['not_ancestor', 'library1', 'blocks.2.config.params.id'],
    ])
  })

  it('checks each use against the library with resolveLibrary, functions included', () => {
    const def = wf(
      [
        start,
        library('a', {
          library: 'customers',
          version: 'latest',
          params: { id: '{{ 1 }}', region: "{{ 'eu' }}" },
        }),
        library('b', {
          library: 'customers',
          version: '1.0.0',
          params: { id: '{{ 1 }}', region: "{{ 'eu' }}" },
        }),
        library('c', { library: 'customers', version: '2.0.0' }),
        library('d', { library: 'drafts', version: 'latest' }),
        library('e', { library: 'secret', version: 'latest' }),
        loop('f', { kind: 'library', library: 'gone', version: 'latest' }),
        library('g', { library: 'customers', version: '1.0.0' }),
      ],
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((to) => ['startTrigger', to] as [string, string]),
      {
        functions: [
          {
            name: 'fn',
            blocks: [library('h', { library: 'gone', version: 'latest' })],
            edges: [],
          },
        ],
      },
    )
    expect(validateDefinition(def).ok).toBe(true)
    const d = validateDefinition(def, { resolveLibrary }).diagnostics
    expect(d.map((x) => [x.severity, x.code, x.block, x.path.join('.'), x.function])).toEqual([
      ['error', 'unknown_param', 'b', 'blocks.2.config.params.region', undefined],
      ['error', 'unknown_version', 'c', 'blocks.3.config.version', undefined],
      ['error', 'unpublished_library', 'd', 'blocks.4.config.version', undefined],
      ['error', 'no_use_access', 'e', 'blocks.5.config.library', undefined],
      ['error', 'unknown_library', 'f', 'blocks.6.config.runner.library', undefined],
      ['warning', 'missing_param', 'g', 'blocks.7.config.params', undefined],
      ['error', 'unknown_library', 'h', 'functions.0.blocks.0.config.library', 'fn'],
    ])
    expect(d.find((x) => x.code === 'no_use_access')?.message).toBe(
      'You need use access to library query "secret"',
    )
  })

  it('lists the library queries a workflow uses', () => {
    const def = workflowDefinitionSchema.parse(
      wf(
        [
          start,
          library('a', { library: 'customers', version: 'latest' }),
          loop('b', { kind: 'library', library: 'orders', version: '1.0.0' }),
        ],
        [
          ['startTrigger', 'a'],
          ['startTrigger', 'b'],
        ],
        {
          functions: [
            { name: 'fn', blocks: [library('c', { library: 'customers', version: '1.0.0' })], edges: [] },
          ],
        },
      ),
    )
    expect(usedLibraries(def).sort()).toEqual(['customers', 'orders'])
  })
})

describe('library queries in @ow/definition (M21)', () => {
  const def = libraryQueryDefinitionSchema.parse({
    schemaVersion: 1,
    resource: 'warehouse',
    query: { sql: 'select {{ id }}' },
    params: [{ name: 'id' }, { name: 'region' }],
  })

  it('gives the parameters and current_user, null for a run nobody started', () => {
    expect(libraryScope(def, { id: 7, other: 1 }, null)).toEqual({ id: 7, region: null, current_user: null })
    const user = { id: 'u1', email: 'a@b.c', name: 'A' }
    expect(libraryScope(def, {}, user)).toEqual({ id: null, region: null, current_user: user })
  })

  it('checks a reference on its own, with paths relative to it', () => {
    expect(checkLibraryReference({ library: 'customers', version: 'latest' }, resolveLibrary)).toEqual([
      { severity: 'warning', code: 'missing_param', message: expect.any(String), path: ['params'] },
      { severity: 'warning', code: 'missing_param', message: expect.any(String), path: ['params'] },
    ])
  })
})
