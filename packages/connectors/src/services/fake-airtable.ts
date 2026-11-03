import type { Handler } from './fake'

// A fake of Airtable's API for tests (M29): bases with tables (by name or id), records paged through `offset`, a
// formula of the form {Field} = 'value', writes of at most 10 records, upserts, the meta API, and a 429 on demand.

export interface FakeAirtableTable {
  id: string
  name: string
  fields: { id: string; name: string; type: string }[]
  records: Map<string, { id: string; createdTime: string; fields: Record<string, unknown> }>
}

export interface FakeAirtable {
  token: string
  bases: Map<string, FakeAirtableTable[]>
  /** The next data call answers 429 (Airtable's limit is 5 requests a second per base). */
  rateLimitOnce: boolean
}

export function fakeAirtable(token = 'pat_fake_token'): { state: FakeAirtable; handler: Handler } {
  const state: FakeAirtable = { token, bases: new Map(), rateLimitOnce: false }
  let seq = 0
  const fail = (status: number, type: string, message: string) => ({
    status,
    json: { error: { type, message } },
  })
  const tableOf = (base: string, name: string) =>
    state.bases.get(base)?.find((t) => t.id === name || t.name === name)
  const newRecord = (fields: Record<string, unknown>) => ({
    id: `rec${String(++seq).padStart(14, '0')}`,
    createdTime: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    fields,
  })

  const handler: Handler = async (req, url, raw) => {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (auth !== state.token) return fail(401, 'AUTHENTICATION_REQUIRED', 'Authentication required')
    const path = url.pathname.replace(/^\/airtable/, '')
    const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {}

    if (path === '/v0/meta/whoami')
      return {
        status: 200,
        json: {
          id: 'usrFAKE',
          email: 'ops@optiply.nl',
          scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
        },
      }
    const meta = /^\/v0\/meta\/bases\/(\w+)\/tables$/.exec(path)
    if (meta) {
      const tables = state.bases.get(meta[1]!)
      if (!tables) return fail(404, 'NOT_FOUND', 'Could not find base')
      return {
        status: 200,
        json: {
          tables: tables.map(({ records: _r, ...t }) => ({
            ...t,
            primaryFieldId: t.fields[0]?.id,
            views: [{ id: 'viwGrid', name: 'Grid view', type: 'grid' }],
          })),
        },
      }
    }
    if (state.rateLimitOnce) {
      state.rateLimitOnce = false
      return fail(429, 'RATE_LIMIT_REACHED', 'Rate limit exceeded')
    }
    const m = /^\/v0\/(\w+)\/([^/]+)(?:\/([^/]+))?$/.exec(path)
    if (!m) return fail(404, 'NOT_FOUND', 'Not found')
    const table = tableOf(m[1]!, decodeURIComponent(m[2]!))
    if (!table)
      return fail(
        404,
        'TABLE_NOT_FOUND',
        `Could not find table ${decodeURIComponent(m[2]!)} in application ${m[1]}`,
      )
    const sub = m[3] ? decodeURIComponent(m[3]) : undefined

    if (sub === 'listRecords' && req.method === 'POST') {
      let rows = [...table.records.values()]
      const formula = typeof body.filterByFormula === 'string' ? body.filterByFormula : ''
      if (formula) {
        const eq = /^\{([^}]+)\}\s*=\s*'([^']*)'$/.exec(formula)
        if (!eq) return fail(422, 'INVALID_FILTER_BY_FORMULA', 'The formula for filtering records is invalid')
        rows = rows.filter((r) => String(r.fields[eq[1]!] ?? '') === eq[2])
      }
      for (const s of ((body.sort as { field: string; direction?: string }[] | undefined) ?? [])
        .slice()
        .reverse()) {
        rows.sort((a, b) => {
          const x = String(a.fields[s.field] ?? '')
          const y = String(b.fields[s.field] ?? '')
          return (x < y ? -1 : x > y ? 1 : 0) * (s.direction === 'desc' ? -1 : 1)
        })
      }
      const fields = body.fields as string[] | undefined
      const start = Number(body.offset ?? 0)
      const size = Math.min(100, Number(body.pageSize ?? 100))
      const page = rows.slice(start, start + size).map((r) => ({
        ...r,
        fields: fields
          ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => fields.includes(k)))
          : r.fields,
      }))
      return {
        status: 200,
        json: { records: page, ...(start + size < rows.length && { offset: String(start + size) }) },
      }
    }
    if (sub && req.method === 'GET') {
      const record = table.records.get(sub)
      return record ? { status: 200, json: record } : fail(404, 'NOT_FOUND', 'Could not find record')
    }
    if (!sub && (req.method === 'POST' || req.method === 'PATCH')) {
      const records = (body.records as { id?: string; fields: Record<string, unknown> }[] | undefined) ?? []
      if (records.length > 10)
        return fail(
          422,
          'INVALID_RECORDS',
          'You are only allowed to send up to 10 records in a single request',
        )
      const known = new Set(table.fields.map((f) => f.name))
      for (const r of records)
        for (const k of Object.keys(r.fields))
          if (!known.has(k) && !body.typecast)
            return fail(422, 'UNKNOWN_FIELD_NAME', `Unknown field name: "${k}"`)
      if (req.method === 'POST') {
        const out = records.map((r) => {
          const rec = newRecord(r.fields)
          table.records.set(rec.id, rec)
          return rec
        })
        return { status: 200, json: { records: out } }
      }
      const upsert = body.performUpsert as { fieldsToMergeOn: string[] } | undefined
      const out = []
      const createdRecords: string[] = []
      const updatedRecords: string[] = []
      for (const r of records) {
        let rec = r.id ? table.records.get(r.id) : undefined
        if (upsert && !rec)
          rec = [...table.records.values()].find((x) =>
            upsert.fieldsToMergeOn.every((k) => x.fields[k] === r.fields[k]),
          )
        if (!rec && upsert) {
          rec = newRecord(r.fields)
          table.records.set(rec.id, rec)
          createdRecords.push(rec.id)
        } else if (!rec) return fail(404, 'NOT_FOUND', `Record ${r.id} not found`)
        else {
          Object.assign(rec.fields, r.fields)
          updatedRecords.push(rec.id)
        }
        out.push(rec)
      }
      return { status: 200, json: { records: out, ...(upsert && { createdRecords, updatedRecords }) } }
    }
    if (!sub && req.method === 'DELETE') {
      const ids = url.searchParams.getAll('records[]')
      if (ids.length > 10) return fail(422, 'INVALID_REQUEST', 'You can delete up to 10 records')
      return {
        status: 200,
        json: { records: ids.map((id) => ({ id, deleted: table.records.delete(id) })) },
      }
    }
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  return { state, handler }
}
