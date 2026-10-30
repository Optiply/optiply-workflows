import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// Fakes of the services M27 connects to, on one HTTP server for tests: Slack's Web API under `/slack/api`, HubSpot's
// CRM under `/hubspot`, SendGrid under `/sendgrid`, Google Sheets under `/sheets/v4/spreadsheets` and Drive under
// `/drive`. Each checks its credential and keeps what it was sent.

export interface FakeServices {
  url: string
  /** Base URLs to give the server (`SLACK_API_URL` and so on). */
  urls: { slack: string; hubspot: string; sendgrid: string; sheets: string; drive: string }
  slack: FakeSlack
  hubspot: FakeHubSpot
  calls: {
    service: string
    method: string
    path: string
    body: unknown
    headers: IncomingMessage['headers']
  }[]
  stop(): Promise<void>
}

export interface FakeSlack {
  token: string
  /** OAuth tokens the fake also accepts (M9's connect flow, faked elsewhere). */
  acceptTokens: Set<string>
  channels: { id: string; name: string; is_archived: boolean; is_private: boolean }[]
  users: { id: string; name: string; profile: { email: string } }[]
  messages: { channel: string; ts: string; text?: string; blocks?: unknown; thread_ts?: string }[]
  files: { id: string; name: string; title: string; bytes: Buffer; channel?: string; comment?: string }[]
  /** The next call to this method answers 429 with this Retry-After. */
  rateLimit: Map<string, number>
}

