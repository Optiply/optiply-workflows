import { z } from 'zod'
import {
  GOOGLE_TOKEN_URL,
  type GoogleTokens,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServerIdentity,
  serviceAccountTokens,
} from '../google-auth'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { oauthPresets } from '../oauth-presets'
import { responseMetadata } from '../rest'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  answer,
  apiCall,
  call,
  fieldReader,
  type ServiceCall,
  serviceBase,
  serviceRestConfig,
  validateActionQuery,
} from './common'

// Google Sheets (M27): a service account key, the server's own Google identity (M18; admins only) or M9's OAuth;
// values read and written by A1 ranges, rows as objects by the header row.

export const SHEETS_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file'

/** This process's Sheets settings, set once by the server (like `configureAws`). */
export interface SheetsDefaults {
  /** The server's own Google identity with the Sheets scope, only where the instance allows resources to use it. */
  serverIdentity?: ServerIdentity
  /** Google's token endpoint, for tests. */
  tokenUrl?: string
}

let defaults: SheetsDefaults = {}

export function configureSheets(next: SheetsDefaults): void {
  defaults = next
}

const configSchema = z.object({
  auth: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('serviceAccount') }),
      z.object({ type: z.literal('server') }),
      z.object({
        type: z.literal('oauth'),
        clientId: z.string().trim().min(1),
        scope: z.string().default(`openid email ${SHEETS_SCOPE}`),
        tokens: z.enum(['shared', 'perUser']).default('shared'),
      }),
    ])
    .default({ type: 'serviceAccount' }),
  /** A spreadsheet Test connection opens (its id or URL), to check the identity can see it. */
  testSpreadsheet: z.string().trim().optional(),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({
  serviceAccountKey: z
    .string()
    .min(1)
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account')
    .optional(),
  clientSecret: z.string().optional(),
})
type Secrets = z.output<typeof secretsSchema>

function httpConfig(config: Config) {
  const google = oauthPresets.google
  return serviceRestConfig(
    serviceBase('sheets', 'https://sheets.googleapis.com/v4/spreadsheets'),
    config.auth.type === 'oauth'
      ? {
          type: 'oauth2AuthorizationCode',
          provider: 'google',
          authorizeUrl: google.authorizeUrl,
          tokenUrl: google.tokenUrl,
          revokeUrl: google.revokeUrl,
          clientId: config.auth.clientId,
          scope: config.auth.scope,
          authorizeParams: google.authorizeParams,
          clientAuth: google.clientAuth,
          pkce: google.pkce,
          tokens: config.auth.tokens,
        }
      : { type: 'none' },
    // Sharing a new spreadsheet goes through Drive.
    [new URL(serviceBase('drive', 'https://www.googleapis.com').url).hostname],
  )
}

