import type { Readable } from 'node:stream'
import type { PoolManager } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import type { Db } from '@ow/db'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import postgres from 'postgres'
import { z } from 'zod'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import { CsvError, CsvParser, type CsvRecord } from '../services/csv'
import { authorizeManagedDb, ExistingName, ManagedDbError, withManagedDb } from '../services/managed-db'
import { exportCsv, IMPORT_MAX_BYTES, ImportError, ImportSpec, importCsv } from '../services/managed-db-csv'
import { RowQuery } from '../services/managed-db-rows'
import { drainOrClose } from './streaming'

/** The import body: one line of JSON (the ImportSpec), a line break, then the CSV file as it is. */
export const IMPORT_CONTENT_TYPE = 'application/x-ow-csv-import'
/** The spec line is small; a body with no line break this early isn't an import. */
const MAX_SPEC_BYTES = 1024 * 1024

const STATUS = { not_ready: 409, not_found: 404, forbidden: 403, invalid: 400 } as const

/**
 * CSV in and out of the managed database, for people with Use on it (session cookie). Both stream: an import is
 * parsed and inserted as it arrives (one transaction: all rows or none), an export is written page by page.
 *
 * - `POST /api/v1/database/import` with the import body (see IMPORT_CONTENT_TYPE).
 * - `GET /api/v1/database/export.csv?environmentId=&table=&selection=` (selection: the grid's sort and filters
 *   as JSON).
 */
export const databaseApi: FastifyPluginAsync<{ db: Db; keyring: Keyring; pool: PoolManager }> = async (
  app,
  { db, keyring, pool },
) => {
  // The body stays a stream: the route reads it as the import goes.
  app.addContentTypeParser(IMPORT_CONTENT_TYPE, (_req, payload, done) => done(null, payload))

  app.post('/database/import', { bodyLimit: IMPORT_MAX_BYTES + MAX_SPEC_BYTES }, async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return fail(reply, 401, 'Not signed in')
    if (!req.headers['content-type']?.startsWith(IMPORT_CONTENT_TYPE)) {
      return fail(reply, 415, `Send the import as ${IMPORT_CONTENT_TYPE}`)
    }
    const body = new BodyReader(req.body as Readable)
    try {
      const specLine = await body.line(MAX_SPEC_BYTES)
      const parsed = ImportSpec.safeParse(safeJson(specLine))
      if (!parsed.success) {
        return fail(
          reply,
          400,
          `Invalid import: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        )
      }
      const spec = parsed.data
      const target = await authorizeManagedDb(db, user, spec.environmentId)
      const result = await withManagedDb({ db, keyring, pool }, target, (tx) =>
        importCsv(tx, target.schemaName, spec, body.records(spec.delimiter)),
      )
      await recordAudit(db, {
        actorUserId: user.id,
        action: 'database.csv_imported',
        objectType: 'database_table',
        objectId: spec.table,
        environmentId: spec.environmentId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { mode: spec.mode, rows: result.rows, columns: spec.columns.map((c) => c.name) },
      })
      return reply.send(result)
    } catch (err) {
      return importFailure(reply, err)
    } finally {
      body.discard()
    }
  })

  app.get('/database/export.csv', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return fail(reply, 401, 'Not signed in')
    const parsed = z
      .object({
        environmentId: z.uuid(),
        table: ExistingName,
        selection: z
          .string()
          .optional()
          .transform((s) => (s ? safeJson(s) : {}))
          .pipe(RowQuery.pick({ sort: true, filters: true, match: true })),
      })
      .safeParse(req.query)
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]!.message)
    const { environmentId, table, selection } = parsed.data

    let target: Awaited<ReturnType<typeof authorizeManagedDb>>
    try {
      target = await authorizeManagedDb(db, user, environmentId)
    } catch (err) {
      return importFailure(reply, err)
    }

    // The status line goes out with the first chunk, so a table that doesn't exist (or a bad filter) is still
    // reported properly; after that, a failure cuts the connection so the download fails instead of looking done.
    const res = reply.raw
    let started = false
    let closed = false
    res.once('close', () => {
      closed = true
    })
    const write = async (chunk: string) => {
      if (closed) return false
      if (!started) {
        started = true
        reply.hijack()
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${table.replace(/[^\w.-]/g, '_')}.csv"`,
          'cache-control': 'no-store',
        })
      }
      if (!res.write(chunk) && !closed) await drainOrClose(res)
      return !closed
    }
    try {
      const rows = await withManagedDb({ db, keyring, pool }, target, (tx) =>
        exportCsv(tx, target.schemaName, table, selection, write),
      )
      await recordAudit(db, {
        actorUserId: user.id,
        action: 'database.csv_exported',
        objectType: 'database_table',
        objectId: table,
        environmentId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { rows, selection },
      })
      res.end()
    } catch (err) {
      if (!started) return importFailure(reply, err)
      req.log.error({ err }, 'database export failed')
      res.destroy()
    }
  })
}

