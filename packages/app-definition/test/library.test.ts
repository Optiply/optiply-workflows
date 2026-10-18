import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  emptyLibraryQuery,
  type LibraryQueryDefinition,
  libraryQueryHash,
  libraryScope,
  validateLibraryQuery,
} from '../src'

const lib = (sql: string, params: string[] = [], extra: Partial<LibraryQueryDefinition> = {}) => ({
  schemaVersion: 1,
  resource: 'warehouse',
  query: { sql },
  params: params.map((name) => ({ name })),
  ...extra,
})

const codes = (input: unknown, options = {}) =>
  validateLibraryQuery(input, options).diagnostics.map((d) => [d.code, d.path.join('.'), d.severity])

describe('validateLibraryQuery', () => {
  it('accepts a query reading its parameters, current_user and the stdlib', () => {
    const def = lib(
      'select * from orders where customer_id = {{ customerId }} and owner = {{ current_user.email }} order by {{ sql.column(sort) }} limit {{ Math.min(limit, 100) }}',
      ['customerId', 'sort', 'limit'],
    )
    expect(validateLibraryQuery(def)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('starts empty and valid', () => {
    expect(validateLibraryQuery(emptyLibraryQuery()).ok).toBe(true)
  })

  it('refuses reading anything but its parameters', () => {
    const def = lib('select {{ table1.selectedRow.id }}, {{ customerId }}', ['customerId'])
    const result = validateLibraryQuery(def)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown_identifier',
        message: '"table1" is not a parameter',
        path: ['query', 'sql'],
        start: 10,
        end: 16,
      }),
    ])
  })

  it('checks parameter names and warns about unused ones', () => {
    expect(codes(lib('select {{ a }}', ['a', 'a', 'current_user', 'class', 'unused']))).toEqual([
      ['duplicate_name', 'params.1.name', 'error'],
      ['invalid_name', 'params.2.name', 'error'],
      ['invalid_name', 'params.3.name', 'error'],
      ['unused_param', 'params.4.name', 'warning'],
    ])
  })

  it('reports syntax errors in REST queries too', () => {
    const def = lib('', ['id'], {
      query: { method: 'GET', path: '/orders/{{ id }}', headers: { x: '{{ ( }}' } },
    })
    expect(codes(def)).toEqual([['syntax', 'query.headers.x', 'error']])
  })

  it('reports schema problems alone', () => {
    expect(codes({ ...lib('select 1'), resource: 'Not A Slug', extra: 1 }).map((c) => c[0])).toEqual([
      'schema',
      'schema',
    ])
  })

  it('checks the query against the connector when resources are known', () => {
    const connector = {
      querySchema: z.strictObject({ sql: z.string().min(1, 'Write a query') }),
      validateQuery: () => [],
    }
    const resolveResource = (slug: string) => (slug === 'warehouse' ? (connector as never) : undefined)
    expect(codes(lib('select 1'), { resolveResource })).toEqual([])
    expect(codes(lib(''), { resolveResource })).toEqual([['invalid_query', 'query.sql', 'error']])
    expect(codes({ ...lib('select 1'), resource: 'nope' }, { resolveResource })).toEqual([
      ['unknown_resource', 'resource', 'error'],
    ])
  })
})

describe('library queries at run time', () => {
  it('scopes declared parameters (null when missing) and current_user only', () => {
    const def = lib('select 1', ['a', 'b']) as LibraryQueryDefinition
    const user = { id: 'u', email: 'e@x', name: 'E' }
    expect(libraryScope(def, { a: 1, extra: 2, current_user: 'forged' }, user)).toEqual({
      a: 1,
      b: null,
      current_user: user,
    })
  })

  it('hashes canonically: key order is irrelevant, parameter order counts', async () => {
    const a = lib('select 1', ['x', 'y']) as LibraryQueryDefinition
    const b = {
      params: a.params,
      query: a.query,
      resource: a.resource,
      schemaVersion: 1,
    } as LibraryQueryDefinition
    expect(await libraryQueryHash(a)).toBe(await libraryQueryHash(b))
    expect(await libraryQueryHash({ ...a, params: [...a.params].reverse() })).not.toBe(
      await libraryQueryHash(a),
    )
  })
})