export interface SheetsClient {
  http: HttpClient
  /** The service account's or the server's tokens; OAuth's come through the query's credentials. */
  tokens?: GoogleTokens
  /** Who it signs in as, for Test connection and the "share it with" hint. */
  describe(signal: AbortSignal): Promise<string | null>
  /** The spreadsheet Test connection opens. */
  testSpreadsheet?: string
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

function sheetsClient(config: Config, secrets: Secrets): SheetsClient {
  const test = config.testSpreadsheet ? { testSpreadsheet: config.testSpreadsheet } : {}
  const http = createHttpClient(httpConfig(config), {
    headers: {},
    values: {},
    ...(secrets.clientSecret && { clientSecret: secrets.clientSecret }),
  })
  if (config.auth.type === 'oauth') return { http, describe: async () => null, ...test }
  if (config.auth.type === 'server') {
    const identity = defaults.serverIdentity
    if (!identity) {
      throw new ConnectorError(
        'invalid_config',
        "This instance doesn't let resources use its own Google identity; use a service account key",
      )
    }
    return { http, tokens: identity, describe: (signal) => identity.describe(signal), ...test }
  }
  if (!secrets.serviceAccountKey) {
    throw new ConnectorError('invalid_config', 'Add the service account key (serviceAccountKey)')
  }
  const key = parseServiceAccountKey(secrets.serviceAccountKey, 'serviceAccountKey')
  const tokens = serviceAccountTokens(key, {
    scope: SHEETS_SCOPE,
    field: 'serviceAccountKey',
    tokenUrl: defaults.tokenUrl ?? GOOGLE_TOKEN_URL,
    dispatcher: http.agent,
  })
  return { http, tokens, describe: async () => key.client_email, ...test }
}

/** A call with the client's identity (one retry with a fresh token on 401); Google's errors as connector errors. */
async function sheets(client: SheetsClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const send = async (force: boolean) =>
    call(
      client.http,
      client.tokens
        ? { ...request, authorization: `Bearer ${await client.tokens.token(ctx.signal, force)}` }
        : request,
      ctx,
    )
  let res = await send(false)
  if (res.status === 401 && client.tokens) res = await send(true)
  if (res.ok) return res
  const error = (res.data as { error?: { message?: string; status?: string } } | null)?.error
  let message = `Google Sheets: ${error?.message ?? `HTTP ${res.status}`}`
  if (res.status === 403 || res.status === 404) {
    const who = await client.describe(ctx.signal).catch(() => null)
    if (who) message += `. Share the spreadsheet with ${who}`
  }
  throw new ConnectorError('http', message, {
    status: res.status,
    ...(error?.status && { reason: error.status }),
  })
}

/** A spreadsheet's id, from the id or its URL. */
export function spreadsheetId(text: string): string {
  const fromUrl = /\/spreadsheets\/d\/([\w-]+)/.exec(text)
  const id = fromUrl ? fromUrl[1]! : text.trim()
  if (!/^[\w-]+$/.test(id)) throw new ConnectorError('invalid_query', 'Give the spreadsheet’s id or its URL')
  return id
}

/** `My sheet` → `'My sheet'`, as A1 notation wants names with spaces or punctuation. */
function quoteSheet(title: string): string {
  return /^[A-Za-z_][\w]*$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`
}

/** The sheet part of a range (`Orders!A1:C` → `Orders`), unquoted; null for a bare cell range. */
function sheetOf(range: string): string | null {
  const bang = range.lastIndexOf('!')
  const name = bang >= 0 ? range.slice(0, bang) : /^[A-Z]+\d*(:[A-Z]+\d*)?$/.test(range) ? null : range
  return name === null ? null : name.replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
}

/** Column letters for a 1-based index (1 → A, 27 → AA). */
function column(n: number): string {
  let s = ''
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  return s
}

/** Header names: empty ones become `column_<n>`, repeats get `_2`, `_3`. */
function headerNames(row: unknown[]): string[] {
  const seen = new Map<string, number>()
  return row.map((cell, i) => {
    const base = String(cell ?? '').trim() || `column_${i + 1}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

/** A cell's value as Sheets takes it: objects and arrays as JSON text, nothing as empty. */
function cell(value: unknown): unknown {
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : value
}

function isObjectRow(row: unknown): row is Record<string, unknown> {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
}

interface SheetInfo {
  sheetId: number
  title: string
  index: number
  rows: number
  columns: number
}

async function info(client: SheetsClient, id: string, ctx: Ctx) {
  const res = await sheets(
    client,
    {
      method: 'GET',
      path: `/${id}`,
      query: { fields: 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties' },
    },
    ctx,
  )
  const body = res.data as {
    spreadsheetId: string
    spreadsheetUrl?: string
    properties?: { title?: string }
    sheets?: {
      properties: {
        sheetId: number
        title: string
        index: number
        gridProperties?: { rowCount?: number; columnCount?: number }
      }
    }[]
  }
  const list: SheetInfo[] = (body.sheets ?? []).map(({ properties: p }) => ({
    sheetId: p.sheetId,
    title: p.title,
    index: p.index,
    rows: p.gridProperties?.rowCount ?? 0,
    columns: p.gridProperties?.columnCount ?? 0,
  }))
  return {
    res,
    id: body.spreadsheetId,
    title: body.properties?.title ?? '',
    url: body.spreadsheetUrl ?? null,
    sheets: list,
  }
}

async function values(client: SheetsClient, id: string, range: string, render: string, ctx: Ctx) {
  const res = await sheets(
    client,
    {
      method: 'GET',
      path: `/${id}/values/${encodeURIComponent(range)}`,
      query: { valueRenderOption: render, majorDimension: 'ROWS' },
    },
    ctx,
  )
  return { res, rows: ((res.data as { values?: unknown[][] }).values ?? []) as unknown[][] }
}

export const googleSheetsConnector: Connector<Config, Secrets, ActionQuery, SheetsClient> = {
  type: 'googlesheets',
  label: 'Google Sheets',
  configSchema,
  secretsSchema,
  querySchema: actionQuerySchema('googlesheets'),
  scrubResultData: true,

  createClient({ config, secrets }) {
    return sheetsClient(config, secrets)
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  httpConfig,

  async testConnection(client, { signal, credentials }) {
    const ctx = { signal, credentials }
    const who = await client.describe(signal)
    if (client.tokens) await client.tokens.token(signal, true)
    const parts = [who ? `Google Sheets as ${who}` : 'Google Sheets']
    if (client.testSpreadsheet) {
      const sheet = await info(client, spreadsheetId(client.testSpreadsheet), ctx)
      parts.push(`spreadsheet “${sheet.title}”`)
    }
    return { message: parts.join('; ') }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('googlesheets', query, ctx)
    const done = answer
    const id = async () => spreadsheetId(await f.required('spreadsheet'))
    /** The range given, or the first sheet's name. */
    /** The sheet a range names, or (a bare cell range, or none) the spreadsheet's first sheet. */
    const sheetFor = async (sid: string, range: string | undefined) =>
      (range && sheetOf(range)) ?? (await info(client, sid, ctx)).sheets[0]?.title ?? 'Sheet1'
    const rangeOr = async (sid: string) =>
      (await f.text('range')) ?? quoteSheet((await info(client, sid, ctx)).sheets[0]?.title ?? 'Sheet1')
    const valueInput = async () => {
      const v = (await f.text('valueInput')) ?? 'USER_ENTERED'
      if (v !== 'USER_ENTERED' && v !== 'RAW')
        throw new ConnectorError('invalid_query', 'Values are USER_ENTERED or RAW')
      return v
    }
    const rowsOf = async () => {
      const rows = await f.value('rows')
      if (!Array.isArray(rows))
        throw new ConnectorError('invalid_query', 'Rows must be an array of objects or of arrays')
      return rows
    }

    switch (query.action) {
      case 'read': {
        const sid = await id()
        const range = await rangeOr(sid)
        const render = (await f.text('render')) ?? 'FORMATTED_VALUE'
        if (!['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'].includes(render)) {
          throw new ConnectorError(
            'invalid_query',
            'Values are FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA',
          )
        }
        const { res, rows } = await values(client, sid, range, render, ctx)
        if (!((await f.bool('headers')) ?? true)) return done(rows, res, { range })
        const headers = headerNames(rows[0] ?? [])
        const objects = rows
          .slice(1)
          .filter((row) => row.some((c) => c !== '' && c !== null && c !== undefined))
          .map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null])))
        return done(objects, res, { range, headers })
      }
      case 'append': {
        const sid = await id()
        const range = await rangeOr(sid)
        const rows = await rowsOf()
        let table: unknown[][]
        if (rows.every(isObjectRow)) {
          const sheet = await sheetFor(sid, range)
          const { rows: head } = await values(client, sid, `${quoteSheet(sheet)}!1:1`, 'FORMATTED_VALUE', ctx)
          const headers = headerNames(head[0] ?? [])
          const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
            (k) => !headers.includes(k),
          )
          if (unknown.length) {
            throw new ConnectorError(
              'invalid_query',
              `Columns not in the sheet’s header row: ${unknown.join(', ')}`,
              {
                headers,
              },
            )
          }
          table = rows.map((r) => headers.map((h) => cell(r[h])))
        } else if (rows.every(Array.isArray)) {
          table = rows.map((r) => (r as unknown[]).map(cell))
        } else {
          throw new ConnectorError('invalid_query', 'Rows must be all objects or all arrays')
        }
        const res = await sheets(
          client,
          {
            method: 'POST',
            path: `/${sid}/values/${encodeURIComponent(range)}:append`,
            query: { valueInputOption: await valueInput(), insertDataOption: 'INSERT_ROWS' },
            json: { values: table },
          },
          ctx,
        )
        const updates = (res.data as { updates?: { updatedRange?: string; updatedRows?: number } }).updates
        return done(
          { updatedRange: updates?.updatedRange ?? null, updatedRows: updates?.updatedRows ?? 0 },
          res,
        )
      }
      case 'update': {
        const sid = await id()
        const rows = await rowsOf()
        const keyColumn = await f.text('keyColumn')
        if (!keyColumn) {
          const range = await f.required('range')
          if (!rows.every(Array.isArray)) {
            throw new ConnectorError(
              'invalid_query',
              'Without a key column, rows are arrays written to the range',
            )
          }
          const res = await sheets(
            client,
            {
              method: 'PUT',
              path: `/${sid}/values/${encodeURIComponent(range)}`,
              query: { valueInputOption: await valueInput() },
              json: { range, majorDimension: 'ROWS', values: rows.map((r) => (r as unknown[]).map(cell)) },
            },
            ctx,
          )
          const body = res.data as { updatedRange?: string; updatedRows?: number }
          return done({ updatedRange: body.updatedRange ?? null, updatedRows: body.updatedRows ?? 0 }, res)
        }
        if (!rows.every(isObjectRow))
          throw new ConnectorError('invalid_query', 'With a key column, rows are objects')
        const sheet = await sheetFor(sid, await f.text('range'))
        const { rows: table } = await values(client, sid, quoteSheet(sheet), 'FORMATTED_VALUE', ctx)
        const headers = headerNames(table[0] ?? [])
        const key = headers.indexOf(keyColumn)
        if (key < 0)
          throw new ConnectorError('invalid_query', `No column “${keyColumn}” in the header row`, { headers })
        const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !headers.includes(k))
        if (unknown.length) {
          throw new ConnectorError(
            'invalid_query',
            `Columns not in the sheet’s header row: ${unknown.join(', ')}`,
          )
        }
        const data: { range: string; values: unknown[][] }[] = []
        const notFound: unknown[] = []
        for (const row of rows) {
          const wanted = row[keyColumn]
          const at = table.findIndex((r, i) => i > 0 && String(r[key] ?? '') === String(wanted ?? ''))
          if (wanted === undefined || at < 0) {
            notFound.push(wanted ?? null)
            continue
          }
          const next = headers.map((h, i) => (h in row ? cell(row[h]) : (table[at]![i] ?? '')))
          data.push({
            range: `${quoteSheet(sheet)}!A${at + 1}:${column(headers.length)}${at + 1}`,
            values: [next],
          })
        }
        if (data.length === 0) return { data: { updatedRows: 0, notFound }, metadata: {} }
        const res = await sheets(
          client,
          {
            method: 'POST',
            path: `/${sid}/values:batchUpdate`,
            json: { valueInputOption: await valueInput(), data },
          },
          ctx,
        )
        return done({ updatedRows: data.length, notFound }, res)
      }
      case 'clear': {
        const sid = await id()
        const range = await f.required('range')
        const res = await sheets(
          client,
          { method: 'POST', path: `/${sid}/values/${encodeURIComponent(range)}:clear`, json: {} },
          ctx,
        )
        return done({ clearedRange: (res.data as { clearedRange?: string }).clearedRange ?? range }, res)
      }
      case 'info': {
        const { res, ...sheet } = await info(client, await id(), ctx)
        return done(sheet, res)
      }
      case 'addSheet': {
        const res = await sheets(
          client,
          {
            method: 'POST',
            path: `/${await id()}:batchUpdate`,
            json: { requests: [{ addSheet: { properties: { title: await f.required('title') } } }] },
          },
          ctx,
        )
        const reply = (res.data as { replies?: { addSheet?: { properties?: unknown } }[] }).replies?.[0]
        return done(reply?.addSheet?.properties ?? null, res)
      }
      case 'deleteSheet': {
        const sid = await id()
        const title = await f.required('title')
        const sheet = (await info(client, sid, ctx)).sheets.find((s) => s.title === title)
        if (!sheet) throw new ConnectorError('query', `No sheet “${title}” in the spreadsheet`)
        const res = await sheets(
          client,
          {
            method: 'POST',
            path: `/${sid}:batchUpdate`,
            json: { requests: [{ deleteSheet: { sheetId: sheet.sheetId } }] },
          },
          ctx,
        )
        return done({ deleted: title }, res)
      }
      case 'create': {
        const titles = await f.list('sheets')
        const res = await sheets(
          client,
          {
            method: 'POST',
            path: '',
            json: {
              properties: { title: await f.required('title') },
              ...(titles.length && { sheets: titles.map((title) => ({ properties: { title } })) }),
            },
          },
          ctx,
        )
        const created = res.data as { spreadsheetId: string; spreadsheetUrl?: string }
        const shared: string[] = []
        const drive = serviceBase('drive', 'https://www.googleapis.com').url
        for (const email of await f.list('shareWith')) {
          await sheets(
            client,
            {
              method: 'POST',
              path: `${drive}/drive/v3/files/${encodeURIComponent(created.spreadsheetId)}/permissions`,
              query: { sendNotificationEmail: 'false' },
              json: { type: 'user', role: 'writer', emailAddress: email },
            },
            ctx,
          )
          shared.push(email)
        }
        return done(
          { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl ?? null, sharedWith: shared },
          res,
        )
      }
      case 'api': {
        const res = await sheets(client, await apiCall(f, '/', 'the Sheets API'), ctx)
        return done(res.data, res)
      }
    }
    throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
  },
}