function fail(reply: FastifyReply, status: number, message: string, problems?: unknown) {
  return reply.code(status).send({ error: { message, ...(problems ? { problems } : {}) } })
}

/** What went wrong, as a status the import dialog can show: the file's problems, or the database's refusal. */
function importFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof ImportError) return fail(reply, 400, err.message, err.problems)
  if (err instanceof CsvError) {
    return fail(reply, 400, err.message, err.line ? [{ line: err.line, message: err.reason }] : undefined)
  }
  if (err instanceof ManagedDbError) return fail(reply, STATUS[err.code], err.message)
  if (err instanceof postgres.PostgresError) {
    if (err.code === '55P03') return fail(reply, 409, 'The table is busy right now; try again in a moment')
    return fail(reply, 400, err.detail ? `${err.message} (${err.detail})` : err.message)
  }
  if (err instanceof BodyError) return fail(reply, err.status, err.message)
  throw err
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Reads the import body: the spec line, then the rest as UTF-8 text fed to the CSV parser record by record, pulling
 * from the request only as fast as the import inserts (backpressure). Counts bytes against the cap.
 */
class BodyReader {
  private iterator: AsyncIterator<Buffer>
  private pending: Buffer = Buffer.alloc(0)
  private bytes = 0
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(private readonly stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]()
  }

  private async next(): Promise<Buffer | null> {
    const { value, done } = await this.iterator.next()
    if (done) return null
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.bytes += chunk.length
    if (this.bytes > IMPORT_MAX_BYTES + MAX_SPEC_BYTES) {
      throw new BodyError(
        413,
        `The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB: split it into smaller files`,
      )
    }
    return chunk
  }

  async line(max: number): Promise<string> {
    for (;;) {
      const at = this.pending.indexOf(0x0a)
      if (at >= 0) {
        const line = this.pending.subarray(0, at).toString('utf8')
        this.pending = this.pending.subarray(at + 1)
        return line
      }
      if (this.pending.length > max) throw new BodyError(400, 'The import has no spec line')
      const chunk = await this.next()
      if (!chunk) throw new BodyError(400, 'The import has no spec line')
      this.pending = Buffer.concat([this.pending, chunk])
    }
  }

  async *records(delimiter: ConstructorParameters<typeof CsvParser>[0]): AsyncGenerator<CsvRecord> {
    const parser = new CsvParser(delimiter)
    const decode = (chunk: Buffer, stream: boolean) => {
      try {
        return this.decoder.decode(chunk, { stream })
      } catch {
        throw new CsvError('The file isn\'t UTF-8 text. In Excel, save it as "CSV UTF-8".')
      }
    }
    if (this.pending.length) yield* parser.push(decode(this.pending, true))
    this.pending = Buffer.alloc(0)
    for (;;) {
      const chunk = await this.next()
      if (!chunk) break
      yield* parser.push(decode(chunk, true))
    }
    yield* parser.push(decode(Buffer.alloc(0), false))
    yield* parser.end()
  }

  /**
   * Lets what's left of the upload drain away unread (after a failure it isn't wanted). Not destroy(): on a
   * request that closes the socket, and the error response with it.
   */
  discard() {
    this.stream.resume()
  }
}