export interface FakeHubSpotRecord {
  id: string
  properties: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface FakeHubSpot {
  token: string
  acceptTokens: Set<string>
  /** Records by object type, then id. */
  records: Map<string, Map<string, FakeHubSpotRecord>>
  associations: { fromType: string; fromId: string; toType: string; toId: string }[]
}

type Handler = (
  req: IncomingMessage,
  url: URL,
  body: Buffer,
) => Promise<{ status: number; json?: unknown; headers?: Record<string, string> }>

export async function startFakeServices(
  opts: { slackToken?: string; hubspotToken?: string } = {},
): Promise<FakeServices> {
  const calls: FakeServices['calls'] = []
  const slack: FakeSlack = {
    token: opts.slackToken ?? 'xoxb-fake-token',
    acceptTokens: new Set(),
    channels: Array.from({ length: 5 }, (_, i) => ({
      id: `C00${i + 1}`,
      name: i === 0 ? 'general' : `team-${i}`,
      is_archived: i === 4,
      is_private: false,
    })),
    users: [
      { id: 'U001', name: 'ada', profile: { email: 'ada@example.com' } },
      { id: 'U002', name: 'grace', profile: { email: 'grace@example.com' } },
    ],
    messages: [],
    files: [],
    rateLimit: new Map(),
  }
  let ts = 1_712_000_000
  const uploads = new Map<string, { filename: string; length: number; bytes?: Buffer }>()
  let origin = ''

  const slackHandler: Handler = async (req, url, body) => {
    const method = url.pathname.replace(/^\/slack\/api\//, '')
    if (method.startsWith('upload/')) {
      const id = method.slice('upload/'.length)
      const upload = uploads.get(id)
      if (!upload) return { status: 404, json: { error: 'no upload' } }
      upload.bytes = multipartFile(req, body)
      return { status: 200, json: { ok: true } }
    }
    const auth = req.headers.authorization ?? ''
    const token = auth.replace(/^Bearer /, '')
    if (token !== slack.token && !slack.acceptTokens.has(token))
      return { status: 200, json: { ok: false, error: 'invalid_auth' } }
    const limited = slack.rateLimit.get(method)
    if (limited !== undefined) {
      slack.rateLimit.delete(method)
      return {
        status: 429,
        headers: { 'retry-after': String(limited) },
        json: { ok: false, error: 'ratelimited' },
      }
    }
    const args: Record<string, unknown> =
      req.method === 'GET'
        ? Object.fromEntries(url.searchParams)
        : body.length
          ? JSON.parse(body.toString())
          : {}
    const channelId = (c: unknown) => {
      const name = String(c ?? '').replace(/^#/, '')
      return slack.channels.find((ch) => ch.id === name || ch.name === name)?.id
    }
    const page = <T>(items: T[]) => {
      const start = Number(args.cursor ?? 0)
      const limit = Number(args.limit ?? 100)
      const next = start + limit < items.length ? String(start + limit) : ''
      return { slice: items.slice(start, start + limit), meta: { next_cursor: next } }
    }
    switch (method) {
      case 'auth.test':
        return { status: 200, json: { ok: true, team: 'Fake Team', user: 'ow-bot', team_id: 'T001' } }
      case 'chat.postMessage': {
        const channel = channelId(args.channel)
        if (!channel) return { status: 200, json: { ok: false, error: 'channel_not_found' } }
        if (!args.text && !args.blocks) return { status: 200, json: { ok: false, error: 'no_text' } }
        const message = {
          channel,
          ts: `${++ts}.000100`,
          ...(typeof args.text === 'string' && { text: args.text }),
          ...(args.blocks !== undefined && { blocks: args.blocks }),
          ...(typeof args.thread_ts === 'string' && { thread_ts: args.thread_ts }),
        }
        slack.messages.push(message)
        return { status: 200, json: { ok: true, channel, ts: message.ts, message } }
      }
      case 'chat.update': {
        const message = slack.messages.find((m) => m.channel === args.channel && m.ts === args.ts)
        if (!message) return { status: 200, json: { ok: false, error: 'message_not_found' } }
        if (typeof args.text === 'string') message.text = args.text
        return {
          status: 200,
          json: { ok: true, channel: message.channel, ts: message.ts, text: message.text },
        }
      }
      case 'chat.delete': {
        const at = slack.messages.findIndex((m) => m.channel === args.channel && m.ts === args.ts)
        if (at < 0) return { status: 200, json: { ok: false, error: 'message_not_found' } }
        slack.messages.splice(at, 1)
        return { status: 200, json: { ok: true, channel: args.channel, ts: args.ts } }
      }
      case 'conversations.list': {
        const list = slack.channels.filter((c) => !(args.exclude_archived === 'true' && c.is_archived))
        const { slice, meta } = page(list)
        return { status: 200, json: { ok: true, channels: slice, response_metadata: meta } }
      }
      case 'users.list': {
        const { slice, meta } = page(slack.users)
        return { status: 200, json: { ok: true, members: slice, response_metadata: meta } }
      }
      case 'users.lookupByEmail': {
        const user = slack.users.find((u) => u.profile.email === args.email)
        return { status: 200, json: user ? { ok: true, user } : { ok: false, error: 'users_not_found' } }
      }
      case 'files.getUploadURLExternal': {
        const id = `F${uploads.size + 1}`
        uploads.set(id, { filename: String(args.filename), length: Number(args.length) })
        return {
          status: 200,
          json: { ok: true, file_id: id, upload_url: `${origin}/slack/api/upload/${id}` },
        }
      }
      case 'files.completeUploadExternal': {
        const files = (args.files as { id: string; title?: string }[]) ?? []
        const out = []
        for (const f of files) {
          const upload = uploads.get(f.id)
          if (!upload?.bytes) return { status: 200, json: { ok: false, error: 'file_not_found' } }
          if (upload.bytes.length !== upload.length)
            return { status: 200, json: { ok: false, error: 'file_size_mismatch' } }
          const file = {
            id: f.id,
            name: upload.filename,
            title: f.title ?? upload.filename,
            bytes: upload.bytes,
            ...(typeof args.channel_id === 'string' && { channel: args.channel_id }),
            ...(typeof args.initial_comment === 'string' && { comment: args.initial_comment }),
          }
          slack.files.push(file)
          out.push({ id: file.id, name: file.name, title: file.title, size: file.bytes.length })
        }
        return { status: 200, json: { ok: true, files: out } }
      }
      default:
        return { status: 200, json: { ok: false, error: 'unknown_method' } }
    }
  }

  const hubspot: FakeHubSpot = {
    token: opts.hubspotToken ?? 'pat-fake-token',
    acceptTokens: new Set(),
    records: new Map(),
    associations: [],
  }
  const HUBSPOT_PROPERTIES: Record<
    string,
    { name: string; label: string; type: string; options?: string[] }[]
  > = {
    contacts: [
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'firstname', label: 'First name', type: 'string' },
      { name: 'lastname', label: 'Last name', type: 'string' },
      {
        name: 'lifecyclestage',
        label: 'Lifecycle stage',
        type: 'enumeration',
        options: ['lead', 'customer'],
      },
    ],
    companies: [
      { name: 'name', label: 'Name', type: 'string' },
      { name: 'domain', label: 'Domain', type: 'string' },
    ],
    deals: [
      { name: 'dealname', label: 'Deal name', type: 'string' },
      { name: 'amount', label: 'Amount', type: 'number' },
      {
        name: 'dealstage',
        label: 'Stage',
        type: 'enumeration',
        options: ['appointmentscheduled', 'closedwon'],
      },
    ],
  }
  let hubspotId = 1000
  const hubspotHandler: Handler = async (req, url, body) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const error = (status: number, category: string, message: string) => ({
      status,
      json: { status: 'error', message, category, correlationId: `corr-${status}` },
    })
    if (token !== hubspot.token && !hubspot.acceptTokens.has(token)) {
      return error(401, 'INVALID_AUTHENTICATION', 'Authentication credentials not found.')
    }
    const path = url.pathname.replace(/^\/hubspot/, '')
    const json = body.length ? JSON.parse(body.toString()) : {}
    if (path === '/account-info/v3/details') {
      return {
        status: 200,
        json: { portalId: 4242, uiDomain: 'app-eu1.hubspot.com', companyCurrency: 'EUR' },
      }
    }
    const props = /^\/crm\/v3\/properties\/([\w-]+)$/.exec(path)
    if (props) {
      const list = HUBSPOT_PROPERTIES[props[1]!]
      if (!list) return error(400, 'VALIDATION_ERROR', `Unable to infer object type from: ${props[1]}`)
      return {
        status: 200,
        json: {
          results: [
            ...list.map((p) => ({
              name: p.name,
              label: p.label,
              type: p.type,
              fieldType: p.options ? 'select' : 'text',
              hidden: false,
              options: (p.options ?? []).map((o) => ({ label: o, value: o })),
            })),
            {
              name: 'hs_internal',
              label: 'Internal',
              type: 'string',
              fieldType: 'text',
              hidden: true,
              options: [],
            },
          ],
        },
      }
    }
    const assoc = /^\/crm\/v4\/objects\/([\w-]+)\/(\w+)\/associations\/default\/([\w-]+)\/(\w+)$/.exec(path)
    if (assoc && req.method === 'PUT') {
      const [, fromType, fromId, toType, toId] = assoc
      if (!hubspot.records.get(fromType!)?.has(fromId!) || !hubspot.records.get(toType!)?.has(toId!)) {
        return error(404, 'OBJECT_NOT_FOUND', 'One of the records does not exist')
      }
      hubspot.associations.push({ fromType: fromType!, fromId: fromId!, toType: toType!, toId: toId! })
      return {
        status: 200,
        json: { status: 'COMPLETE', results: [{ from: { id: fromId }, to: { id: toId } }] },
      }
    }
    const m = /^\/crm\/v3\/objects\/([\w-]+)(?:\/(search|batch\/upsert|[^/]+))?$/.exec(path)
    if (!m) return error(404, 'OBJECT_NOT_FOUND', `No route ${path}`)
    const type = m[1]!
    const known = HUBSPOT_PROPERTIES[type]
    if (!known) return error(400, 'VALIDATION_ERROR', `Unable to infer object type from: ${type}`)
    const records = hubspot.records.get(type) ?? new Map<string, FakeHubSpotRecord>()
    hubspot.records.set(type, records)
    const now = () => new Date(1_760_000_000_000 + hubspotId * 1000).toISOString()
    const view = (r: FakeHubSpotRecord, wanted?: string[]) => ({
      id: r.id,
      properties: wanted?.length
        ? Object.fromEntries(wanted.map((p) => [p, r.properties[p] ?? null]))
        : { ...r.properties, hs_object_id: r.id },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archived: false,
    })
    const checkProps = (p: Record<string, unknown>) => {
      const bad = Object.keys(p).filter((k) => !known.some((k2) => k2.name === k))
      return bad.length
        ? error(400, 'VALIDATION_ERROR', `Property values were not valid: ${bad.join(', ')}`)
        : null
    }
    const find = (id: string, idProperty: string | null) =>
      idProperty ? [...records.values()].find((r) => r.properties[idProperty] === id) : records.get(id)
    const create = (properties: Record<string, unknown>) => {
      const r = {
        id: String(++hubspotId),
        properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, String(v)])),
        createdAt: now(),
        updatedAt: now(),
      }
      records.set(r.id, r)
      return r
    }
    if (m[2] === 'search' && req.method === 'POST') {
      if ((json.limit ?? 10) > 200) return error(400, 'VALIDATION_ERROR', 'limit must be 200 or less')
      const groups = (json.filterGroups ?? []) as {
        filters: { propertyName: string; operator: string; value?: string }[]
      }[]
      const test = (r: FakeHubSpotRecord, f: { propertyName: string; operator: string; value?: string }) => {
        const v = r.properties[f.propertyName]
        switch (f.operator) {
          case 'EQ':
            return v === String(f.value)
          case 'NEQ':
            return v !== String(f.value)
          case 'GT':
            return Number(v) > Number(f.value)
          case 'LT':
            return Number(v) < Number(f.value)
          case 'CONTAINS_TOKEN':
            return (v ?? '').toLowerCase().includes(String(f.value).replace(/\*/g, '').toLowerCase())
          case 'HAS_PROPERTY':
            return v !== undefined
          default:
            return false
        }
      }
      let list = [...records.values()].filter(
        (r) => groups.length === 0 || groups.some((g) => g.filters.every((f) => test(r, f))),
      )
      if (json.query) {
        const q = String(json.query).toLowerCase()
        list = list.filter((r) => Object.values(r.properties).some((v) => v.toLowerCase().includes(q)))
      }
      const after = Number(json.after ?? 0)
      const limit = Number(json.limit ?? 10)
      const slice = list.slice(after, after + limit)
      return {
        status: 200,
        json: {
          total: list.length,
          results: slice.map((r) => view(r, json.properties)),
          ...(after + limit < list.length && { paging: { next: { after: String(after + limit) } } }),
        },
      }
    }
    if (m[2] === 'batch/upsert' && req.method === 'POST') {
      const inputs = json.inputs as { idProperty: string; id: string; properties: Record<string, unknown> }[]
      if (inputs.length > 100) return error(400, 'VALIDATION_ERROR', 'Batch size is limited to 100')
      const results = []
      for (const input of inputs) {
        const bad = checkProps(input.properties)
        if (bad) return bad
        const existing = find(input.id, input.idProperty)
        if (existing) {
          Object.assign(
            existing.properties,
            Object.fromEntries(Object.entries(input.properties).map(([k, v]) => [k, String(v)])),
          )
          results.push(view(existing))
        } else {
          results.push(view(create({ ...input.properties, [input.idProperty]: input.id })))
        }
      }
      return { status: 200, json: { status: 'COMPLETE', results } }
    }
    if (!m[2] && req.method === 'POST') {
      const bad = checkProps(json.properties ?? {})
      if (bad) return bad
      return { status: 201, json: view(create(json.properties ?? {})) }
    }
    if (m[2]) {
      const record = find(decodeURIComponent(m[2]), url.searchParams.get('idProperty'))
      if (!record) return error(404, 'OBJECT_NOT_FOUND', 'resource not found')
      if (req.method === 'GET') {
        const wanted = url.searchParams.get('properties')?.split(',')
        const assocs = url.searchParams.get('associations')?.split(',') ?? []
        const associations = Object.fromEntries(
          assocs.map((t) => [
            t,
            {
              results: hubspot.associations
                .filter((a) => a.fromType === type && a.fromId === record.id && a.toType === t)
                .map((a) => ({ id: a.toId, type: `${type}_to_${t}` })),
            },
          ]),
        )
        return { status: 200, json: { ...view(record, wanted), ...(assocs.length && { associations }) } }
      }
      if (req.method === 'PATCH') {
        const bad = checkProps(json.properties ?? {})
        if (bad) return bad
        Object.assign(
          record.properties,
          Object.fromEntries(Object.entries(json.properties ?? {}).map(([k, v]) => [k, String(v)])),
        )
        record.updatedAt = now()
        return { status: 200, json: view(record) }
      }
      if (req.method === 'DELETE') {
        records.delete(record.id)
        return { status: 204 }
      }
    }
    return error(405, 'VALIDATION_ERROR', 'Method not allowed')
  }

  const routes: [string, string, Handler][] = [
    ['/slack/api/', 'slack', slackHandler],
    ['/hubspot/', 'hubspot', hubspotHandler],
  ]

  const server = createServer(async (req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const route = routes.find(([prefix]) => url.pathname.startsWith(prefix))
    let parsed: unknown = null
    try {
      parsed =
        body.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(body.toString()) : null
    } catch {}
    calls.push({
      service: route?.[1] ?? '?',
      method: req.method ?? '',
      path: url.pathname + url.search,
      body: parsed,
      headers: req.headers,
    })
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"not found"}')
    }
    try {
      const out = await route[2](req, url, body)
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers })
      res.end(out.json === undefined ? '' : JSON.stringify(out.json))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: origin,
    urls: {
      slack: `${origin}/slack/api`,
      hubspot: `${origin}/hubspot`,
      sendgrid: `${origin}/sendgrid`,
      sheets: `${origin}/sheets/v4/spreadsheets`,
      drive: `${origin}/drive`,
    },
    slack,
    hubspot,
    calls,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** The first file part of a multipart body, enough for the fakes (one part, as the connectors send). */
function multipartFile(req: IncomingMessage, body: Buffer): Buffer {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] ?? '')
  if (!boundary) return body
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  const start = body.indexOf(marker)
  const headerEnd = body.indexOf('\r\n\r\n', start)
  const end = body.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), headerEnd)
  return body.subarray(headerEnd + 4, end)
}
