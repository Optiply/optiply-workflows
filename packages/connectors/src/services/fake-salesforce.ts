import type { Handler } from './fake'

// A fake of Salesforce for tests (M29): the client credentials token endpoint, SOQL of the form
// SELECT f, … FROM Obj [WHERE F = literal [AND …]] [LIMIT n] over stored records, three records a page through
// nextRecordsUrl, sObjects CRUD and upsert by an external id, describe, parameterized search, errors as arrays.

export interface FakeSalesforce {
  clientId: string
  clientSecret: string
  /** Access tokens issued (one per token request). */
  tokens: Set<string>
  records: Map<string, Map<string, Record<string, unknown>>>
  /** Every SOQL query received, as sent. */
  queries: string[]
}

/** A SOQL literal back into a value (the fake's side of `soqlLiteral`). */
function literal(text: string): unknown {
  const t = text.trim()
  if (t.startsWith("'")) {
    return t
      .slice(1, -1)
      .replace(/\\(.)/g, (_, ch: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[ch] ?? ch)
  }
  if (t === 'null') return null
  if (t === 'true' || t === 'false') return t === 'true'
  return Number(t)
}

export function fakeSalesforce(): { state: FakeSalesforce; handler: Handler } {
  const state: FakeSalesforce = {
    clientId: 'sf-client',
    clientSecret: 'sf-secret',
    tokens: new Set(),
    records: new Map(),
    queries: [],
  }
  const pages = new Map<string, Record<string, unknown>[]>()
  let seq = 0
  const fail = (status: number, errorCode: string, message: string, fields: string[] = []) => ({
    status,
    json: [{ message, errorCode, fields }],
  })
  const objects = (name: string) => {
    let m = state.records.get(name)
    if (!m) {
      m = new Map()
      state.records.set(name, m)
    }
    return m
  }
  const withAttributes = (type: string, r: Record<string, unknown>) => ({
    attributes: { type, url: `/services/data/v62.0/sobjects/${type}/${r.Id}` },
    ...r,
  })
  const page = (rows: Record<string, unknown>[], cursor = 0) => {
    const next = cursor + 3
    const more = next < rows.length
    const id = `01g${++seq}`
    if (more) pages.set(id, rows)
    return {
      status: 200,
      json: {
        totalSize: rows.length,
        done: !more,
        records: rows.slice(cursor, next),
        ...(more && { nextRecordsUrl: `/services/data/v62.0/query/${id}-${next}` }),
      },
    }
  }

  const handler: Handler = async (req, url, raw) => {
    const path = url.pathname.replace(/^\/salesforce/, '')
    if (path === '/services/oauth2/token' && req.method === 'POST') {
      const form = new URLSearchParams(raw.toString())
      if (form.get('grant_type') !== 'client_credentials')
        return {
          status: 400,
          json: { error: 'unsupported_grant_type', error_description: 'grant type not supported' },
        }
      if (form.get('client_id') !== state.clientId || form.get('client_secret') !== state.clientSecret)
        return {
          status: 400,
          json: { error: 'invalid_client', error_description: 'invalid client credentials' },
        }
      const token = `00D!fake.${++seq}`
      state.tokens.add(token)
      return {
        status: 200,
        json: {
          access_token: token,
          instance_url: url.origin,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
        },
      }
    }
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!state.tokens.has(auth))
      return {
        status: 401,
        json: [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }],
      }
    const data = '/services/data/v62.0'
    if (!path.startsWith(data))
      return fail(404, 'NOT_FOUND', `The requested resource does not exist: ${path}`)
    const rest = path.slice(data.length)
    const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {}

    if (rest === '/' || rest === '')
      return { status: 200, json: { sobjects: `${data}/sobjects`, query: `${data}/query` } }
    if (rest === '/limits')
      return { status: 200, json: { DailyApiRequests: { Max: 15000, Remaining: 14990 } } }
    if (rest === '/query' || rest === '/queryAll') {
      const q = url.searchParams.get('q') ?? ''
      state.queries.push(q)
      const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/is.exec(q)
      if (!m) return fail(400, 'MALFORMED_QUERY', `unexpected token: ${q.slice(0, 40)}`)
      const fields = m[1]!.split(',').map((f) => f.trim())
      let rows = [...objects(m[2]!).values()]
      if (rest === '/query') rows = rows.filter((r) => !r.IsDeleted)
      if (m[3]) {
        for (const cond of m[3].split(/\s+AND\s+/i)) {
          const eq = /^(\w+)\s*=\s*(.+)$/s.exec(cond.trim())
          const inList = /^(\w+)\s+IN\s+\((.+)\)$/is.exec(cond.trim())
          if (eq) rows = rows.filter((r) => r[eq[1]!] === literal(eq[2]!))
          else if (inList) {
            const values = inList[2]!.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(literal)
            rows = rows.filter((r) => values.includes(r[inList[1]!]))
          } else return fail(400, 'MALFORMED_QUERY', `The fake can't read: ${cond}`)
        }
      }
      if (m[4]) rows = rows.slice(0, Number(m[4]))
      return page(
        rows.map((r) => withAttributes(m[2]!, Object.fromEntries(fields.map((f) => [f, r[f] ?? null])))),
      )
    }
    const more = /^\/query\/(01g\d+)-(\d+)$/.exec(rest)
    if (more) {
      const rows = pages.get(more[1]!)
      return rows ? page(rows, Number(more[2])) : fail(400, 'INVALID_QUERY_LOCATOR', 'invalid query locator')
    }
    if (rest === '/parameterizedSearch' && req.method === 'POST') {
      const term = String(body.q ?? '').toLowerCase()
      type Spec = { name: string; fields?: string[] }
      const specs: Spec[] =
        (body.sobjects as Spec[] | undefined) ?? [...state.records.keys()].map((name) => ({ name }))
      const found = specs.flatMap(({ name, fields }) =>
        [...objects(name).values()]
          .filter((r) =>
            Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(term)),
          )
          .map((r) =>
            withAttributes(
              name,
              fields ? Object.fromEntries(fields.map((f) => [f, r[f] ?? null])) : { Id: r.Id },
            ),
          ),
      )
      return { status: 200, json: { searchRecords: found.slice(0, Number(body.overallLimit ?? 2000)) } }
    }
    const s = /^\/sobjects\/(\w+)(?:\/([\w-]+))?(?:\/([^/]+))?$/.exec(rest)
    if (!s) return fail(404, 'NOT_FOUND', `The requested resource does not exist: ${rest}`)
    const [, type, second, third] = s
    const store = objects(type!)
    if (second === 'describe') {
      const keys = new Set<string>(['Id', 'Name'])
      for (const r of store.values()) for (const k of Object.keys(r)) keys.add(k)
      return {
        status: 200,
        json: {
          name: type,
          label: type,
          fields: [...keys].map((name) => ({
            name,
            label: name,
            type: name === 'Id' ? 'id' : 'string',
            nillable: name !== 'Name',
            defaultedOnCreate: name === 'Id',
            createable: name !== 'Id',
            updateable: name !== 'Id',
            picklistValues: [],
          })),
        },
      }
    }
    if (!second && req.method === 'POST') {
      if (!body.Name)
        return fail(400, 'REQUIRED_FIELD_MISSING', 'Required fields are missing: [Name]', ['Name'])
      const id = `001${String(++seq).padStart(15, '0')}`
      store.set(id, { Id: id, ...body })
      return { status: 201, json: { id, success: true, errors: [] } }
    }
    if (second && third !== undefined) {
      // Upsert by an external id field.
      const existing = [...store.values()].find((r) => String(r[second]) === decodeURIComponent(third))
      if (existing) {
        Object.assign(existing, body)
        return { status: 204 }
      }
      const id = `001${String(++seq).padStart(15, '0')}`
      store.set(id, { Id: id, [second]: decodeURIComponent(third), ...body })
      return { status: 201, json: { id, success: true, errors: [], created: true } }
    }
    const row = second ? store.get(second) : undefined
    if (!row) return fail(404, 'NOT_FOUND', 'The requested resource does not exist')
    if (req.method === 'GET') {
      const fields = url.searchParams.get('fields')?.split(',')
      return {
        status: 200,
        json: withAttributes(
          type!,
          fields ? Object.fromEntries(['Id', ...fields].map((f) => [f, row[f] ?? null])) : row,
        ),
      }
    }
    if (req.method === 'PATCH') {
      Object.assign(row, body)
      return { status: 204 }
    }
    if (req.method === 'DELETE') {
      row.IsDeleted = true
      return { status: 204 }
    }
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  return { state, handler }
}
