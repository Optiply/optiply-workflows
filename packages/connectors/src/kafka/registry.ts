import avro from 'avsc'
import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, httpRequest } from '../http-core'
import { restConfigSchema, restSecretsSchema } from '../rest'
import { ConnectorError } from '../types'

// The Kafka Schema Registry (M30): Confluent's REST API (also Redpanda's and Karapace's). Messages in the Confluent
// wire format (magic byte 0, a 4-byte schema id, then the payload) are decoded by their schema, Avro or JSON Schema;
// produce queries encode a message by its subject's latest schema.

export const schemaRegistrySchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  username: z.string().trim().min(1).optional(),
  /** A registry inside Optiply's network (as REST's setting). */
  allowPrivateNetwork: z.boolean().default(false),
})
export type SchemaRegistryConfig = z.output<typeof schemaRegistrySchema>

interface Schema {
  id: number
  type: 'AVRO' | 'JSON' | 'PROTOBUF'
  avro?: avro.Type
}

export interface SchemaRegistry {
  /** The message's value decoded when it's in the wire format (`schemaId` with it); undefined when it isn't. */
  decode(value: Buffer, signal: AbortSignal): Promise<{ value: unknown; schemaId: number } | undefined>
  /** A value encoded with a subject's latest schema, framed for the wire. */
  encode(subject: string, value: unknown, signal: AbortSignal): Promise<Buffer>
  close(): Promise<void>
}

/** Whether a value is in the Confluent wire format: magic byte 0 and a schema id. */
export function wireSchemaId(value: Buffer | null): number | undefined {
  if (!value || value.length < 5 || value[0] !== 0) return undefined
  return value.readUInt32BE(1)
}

/** Avro decodes to plain JSON: Buffers (bytes) as base64, longs as numbers; unions as their branch. */
function plain(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = plain(v)
    return out
  }
  return value
}

export function schemaRegistry(config: SchemaRegistryConfig, password: string | undefined): SchemaRegistry {
  let http: HttpClient | undefined
  const client = () => {
    http ??= createHttpClient(
      restConfigSchema.parse({
        baseUrl: config.url,
        auth: config.username ? { type: 'basic', username: config.username } : { type: 'none' },
        allowPrivateNetwork: config.allowPrivateNetwork,
        maxResponseBytes: 5 * 1024 * 1024,
      }),
      restSecretsSchema.parse(password ? { password } : {}),
    )
    return http
  }
  const byId = new Map<number, Promise<Schema>>()
  const latest = new Map<string, { at: number; schema: Promise<Schema> }>()

  const get = async (path: string, signal: AbortSignal) => {
    const res = await httpRequest(
      client(),
      { method: 'GET', url: new URL(`${config.url.replace(/\/+$/, '')}${path}`) },
      { signal },
    )
    if (!res.ok) {
      const body = res.data as { message?: string; error_code?: number } | null
      throw new ConnectorError('query', `Schema registry: ${body?.message ?? `HTTP ${res.status}`}`, {
        status: res.status,
      })
    }
    return res.data as { id?: number; schema?: string; schemaType?: string }
  }
  const compile = (id: number, text: string, type: string | undefined): Schema => {
    const kind = (type ?? 'AVRO').toUpperCase() as Schema['type']
    if (kind === 'AVRO') {
      try {
        return { id, type: kind, avro: avro.Type.forSchema(JSON.parse(text)) }
      } catch (err) {
        throw new ConnectorError(
          'query',
          `Schema ${id} isn't an Avro schema this can read: ${(err as Error).message}`,
        )
      }
    }
    return { id, type: kind }
  }
  const schemaById = (id: number, signal: AbortSignal) => {
    let s = byId.get(id)
    if (!s) {
      s = get(`/schemas/ids/${id}`, signal).then((r) => compile(id, r.schema ?? '', r.schemaType))
      s.catch(() => byId.delete(id))
      byId.set(id, s)
    }
    return s
  }

  return {
    async decode(value, signal) {
      const id = wireSchemaId(value)
      if (id === undefined) return undefined
      const schema = await schemaById(id, signal)
      const payload = value.subarray(5)
      if (schema.type === 'AVRO') return { value: plain(schema.avro!.fromBuffer(payload)), schemaId: id }
      if (schema.type === 'JSON') return { value: JSON.parse(payload.toString('utf8')), schemaId: id }
      throw new ConnectorError('query', `Schema ${id} is ${schema.type}, which isn't decoded here`)
    },
    async encode(subject, value, signal) {
      let entry = latest.get(subject)
      if (!entry || entry.at < Date.now() - 60_000) {
        const schema = get(`/subjects/${encodeURIComponent(subject)}/versions/latest`, signal).then((r) =>
          compile(r.id ?? 0, r.schema ?? '', r.schemaType),
        )
        schema.catch(() => latest.delete(subject))
        entry = { at: Date.now(), schema }
        latest.set(subject, entry)
      }
      const schema = await entry.schema
      let payload: Buffer
      if (schema.type === 'AVRO') {
        const errors: string[] = []
        if (
          !schema.avro!.isValid(value, { errorHook: (path) => errors.push(path.join('.') || '(the value)') })
        )
          throw new ConnectorError(
            'invalid_query',
            `The value doesn't match subject ${subject}'s schema at ${errors.join(', ')}`,
          )
        payload = schema.avro!.toBuffer(value)
      } else if (schema.type === 'JSON') payload = Buffer.from(JSON.stringify(value))
      else
        throw new ConnectorError(
          'invalid_query',
          `Subject ${subject} is ${schema.type}, which isn't encoded here`,
        )
      const header = Buffer.alloc(5)
      header.writeUInt32BE(schema.id, 1)
      return Buffer.concat([header, payload])
    },
    async close() {
      if (http) await destroyHttpClient(http)
      http = undefined
    },
  }
}
