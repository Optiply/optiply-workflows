import type { Handler } from './fake'

// A fake of Jira's REST API for tests (M29), Cloud (v3: basic auth with an email and API token, ADF descriptions,
// /search/jql with nextPageToken) and Data Center (v2: a bearer PAT, text descriptions, /search with startAt).

export interface FakeJiraIssue {
  id: string
  key: string
  fields: Record<string, unknown>
  comments: unknown[]
}

export interface FakeJira {
  email: string
  apiToken: string
  pat: string
  projects: string[]
  issues: Map<string, FakeJiraIssue>
}

const WORKFLOW: Record<string, { id: string; name: string; to: string }[]> = {
  'To Do': [
    { id: '11', name: 'Start work', to: 'In Progress' },
    { id: '31', name: 'Done', to: 'Done' },
  ],
  'In Progress': [
    { id: '21', name: 'Back to do', to: 'To Do' },
    { id: '31', name: 'Done', to: 'Done' },
  ],
  Done: [{ id: '41', name: 'Reopen', to: 'To Do' }],
}

export function fakeJira(): { state: FakeJira; handler: Handler } {
  const state: FakeJira = {
    email: 'ops@optiply.nl',
    apiToken: 'jira-api-token',
    pat: 'jira-dc-pat',
    projects: ['OPS'],
    issues: new Map(),
  }
  let seq = 10000
  const fail = (status: number, errorMessages: string[], errors: Record<string, string> = {}) => ({
    status,
    json: { errorMessages, errors },
  })

  const handler: Handler = async (req, url, raw) => {
    const cloud = url.pathname.startsWith('/jira-cloud/')
    const auth = req.headers.authorization ?? ''
    const ok = cloud
      ? auth === `Basic ${Buffer.from(`${state.email}:${state.apiToken}`).toString('base64')}`
      : auth === `Bearer ${state.pat}`
    if (!ok)
      return fail(401, ['You are not authenticated. Authentication required to perform this operation.'])
    const v = cloud ? '3' : '2'
    const path = url.pathname.replace(/^\/jira-(cloud|dc)/, '')
    const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {}
    const api = `/rest/api/${v}`
    if (!path.startsWith(api)) return fail(404, [`No API ${path} on Jira ${cloud ? 'Cloud' : 'Data Center'}`])
    const rest = path.slice(api.length)

    if (rest === '/myself')
      return {
        status: 200,
        json: cloud
          ? { accountId: 'acc-1', displayName: 'Ops Bot', emailAddress: state.email }
          : { name: 'opsbot', displayName: 'Ops Bot' },
      }

    const search = (jql: string) => {
      const project = /project\s*=\s*"?(\w+)"?/i.exec(jql)?.[1]
      const status = /status\s*=\s*"([^"]+)"/i.exec(jql)?.[1]
      const notDone = /statusCategory\s*!=\s*Done/i.test(jql)
      return [...state.issues.values()]
        .filter((i) => !project || i.key.startsWith(`${project}-`))
        .filter((i) => !status || (i.fields.status as { name: string }).name === status)
        .filter((i) => !notDone || (i.fields.status as { name: string }).name !== 'Done')
        .sort((a, b) => Number(b.id) - Number(a.id))
    }
    const pick = (issue: FakeJiraIssue, fields?: string[]) => ({
      id: issue.id,
      key: issue.key,
      fields: fields
        ? Object.fromEntries(Object.entries(issue.fields).filter(([k]) => fields.includes(k)))
        : issue.fields,
    })
    if (cloud && rest === '/search/jql' && req.method === 'POST') {
      const all = search(String(body.jql ?? ''))
      const start = Number(body.nextPageToken ?? 0)
      const size = Number(body.maxResults ?? 50)
      const page = all.slice(start, start + size)
      const more = start + size < all.length
      return {
        status: 200,
        json: {
          issues: page.map((i) => pick(i, body.fields as string[])),
          ...(more && { nextPageToken: String(start + size) }),
          isLast: !more,
        },
      }
    }
    if (!cloud && rest === '/search' && req.method === 'POST') {
      const all = search(String(body.jql ?? ''))
      const start = Number(body.startAt ?? 0)
      const size = Number(body.maxResults ?? 50)
      return {
        status: 200,
        json: {
          startAt: start,
          maxResults: size,
          total: all.length,
          issues: all.slice(start, start + size).map((i) => pick(i, body.fields as string[])),
        },
      }
    }
    if (rest === '/issue' && req.method === 'POST') {
      const fields = (body.fields ?? {}) as Record<string, unknown>
      const project = (fields.project as { key?: string } | undefined)?.key
      if (!project || !state.projects.includes(project))
        return fail(400, [], { project: 'Specify a valid project ID or key' })
      if (!fields.summary) return fail(400, [], { summary: 'You must specify a summary of the issue.' })
      if (fields.description !== undefined) {
        const isAdf =
          typeof fields.description === 'object' && (fields.description as { type?: string }).type === 'doc'
        if (cloud && !isAdf)
          return fail(400, [], {
            description: 'Operation value must be an Atlassian Document (see the Atlassian Document Format)',
          })
        if (!cloud && typeof fields.description !== 'string')
          return fail(400, [], { description: 'Operation value must be a string' })
      }
      const id = String(++seq)
      const key = `${project}-${state.issues.size + 1}`
      state.issues.set(key, {
        id,
        key,
        fields: {
          ...fields,
          status: { name: 'To Do' },
          created: new Date(Date.UTC(2026, 10, 3, 0, 0, Number(id) % 60)).toISOString(),
        },
        comments: [],
      })
      return { status: 201, json: { id, key, self: `${url.origin}${api}/issue/${id}` } }
    }
    const m = /^\/issue\/([\w-]+)(\/transitions|\/comment|\/assignee)?$/.exec(rest)
    const issue = m
      ? (state.issues.get(m[1]!) ?? [...state.issues.values()].find((i) => i.id === m[1]))
      : undefined
    if (m && !issue) return fail(404, ['Issue does not exist or you do not have permission to see it.'])
    if (issue && !m![2]) {
      if (req.method === 'GET') {
        const fields = url.searchParams.get('fields')?.split(',')
        return { status: 200, json: pick(issue, fields) }
      }
      if (req.method === 'PUT') {
        Object.assign(issue.fields, (body.fields ?? {}) as object)
        return { status: 204 }
      }
    }
    if (issue && m![2] === '/transitions') {
      const status = (issue.fields.status as { name: string }).name
      const available = WORKFLOW[status] ?? []
      if (req.method === 'GET')
        return {
          status: 200,
          json: { transitions: available.map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })) },
        }
      const id = (body.transition as { id?: string } | undefined)?.id
      const t = available.find((x) => x.id === id)
      if (!t) return fail(400, [`Transition id '${id}' is not valid for this issue.`])
      issue.fields.status = { name: t.to }
      Object.assign(issue.fields, (body.fields ?? {}) as object)
      const comment = ((body.update as { comment?: { add: { body: unknown } }[] } | undefined)?.comment ??
        [])[0]
      if (comment) issue.comments.push(comment.add.body)
      return { status: 204 }
    }
    if (issue && m![2] === '/comment' && req.method === 'POST') {
      if (cloud && (typeof body.body !== 'object' || (body.body as { type?: string }).type !== 'doc'))
        return fail(400, [], { comment: 'Comment body must be an Atlassian Document' })
      issue.comments.push(body.body)
      return { status: 201, json: { id: String(issue.comments.length), body: body.body } }
    }
    if (issue && m![2] === '/assignee' && req.method === 'PUT') {
      issue.fields.assignee = cloud
        ? body.accountId
          ? { accountId: body.accountId }
          : null
        : body.name
          ? { name: body.name }
          : null
      return { status: 204 }
    }
    if (rest === '/project' && req.method === 'GET')
      return { status: 200, json: state.projects.map((key) => ({ key, name: key })) }
    return fail(404, [`Not found: ${req.method} ${path}`])
  }
  return { state, handler }
}
