import type { Db } from '@ow/db'
import type { FastifyPluginAsync } from 'fastify'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import { auditFilterSchema, auditPage, CSV_COLUMNS, csvRow } from '../services/audit-log'
import { drainOrClose } from './streaming'

/** Most rows one export holds; narrow the filters for more. */
export const MAX_EXPORT_ROWS = 100_000
const PAGE = 1000

/**
 * `GET /api/v1/audit/export.csv?action=&objectType=&objectId=&actorUserId=&since=&until=`: the audit log as CSV, for
 * admins (session cookie). Written page by page, newest first, so a big export never sits in memory.
 */
export const auditApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/audit/export.csv', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Not signed in' } })
    if (!user.isAdmin) return reply.code(403).send({ error: { code: 'forbidden', message: 'Admins only' } })
    const parsed = auditFilterSchema.safeParse(req.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]!.message } })
    }
    const filter = parsed.data
    await recordAudit(db, {
      actorUserId: user.id,
      action: 'audit.exported',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { filter },
    })

    // From here on the response is written by hand.
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    })
    const res = reply.raw
    // A download the browser gave up on stops the export: no more pages, and no wait for a drain that won't come.
    let closed = false
    const onClose = () => {
      closed = true
    }
    res.once('close', onClose)
    try {
      res.write(`${CSV_COLUMNS.join(',')}\r\n`)
      let written = 0
      let before: number | undefined
      while (written < MAX_EXPORT_ROWS && !closed) {
        const rows = await auditPage(db, filter, Math.min(PAGE, MAX_EXPORT_ROWS - written), before)
        if (!rows.length || closed) break
        const chunk = rows.map((r) => `${csvRow(r)}\r\n`).join('')
        if (!res.write(chunk) && !closed) await drainOrClose(res)
        written += rows.length
        before = rows.at(-1)!.id
        if (rows.length < PAGE) break
      }
      res.end()
    } catch (err) {
      // The status line is already sent: cut the connection so the download fails instead of looking complete.
      req.log.error({ err }, 'audit export failed')
      res.destroy()
    } finally {
      res.off('close', onClose)
    }
  })
}
