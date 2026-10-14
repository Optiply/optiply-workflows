import { auditEvents } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordAudit } from '../src/audit'
import { csvField } from '../src/services/audit-log'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
let adminId: string
let memberId: string

beforeAll(async () => {
  env = await startTestApp()
  adminId = (await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })).id
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  // A known history: two old events, then a few from today.
  await env.db.insert(auditEvents).values([
    {
      actorUserId: memberId,
      action: 'workflow.published',
      objectType: 'workflow',
      objectId: 'wf-1',
      at: new Date('2026-01-10T10:00:00Z'),
      metadata: { version: '1.0.0' },
    },
    {
      actorUserId: adminId,
      action: 'resource.update',
      objectType: 'resource',
      objectId: 'res-1',
      at: new Date('2026-02-01T10:00:00Z'),
      metadata: { note: 'a "quoted", comma\nnewline' },
    },
  ])
  await recordAudit(env.db, {
    actorUserId: memberId,
    action: '=HYPERLINK("http://evil")',
    objectType: 'workflow',
    objectId: '+1',
  })
})
afterAll(() => env?.stop())

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown } } }) => res.body.result?.data as any

describe('the audit log', () => {
  it('filters by action, object, person and time', async () => {
    const byAction = data(await admin.query('audit.list', { action: 'workflow.published' }))
    expect(byAction.items).toMatchObject([{ objectId: 'wf-1', actor: { email: 'member@optiply.nl' } }])
    const byObject = data(await admin.query('audit.list', { objectType: 'resource', objectId: 'res-1' }))
    expect(byObject.items.map((e: { action: string }) => e.action)).toEqual(['resource.update'])
    const byPerson = data(await admin.query('audit.list', { actorUserId: memberId }))
    // Newest recorded first (January's was inserted backdated, after their sign-in).
    expect(byPerson.items.map((e: { action: string }) => e.action)).toEqual([
      '=HYPERLINK("http://evil")',
      'workflow.published',
      'auth.login',
    ])
    const january = data(await admin.query('audit.list', { since: '2026-01-01', until: '2026-02-01' }))
    expect(january.items.map((e: { objectId: string }) => e.objectId)).toEqual(['wf-1'])
  })

  it('lists the actions, object types and people to filter by', async () => {
    const facets = data(await admin.query('audit.facets'))
    expect(facets.actions).toEqual(
      expect.arrayContaining(['workflow.published', 'resource.update', 'auth.login']),
    )
    expect(facets.objectTypes).toEqual(expect.arrayContaining(['workflow', 'resource']))
    expect(facets.actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'admin@optiply.nl' }),
        expect.objectContaining({ email: 'member@optiply.nl' }),
      ]),
    )
    expect((await trpc(env.app, memberCookie).query('audit.facets')).status).toBe(403)
  })

  it('exports CSV for admins, filtered, newest first, safe to open in a spreadsheet', async () => {
    const url = '/api/v1/audit/export.csv'
    expect((await env.app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await env.app.inject({ method: 'GET', url, headers: { cookie: memberCookie } })).statusCode).toBe(
      403,
    )
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: `${url}?since=yesterday`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(400)

    const res = await env.app.inject({
      method: 'GET',
      url: `${url}?until=2026-03-01`,
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    )
    const lines = res.body.split('\r\n')
    expect(lines[0]).toBe(
      'id,at,actor_email,actor_name,action,object_type,object_id,environment,ip,user_agent,metadata',
    )
    // Newest first; a field with quotes, commas or a line break is quoted.
    expect(lines[1]).toMatch(
      /^\d+,2026-02-01T10:00:00\.000Z,admin@optiply\.nl,[^,]*,resource\.update,resource,res-1,,,,"\{""note"":""a \\""quoted\\"", comma\\nnewline""\}"$/,
    )
    expect(lines[2]).toMatch(/,workflow\.published,workflow,wf-1,/)
    expect(lines[3]).toBe('')

    // Values a spreadsheet would run as formulas start with a quote.
    const all = await env.app.inject({ method: 'GET', url, headers: { cookie: adminCookie } })
    expect(all.body).toContain(`,"'=HYPERLINK(""http://evil"")",workflow,'+1,`)

    // Exporting is itself in the log (the refused request isn't an export).
    const exports = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'audit.exported'))
    expect(exports.length).toBe(2)
    expect(exports[0]).toMatchObject({ actorUserId: adminId })
  })

  it('streams big exports page by page', async () => {
    await env.db.insert(auditEvents).values(
      Array.from({ length: 2500 }, (_, i) => ({
        action: 'bulk.event',
        objectType: 'bulk',
        objectId: String(i),
      })),
    )
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/audit/export.csv?action=bulk.event',
      headers: { cookie: adminCookie },
    })
    const lines = res.body.trim().split('\r\n')
    expect(lines).toHaveLength(2501)
    expect(new Set(lines.slice(1).map((l) => l.split(',')[6])).size).toBe(2500)
  })

  it('quotes and guards CSV fields', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField(null)).toBe('')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField('-5')).toBe("'-5")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField(42)).toBe('42')
  })
})
