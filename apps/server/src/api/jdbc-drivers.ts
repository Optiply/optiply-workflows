import type { Db } from '@ow/db'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import { JDBC_DRIVER_MAX_BYTES, JdbcDriverError, storeJdbcDriver } from '../services/jdbc-drivers'

const JAR_TYPES = ['application/java-archive', 'application/octet-stream', 'application/x-java-archive']

/**
 * Uploading a JDBC driver (M38), admins only (session cookie): `POST /api/v1/jdbc-drivers?name=&className=&fileName=`
 * with the jar as the body. Listing and deleting are in tRPC (`jdbcDrivers`).
 */
export const jdbcDriversApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.addContentTypeParser(
    JAR_TYPES,
    { parseAs: 'buffer', bodyLimit: JDBC_DRIVER_MAX_BYTES },
    (_req, body, done) => done(null, body),
  )

  app.post('/jdbc-drivers', { bodyLimit: JDBC_DRIVER_MAX_BYTES }, async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return fail(reply, 401, 'Not signed in')
    if (!user.isAdmin) return fail(reply, 403, 'Only admins upload JDBC drivers')
    if (!(req.body instanceof Buffer)) return fail(reply, 415, 'Send the jar as application/java-archive')
    const query = req.query as Record<string, string | undefined>
    try {
      const stored = await storeJdbcDriver(db, {
        name: query.name ?? '',
        className: query.className ?? '',
        fileName: query.fileName ?? '',
        jar: req.body,
        uploadedBy: user.id,
      })
      await recordAudit(db, {
        actorUserId: user.id,
        action: 'jdbc_driver.uploaded',
        objectType: 'jdbc_driver',
        objectId: stored.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { name: query.name, className: query.className, sha256: stored.sha256, size: stored.size },
      })
      return reply.send(stored)
    } catch (err) {
      if (err instanceof JdbcDriverError) return fail(reply, 400, err.message)
      throw err
    }
  })
}

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: { message } })
}
