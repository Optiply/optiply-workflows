import { randomUUID } from 'node:crypto'
import type { Handler } from './fake'
import { plainProperty } from './notion'

// A fake of Notion's API for tests (M29): the version header required, databases with property schemas, pages
// whose properties must match them, `{property, <type>: {equals}}` filters and sorts, block children paged through
// start_cursor (at most 100 appended at once), search by title.

export interface FakeNotionDatabase {
  id: string
  title: string
  properties: Record<string, { id: string; type: string }>
}

export interface FakeNotionPage {
  id: string
  parent: { database_id?: string; page_id?: string }
  properties: Record<string, Record<string, unknown>>
  archived: boolean
  created_time: string
  last_edited_time: string
  url: string
}

export interface FakeNotion {
  token: string
  databases: Map<string, FakeNotionDatabase>
  pages: Map<string, FakeNotionPage>
  blocks: Map<string, Record<string, unknown>[]>
}

export function fakeNotion(token = 'ntn_fake_token'): { state: FakeNotion; handler: Handler } {
  const state: FakeNotion = { token, databases: new Map(), pages: new Map(), blocks: new Map() }
  let clock = Date.UTC(2026, 10, 3)
  const fail = (status: number, code: string, message: string) => ({
    status,
    json: { object: 'error', status, code, message },
  })
  const list = (results: unknown[], start: number, size: number) => {
    const page = results.slice(start, start + size)
    const more = start + size < results.length
    return {
      status: 200,
      json: {
        object: 'list',
        results: page,
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      },
    }
  }
  // As Notion does, a database page lists every property of its database (an empty value where unset).
  const empty: Record<string, unknown> = {
    title: [],
    rich_text: [],
    number: null,
    select: null,
    status: null,
    multi_select: [],
    date: null,
    checkbox: false,
    url: null,
    email: null,
    phone_number: null,
    people: [],
    relation: [],
  }
  const withTypes = (
    props: Record<string, Record<string, unknown>>,
    schema?: FakeNotionDatabase,
    fill = true,
  ) =>
    Object.fromEntries(
      [
        ...Object.entries(fill ? (schema?.properties ?? {}) : {})
          .filter(([name]) => !(name in props))
          .map(
            ([name, { type }]) =>
              [name, { [type]: empty[type] ?? null }] as [string, Record<string, unknown>],
          ),
        ...Object.entries(props),
      ].map(([name, p]) => {
        const type =
          schema?.properties[name]?.type ??
          Object.keys(p).find((k) => k !== 'id' && k !== 'type') ??
          'rich_text'
        return [name, { id: schema?.properties[name]?.id ?? name, type, [type]: p[type] }]
      }),
    )

  const handler: Handler = async (req, url, raw) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${state.token}`)
      return fail(401, 'unauthorized', 'API token is invalid.')
    if (req.headers['notion-version'] !== '2022-06-28')
      return fail(400, 'missing_version', 'Notion-Version header failed validation')
    const path = url.pathname.replace(/^\/notion/, '')
    const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {}
    const start = Number(body.start_cursor ?? url.searchParams.get('start_cursor') ?? 0)
    const size = Number(body.page_size ?? url.searchParams.get('page_size') ?? 100)

    if (path === '/v1/users/me')
      return {
        status: 200,
        json: {
          object: 'user',
          id: 'bot-1',
          name: 'Optiply bot',
          type: 'bot',
          bot: { workspace_name: 'Optiply' },
        },
      }

    let m = /^\/v1\/databases\/([\w-]+)(\/query)?$/.exec(path)
    if (m) {
      const db = state.databases.get(m[1]!)
      if (!db) return fail(404, 'object_not_found', `Could not find database with ID: ${m[1]}.`)
      if (!m[2])
        return {
          status: 200,
          json: {
            object: 'database',
            id: db.id,
            title: [{ plain_text: db.title }],
            properties: db.properties,
          },
        }
      let rows = [...state.pages.values()].filter((p) => p.parent.database_id === db.id && !p.archived)
      const filter = body.filter as Record<string, unknown> | undefined
      if (filter) {
        const prop = String(filter.property)
        const cond = Object.entries(filter).find(([k]) => k !== 'property')?.[1] as
          | { equals?: unknown }
          | undefined
        if (!cond || !('equals' in cond))
          return fail(400, 'validation_error', 'The fake supports {property, <type>: {equals}} filters')
        rows = rows.filter((p) => p.properties[prop] && plainProperty(p.properties[prop]!) === cond.equals)
      }
      for (const s of ((body.sorts as { property: string; direction?: string }[] | undefined) ?? [])
        .slice()
        .reverse()) {
        rows.sort((a, b) => {
          const x = a.properties[s.property] ? plainProperty(a.properties[s.property]!) : null
          const y = b.properties[s.property] ? plainProperty(b.properties[s.property]!) : null
          const c = String(x ?? '') < String(y ?? '') ? -1 : String(x ?? '') > String(y ?? '') ? 1 : 0
          return s.direction === 'descending' ? -c : c
        })
      }
      return list(
        rows.map((p) => ({ object: 'page', ...p })),
        start,
        size,
      )
    }
    if (path === '/v1/pages' && req.method === 'POST') {
      const parent = body.parent as { database_id?: string; page_id?: string }
      const props = (body.properties ?? {}) as Record<string, Record<string, unknown>>
      const db = parent.database_id ? state.databases.get(parent.database_id) : undefined
      if (parent.database_id && !db)
        return fail(404, 'object_not_found', `Could not find database with ID: ${parent.database_id}.`)
      if (parent.page_id && !state.pages.has(parent.page_id))
        return fail(404, 'object_not_found', `Could not find page with ID: ${parent.page_id}.`)
      if (db) {
        for (const [name, p] of Object.entries(props)) {
          const type = db.properties[name]?.type
          if (!type) return fail(400, 'validation_error', `${name} is not a property that exists.`)
          if (!(type in p)) return fail(400, 'validation_error', `${name} is expected to be ${type}.`)
        }
      }
      const id = randomUUID()
      clock += 1000
      const page: FakeNotionPage = {
        id,
        parent,
        properties: withTypes(props, db),
        archived: false,
        created_time: new Date(clock).toISOString(),
        last_edited_time: new Date(clock).toISOString(),
        url: `https://www.notion.so/${id.replaceAll('-', '')}`,
      }
      state.pages.set(id, page)
      const children = (body.children as Record<string, unknown>[] | undefined) ?? []
      if (children.length > 100) return fail(400, 'validation_error', 'body.children.length should be ≤ 100')
      state.blocks.set(
        id,
        children.map((c) => ({ id: randomUUID(), has_children: false, ...c })),
      )
      return { status: 200, json: { object: 'page', ...page } }
    }
    m = /^\/v1\/pages\/([\w-]+)$/.exec(path)
    if (m) {
      const page = state.pages.get(m[1]!)
      if (!page) return fail(404, 'object_not_found', `Could not find page with ID: ${m[1]}.`)
      if (req.method === 'PATCH') {
        const db = page.parent.database_id ? state.databases.get(page.parent.database_id) : undefined
        const props = (body.properties ?? {}) as Record<string, Record<string, unknown>>
        for (const [name, p] of Object.entries(props)) {
          const type = page.properties[name]?.type as string | undefined
          if (!type) return fail(400, 'validation_error', `${name} is not a property that exists.`)
          if (!(type in p)) return fail(400, 'validation_error', `${name} is expected to be ${type}.`)
        }
        Object.assign(page.properties, withTypes(props, db, false))
        if (body.archived !== undefined) page.archived = !!body.archived
        clock += 1000
        page.last_edited_time = new Date(clock).toISOString()
      }
      return { status: 200, json: { object: 'page', ...page } }
    }
    m = /^\/v1\/blocks\/([\w-]+)\/children$/.exec(path)
    if (m) {
      const blocks = state.blocks.get(m[1]!)
      if (!blocks) return fail(404, 'object_not_found', `Could not find block with ID: ${m[1]}.`)
      if (req.method === 'PATCH') {
        const children = (body.children as Record<string, unknown>[] | undefined) ?? []
        if (children.length > 100)
          return fail(400, 'validation_error', 'body.children.length should be ≤ 100')
        const added = children.map((c) => ({ object: 'block', id: randomUUID(), has_children: false, ...c }))
        blocks.push(...added)
        return { status: 200, json: { object: 'list', results: added } }
      }
      return list(blocks, start, size)
    }
    if (path === '/v1/search' && req.method === 'POST') {
      const q = String(body.query ?? '').toLowerCase()
      const only = (body.filter as { value?: string } | undefined)?.value
      const pages = [...state.pages.values()]
        .filter((p) => !p.archived)
        .filter((p) => {
          const title = Object.values(p.properties).find((x) => x.type === 'title')
          return (
            !q ||
            String(title ? plainProperty(title) : '')
              .toLowerCase()
              .includes(q)
          )
        })
        .map((p) => ({ object: 'page', ...p }))
      const dbs = [...state.databases.values()]
        .filter((d) => !q || d.title.toLowerCase().includes(q))
        .map((d) => ({
          object: 'database',
          id: d.id,
          title: [{ plain_text: d.title }],
          url: `https://www.notion.so/${d.id.replaceAll('-', '')}`,
        }))
      const results = only === 'page' ? pages : only === 'database' ? dbs : [...dbs, ...pages]
      return list(results, start, size)
    }
    return fail(404, 'invalid_request_url', `Invalid request URL: ${req.method} ${path}`)
  }
  return { state, handler }
}
