import type { Handler } from './fake'

// A fake of the Microsoft Graph Teams calls M37 makes (under `/graph/v1.0`) and of Teams' Workflows webhooks (under
// `/teams-webhook/<id>`), part of `startFakeServices`. Graph takes the tokens in `acceptTokens` (as the person they
// belong to), pages with `@odata.nextLink`, and keeps what was posted.

export interface FakeTeamsMessage {
  id: string
  body: { contentType: string; content: string }
  from: string
  replies: FakeTeamsMessage[]
  mentions?: unknown[]
  attachments?: unknown[]
  importance?: string
  subject?: string
}

export interface FakeTeams {
  /** Tokens accepted, with the user id each signs in as. */
  acceptTokens: Map<string, string>
  users: { id: string; displayName: string; mail: string }[]
  teams: {
    id: string
    displayName: string
    members: string[]
    channels: { id: string; displayName: string; messages: FakeTeamsMessage[] }[]
  }[]
  chats: { id: string; chatType: string; members: string[]; messages: FakeTeamsMessage[] }[]
  /** What the webhooks were sent. */
  webhooks: { id: string; body: unknown }[]
}

export function fakeTeams(origin: () => string): { state: FakeTeams; handler: Handler; webhook: Handler } {
  let ids = 0
  const state: FakeTeams = {
    acceptTokens: new Map([['eyJ.fake-teams-token', 'u-ada']]),
    users: [
      { id: 'u-ada', displayName: 'Ada Lovelace', mail: 'ada@optiply.nl' },
      { id: 'u-bob', displayName: 'Bob Builder', mail: 'bob@optiply.nl' },
    ],
    teams: [
      {
        id: 'team-ops',
        displayName: 'Operations',
        members: ['u-ada', 'u-bob'],
        channels: [
          { id: '19:general@thread.tacv2', displayName: 'General', messages: [] },
          { id: '19:alerts@thread.tacv2', displayName: 'Alerts', messages: [] },
        ],
      },
    ],
    chats: [],
    webhooks: [],
  }
  const fail = (status: number, code: string, message: string) => ({
    status,
    json: { error: { code, message, innerError: { 'request-id': `req-${++ids}` } } },
  })
  const userOf = (key: string) =>
    state.users.find((u) => u.id === key || u.mail.toLowerCase() === key.toLowerCase())
  /** A page of `items` from `skip`, with a next link when there's more. */
  const page = (url: URL, items: unknown[]) => {
    const top = Number(url.searchParams.get('$top') ?? '100')
    const skip = Number(url.searchParams.get('$skip') ?? '0')
    const next = new URL(url.toString().replace(/^http:\/\/x/, origin()))
    next.searchParams.set('$skip', String(skip + top))
    return {
      status: 200,
      json: {
        value: items.slice(skip, skip + top),
        ...(skip + top < items.length && { '@odata.nextLink': next.toString() }),
      },
    }
  }
  const posted = (json: Record<string, unknown>, from: string): FakeTeamsMessage => ({
    id: `m${++ids}`,
    body: json.body as FakeTeamsMessage['body'],
    from,
    replies: [],
    ...(json.mentions !== undefined && { mentions: json.mentions as unknown[] }),
    ...(json.attachments !== undefined && { attachments: json.attachments as unknown[] }),
    ...(typeof json.importance === 'string' && { importance: json.importance }),
    ...(typeof json.subject === 'string' && { subject: json.subject }),
  })

  const handler: Handler = async (req, url, body) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const me = state.acceptTokens.get(token)
    if (!me) return fail(401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.')
    const path = url.pathname.replace(/^\/graph\/v1\.0/, '')
    const json = body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {}
    const method = req.method ?? 'GET'
    if (path === '/me' && method === 'GET') {
      const u = userOf(me)!
      return {
        status: 200,
        json: { id: u.id, displayName: u.displayName, mail: u.mail, userPrincipalName: u.mail },
      }
    }
    const user = /^\/users\/([^/]+)$/.exec(path)
    if (user && method === 'GET') {
      const u = userOf(decodeURIComponent(user[1]!))
      return u
        ? { status: 200, json: { id: u.id, displayName: u.displayName } }
        : fail(404, 'Request_ResourceNotFound', `Resource '${user[1]}' does not exist`)
    }
    if (path === '/me/joinedTeams')
      return page(
        url,
        state.teams.filter((t) => t.members.includes(me)).map(({ id, displayName }) => ({ id, displayName })),
      )
    if (path === '/me/chats')
      return page(
        url,
        state.chats
          .filter((c) => c.members.includes(me))
          .map(({ id, chatType, members }) => ({
            id,
            chatType,
            members: members.map((m) => ({ userId: m })),
          })),
      )
    const team = /^\/teams\/([^/]+)(\/.*)$/.exec(path)
    if (team) {
      const t = state.teams.find((x) => x.id === decodeURIComponent(team[1]!))
      if (!t || !t.members.includes(me)) return fail(404, 'NotFound', 'No team found with Group Id')
      const rest = team[2]!
      if (rest === '/channels')
        return page(
          url,
          t.channels.map(({ id, displayName }) => ({ id, displayName })),
        )
      if (rest === '/members')
        return page(
          url,
          t.members.map((m) => ({ userId: m, displayName: userOf(m)?.displayName })),
        )
      const ch = /^\/channels\/([^/]+)\/messages(?:\/([^/]+)\/replies)?$/.exec(rest)
      if (ch) {
        const c = t.channels.find((x) => x.id === decodeURIComponent(ch[1]!))
        if (!c) return fail(404, 'NotFound', 'Channel not found')
        if (method === 'GET' && !ch[2]) {
          return page(
            url,
            [...c.messages]
              .reverse()
              .map((m) => (url.searchParams.get('$expand') === 'replies' ? m : { ...m, replies: undefined })),
          )
        }
        if (method === 'POST') {
          if (!(json.body as { content?: string } | undefined)?.content)
            return fail(400, 'BadRequest', 'Missing body content')
          const m = posted(json, me)
          if (ch[2]) {
            const parent = c.messages.find((x) => x.id === ch[2])
            if (!parent) return fail(404, 'NotFound', 'Message not found')
            parent.replies.push(m)
          } else c.messages.push(m)
          return { status: 201, json: m }
        }
      }
    }
    if (path === '/chats' && method === 'POST') {
      const members = ((json.members as Record<string, string>[]) ?? []).map((m) => {
        const id = /users\('([^']+)'\)/.exec(m['user@odata.bind'] ?? '')?.[1] ?? ''
        return userOf(id)?.id ?? null
      })
      if (members.some((m) => !m)) return fail(404, 'NotFound', 'A member was not found')
      const existing = state.chats.find(
        (c) => c.chatType === 'oneOnOne' && members.every((m) => c.members.includes(m!)),
      )
      if (existing) return { status: 200, json: { id: existing.id, chatType: 'oneOnOne' } }
      const chat = {
        id: `19:chat${++ids}@unq.gbl.spaces`,
        chatType: 'oneOnOne',
        members: members as string[],
        messages: [],
      }
      state.chats.push(chat)
      return { status: 201, json: { id: chat.id, chatType: chat.chatType } }
    }
    const chat = /^\/chats\/([^/]+)\/(messages|members)$/.exec(path)
    if (chat) {
      const c = state.chats.find((x) => x.id === decodeURIComponent(chat[1]!))
      if (!c || !c.members.includes(me)) return fail(404, 'NotFound', 'Chat not found')
      if (chat[2] === 'members')
        return page(
          url,
          c.members.map((m) => ({ userId: m })),
        )
      if (method === 'POST') {
        const m = posted(json, me)
        c.messages.push(m)
        return { status: 201, json: m }
      }
    }
    return fail(404, 'UnknownError', `No fake for ${method} ${path}`)
  }

  const webhook: Handler = async (req, url, body) => {
    const id = url.pathname.replace(/^\/teams-webhook\//, '')
    if (req.method !== 'POST' || id !== 'flow-1') return { status: 404, json: { error: 'no such workflow' } }
    state.webhooks.push({ id, body: JSON.parse(body.toString() || 'null') })
    return { status: 202 }
  }
  return { state, handler, webhook }
}
