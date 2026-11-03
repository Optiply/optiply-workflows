import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { restConfigSchema, restSecretsSchema } from '../rest'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  answer,
  apiCall,
  call,
  fieldReader,
  limitOf,
  type ServiceCall,
  type ServiceSecrets,
  segment,
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// Jira (M29), Cloud and Data Center: the site's URL; Cloud signs in with an email and an API token (basic), Data
// Center with a personal access token (bearer). Issues searched by JQL (Cloud's /search/jql with nextPageToken, Data
// Center's /search with startAt), read, created, updated, moved through their workflow, commented on and assigned;
// plain-text descriptions and comments become Atlassian Document Format on Cloud.

const configSchema = z.object({
  siteUrl: z
    .string()
    .trim()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  deployment: z.enum(['cloud', 'datacenter']).default('cloud'),
  /** The account's email, with an API token (Cloud). */
  email: z.string().trim().email().optional(),
  /** A Data Center site in a private network (as REST's setting). */
  allowPrivateNetwork: z.boolean().default(false),
})
type Config = z.output<typeof configSchema>

interface JiraClient {
  http: HttpClient
  config: Config
  /** `3` on Cloud, `2` on Data Center. */
  v: string
}

function httpConfig(config: Config) {
  return restConfigSchema.parse({
    baseUrl: config.siteUrl,
    auth:
      config.deployment === 'cloud' ? { type: 'basic', username: config.email ?? '' } : { type: 'bearer' },
    allowedHosts: [],
    allowPrivateNetwork: config.allowPrivateNetwork,
    maxResponseBytes: 20 * 1024 * 1024,
  })
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

async function jira(client: JiraClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client.http, request, ctx)
  if (res.ok) return res
  const body = res.data as {
    errorMessages?: string[]
    errors?: Record<string, string>
    message?: string
  } | null
  const parts = [
    ...(body?.errorMessages ?? []),
    ...Object.entries(body?.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ...(body?.message ? [body.message] : []),
  ]
  throw new ConnectorError('http', `Jira: ${parts.join('; ') || `HTTP ${res.status}`}`, {
    status: res.status,
    ...(body?.errors && { errors: body.errors }),
  })
}

/** Plain text as an Atlassian Document: paragraphs on blank lines, line breaks kept. An object passes as it is. */
export function adf(value: unknown): unknown {
  if (value !== null && typeof value === 'object') return value
  const text = String(value ?? '')
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p
        .split('\n')
        .flatMap((line, i) => [
          ...(i > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
    })),
  }
}

/** An issue as a row: its id and key, then its fields. */
export function flatIssue(issue: {
  id?: string
  key?: string
  fields?: Record<string, unknown>
}): Record<string, unknown> {
  return { id: issue.id, key: issue.key, ...(issue.fields ?? {}) }
}

const DEFAULT_FIELDS = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'priority',
  'issuetype',
  'project',
  'created',
  'updated',
  'labels',
]

