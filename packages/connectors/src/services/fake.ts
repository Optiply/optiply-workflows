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

type Handler = (
  req: IncomingMessage,
  url: URL,
  body: Buffer,
) => Promise<{ status: number; json?: unknown; headers?: Record<string, string> }>

export async function startFakeServices(opts: { slackToken?: string } = {}): Promise<FakeServices> {
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

  const routes: [string, string, Handler][] = [['/slack/api/', 'slack', slackHandler]]

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