export const jiraConnector: Connector<Config, ServiceSecrets, ActionQuery, JiraClient> = {
  type: 'jira',
  label: 'Jira',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('jira'),
  scrubResultData: true,
  httpConfig,

  createClient({ config, secrets }) {
    if (!secrets.token)
      throw new ConnectorError(
        'invalid_config',
        config.deployment === 'cloud' ? 'Add the API token' : 'Add the personal access token',
      )
    if (config.deployment === 'cloud' && !config.email)
      throw new ConnectorError('invalid_config', 'Add the email of the account the API token belongs to')
    const secretsForRest = restSecretsSchema.parse(
      config.deployment === 'cloud' ? { password: secrets.token } : { bearerToken: secrets.token },
    )
    return {
      http: createHttpClient(httpConfig(config), secretsForRest),
      config,
      v: config.deployment === 'cloud' ? '3' : '2',
    }
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  async testConnection(client, ctx) {
    const res = await jira(client, { method: 'GET', path: `/rest/api/${client.v}/myself` }, ctx)
    const me = res.data as { displayName?: string; emailAddress?: string; name?: string }
    return {
      message: `Jira ${client.config.deployment === 'cloud' ? 'Cloud' : 'Data Center'} as ${me.displayName ?? me.name ?? me.emailAddress ?? 'the token'}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('jira', query, ctx)
    const api = `/rest/api/${client.v}`
    const cloud = client.config.deployment === 'cloud'
    // Data Center takes text: an object or list is written as JSON, not "[object Object]".
    const text = (value: unknown) =>
      cloud
        ? adf(value)
        : typeof value === 'string'
          ? value
          : value !== null && typeof value === 'object'
            ? JSON.stringify(value, null, 2)
            : String(value ?? '')
    const issuePath = async () => `${api}/issue/${segment(await f.required('issue'))}`

    switch (query.action) {
      case 'search': {
        const jql = await f.required('jql')
        const listed = await f.list('fieldList')
        const fields = listed.length ? listed : DEFAULT_FIELDS
        const max = limitOf(await f.number('max'))
        const issues: Record<string, unknown>[] = []
        let token: string | undefined
        let startAt = 0
        let done = false
        while (!done && issues.length < max) {
          const pageSize = Math.min(100, max - issues.length)
          const res = await jira(
            client,
            cloud
              ? {
                  method: 'POST',
                  path: `${api}/search/jql`,
                  json: { jql, fields, maxResults: pageSize, ...(token && { nextPageToken: token }) },
                }
              : {
                  method: 'POST',
                  path: `${api}/search`,
                  json: { jql, fields, maxResults: pageSize, startAt },
                },
            ctx,
          )
          const body = res.data as {
            issues?: { id: string; key: string; fields: Record<string, unknown> }[]
            nextPageToken?: string
            isLast?: boolean
            total?: number
          }
          const got = body.issues ?? []
          issues.push(...got.map(flatIssue))
          if (cloud) {
            token = body.nextPageToken
            done = !token || body.isLast === true || got.length === 0
          } else {
            startAt += got.length
            done = got.length === 0 || startAt >= (body.total ?? 0)
          }
        }
        return { data: issues.slice(0, max), metadata: { count: Math.min(issues.length, max), more: !done } }
      }
      case 'getIssue': {
        const fields = await f.list('fieldList')
        const res = await jira(
          client,
          {
            method: 'GET',
            path: await issuePath(),
            ...(fields.length && { query: { fields: fields.join(',') } }),
          },
          ctx,
        )
        return answer(
          flatIssue(res.data as { id: string; key: string; fields: Record<string, unknown> }),
          res,
        )
      }
      case 'createIssue': {
        const description = await f.value('description')
        const fields = {
          project: { key: await f.required('project') },
          issuetype: { name: await f.required('issueType') },
          summary: await f.required('summary'),
          ...(description !== undefined && description !== '' && { description: text(description) }),
          ...((await f.object('fields')) ?? {}),
        }
        const res = await jira(client, { method: 'POST', path: `${api}/issue`, json: { fields } }, ctx)
        return answer(res.data, res)
      }
      case 'updateIssue': {
        const summary = await f.text('summary')
        const description = await f.value('description')
        const fields = {
          ...(summary && { summary }),
          ...(description !== undefined && description !== '' && { description: text(description) }),
          ...((await f.object('fields')) ?? {}),
        }
        if (Object.keys(fields).length === 0)
          throw new ConnectorError('invalid_query', 'Give at least one field to change')
        const path = await issuePath()
        await jira(client, { method: 'PUT', path, json: { fields } }, ctx)
        return { data: { issue: await f.required('issue'), updated: Object.keys(fields) }, metadata: {} }
      }
      case 'transition': {
        const path = await issuePath()
        const wanted = await f.required('transition')
        const res = await jira(client, { method: 'GET', path: `${path}/transitions` }, ctx)
        const transitions =
          (res.data as { transitions?: { id: string; name: string; to?: { name?: string } }[] })
            .transitions ?? []
        const match =
          transitions.find((t) => t.id === wanted) ??
          transitions.find((t) => t.name.toLowerCase() === wanted.toLowerCase()) ??
          transitions.find((t) => t.to?.name?.toLowerCase() === wanted.toLowerCase())
        if (!match)
          throw new ConnectorError(
            'query',
            `No transition "${wanted}" from the issue's status; available: ${transitions.map((t) => t.name).join(', ') || 'none'}`,
          )
        const comment = await f.value('comment')
        const fields = await f.object('fields')
        await jira(
          client,
          {
            method: 'POST',
            path: `${path}/transitions`,
            json: {
              transition: { id: match.id },
              ...(fields && { fields }),
              ...(comment !== undefined &&
                comment !== '' && { update: { comment: [{ add: { body: text(comment) } }] } }),
            },
          },
          ctx,
        )
        return {
          data: { issue: await f.required('issue'), transition: match.name, to: match.to?.name ?? null },
          metadata: {},
        }
      }
      case 'addComment': {
        const res = await jira(
          client,
          {
            method: 'POST',
            path: `${await issuePath()}/comment`,
            json: { body: text(await f.value('body')) },
          },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'assign': {
        const assignee = await f.text('assignee')
        await jira(
          client,
          {
            method: 'PUT',
            path: `${await issuePath()}/assignee`,
            json: cloud ? { accountId: assignee ?? null } : { name: assignee ?? null },
          },
          ctx,
        )
        return { data: { issue: await f.required('issue'), assignee: assignee ?? null }, metadata: {} }
      }
      case 'api': {
        const res = await jira(client, await apiCall(f, '/rest/', 'the site’s /rest'), ctx)
        return answer(res.data, res)
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
