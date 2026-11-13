import type { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import {
  type ActionQuery,
  actionQuerySchema,
  fieldReader,
  fileOf,
  limitOf,
  validateActionQuery,
} from '../services/common'
import { type Connector, ConnectorError, type QueryResult } from '../types'
import { awsCredentials, awsError, awsIdentityConfig, awsIdentitySecrets } from './credentials'

// S3 and S3-compatible stores (M29): M26's AWS identity (an access key, a role, or the server's own credentials), an
// optional endpoint for MinIO, Cloudflare R2 or Google Cloud Storage's interoperability (admins choose it, as SQS's),
// and actions on objects: list, get, put, delete, copy, head, presigned URLs.

const configSchema = z.object({
  ...awsIdentityConfig,
  /** Another S3 endpoint (MinIO, R2, GCS); only admins may set it. */
  endpoint: z.string().trim().url().optional(),
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (MinIO and most compatible stores). */
  forcePathStyle: z.boolean().default(false),
  /** The bucket a query uses when it names none. */
  bucket: z.string().trim().min(3).max(255).optional(),
})
const secretsSchema = z.object(awsIdentitySecrets)

type Config = z.output<typeof configSchema>
type Secrets = z.output<typeof secretsSchema>

export interface S3Handle {
  s3: S3Client
  config: Config
}

/** The most an object read returns (`get`), and the most a `put` writes in one request. */
export const S3_MAX_BYTES = 10 * 1024 * 1024
/** Presigned URLs live at most 7 days (SigV4's limit). */
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600

export function s3Client(config: Config, secrets: Secrets): S3Handle {
  const s3 = new S3Client({
    region: config.region,
    credentials: awsCredentials({ ...config, ...secrets }),
    maxAttempts: 3,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint
      ? {
          endpoint: config.endpoint,
          // Compatible stores often refuse the SDK's default CRC checksums; send them only where S3 requires them.
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  })
  return { s3, config }
}

/** A stream read whole, or the query's error past `max` bytes. */
async function readAll(body: unknown, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body as Readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buf.length
    if (size > max) {
      ;(body as Readable).destroy?.()
      throw new ConnectorError('too_large', `The object is larger than ${max / 1024 / 1024} MB`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** A copy source as S3 wants it: the bucket, then the key with each segment URL-encoded. */
export function copySource(bucket: string, key: string): string {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/** What a `put` writes: bytes and, when the content doesn't say, a type. */
export function putBody(value: unknown, format: string): { bytes: Buffer; contentType?: string } {
  if (format === 'base64') {
    // Base64 text or a webhook's file object, read as everywhere else (`fileOf`).
    const file = fileOf(value, 'Content')
    return { bytes: file.bytes, ...(file.contentType && { contentType: file.contentType }) }
  }
  if (format === 'json' || (value !== null && typeof value === 'object')) {
    return { bytes: Buffer.from(JSON.stringify(value ?? null)), contentType: 'application/json' }
  }
  return {
    bytes: Buffer.from(value === undefined || value === null ? '' : String(value)),
    contentType: 'text/plain; charset=utf-8',
  }
}

export const s3Connector: Connector<Config, Secrets, ActionQuery, S3Handle> = {
  type: 's3',
  label: 'Amazon S3',
  configSchema,
  secretsSchema,
  querySchema: actionQuerySchema('s3'),

  createClient({ config, secrets }) {
    return s3Client(config, secrets)
  },

  async destroyClient({ s3 }) {
    s3.destroy()
  },

  async testConnection({ s3, config }, { signal }) {
    try {
      if (config.bucket) {
        await s3.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: signal })
        return { message: `Bucket ${config.bucket} in ${config.region} is reachable` }
      }
      const res = await s3.send(new ListBucketsCommand({}), { abortSignal: signal })
      return { message: `${res.Buckets?.length ?? 0} buckets visible in ${config.region}` }
    } catch (err) {
      throw awsError(err, config.bucket ? `reach bucket ${config.bucket}` : 'list buckets')
    }
  },

  validateQuery: validateActionQuery,

  async execute({ s3, config }, query, ctx): Promise<QueryResult> {
    const f = fieldReader('s3', query, ctx)
    const opts = { abortSignal: ctx.signal }
    const bucketOf = async (key = 'bucket') => {
      const bucket = (await f.text(key)) ?? config.bucket
      if (!bucket)
        throw new ConnectorError('invalid_query', 'Name the bucket, or set a default bucket on the resource')
      return bucket
    }
    const doing =
      (what: string) =>
      (err: unknown): never => {
        throw err instanceof ConnectorError ? err : awsError(err, what)
      }

    switch (query.action) {
      case 'listBuckets': {
        const res = await s3.send(new ListBucketsCommand({}), opts).catch(doing('list buckets'))
        const data = (res.Buckets ?? []).map((b) => ({
          name: b.Name ?? '',
          created: b.CreationDate?.toISOString() ?? null,
        }))
        return { data, metadata: { count: data.length } }
      }
      case 'list': {
        const bucket = await bucketOf()
        const prefix = await f.text('prefix')
        const delimiter = await f.text('delimiter')
        const max = limitOf(await f.number('max'), 100_000)
        const objects: {
          key: string
          size: number
          lastModified: string | null
          etag: string | null
          storageClass: string | null
        }[] = []
        const folders: string[] = []
        let token: string | undefined
        let truncated = false
        do {
          const res = await s3
            .send(
              new ListObjectsV2Command({
                Bucket: bucket,
                ...(prefix && { Prefix: prefix }),
                ...(delimiter && { Delimiter: delimiter }),
                MaxKeys: Math.min(1000, max - objects.length),
                ...(token && { ContinuationToken: token }),
              }),
              opts,
            )
            .catch(doing(`list ${bucket}`))
          for (const o of res.Contents ?? []) {
            objects.push({
              key: o.Key ?? '',
              size: o.Size ?? 0,
              lastModified: o.LastModified?.toISOString() ?? null,
              etag: o.ETag ?? null,
              storageClass: o.StorageClass ?? null,
            })
          }
          for (const p of res.CommonPrefixes ?? []) if (p.Prefix) folders.push(p.Prefix)
          token = res.IsTruncated ? res.NextContinuationToken : undefined
          truncated = !!token && objects.length >= max
        } while (token && objects.length < max)
        return { data: objects, metadata: { bucket, count: objects.length, folders, truncated } }
      }
      case 'get': {
        const bucket = await bucketOf()
        const key = await f.required('key')
        const format = (await f.text('format')) ?? 'text'
        const res = await s3
          .send(new GetObjectCommand({ Bucket: bucket, Key: key }), opts)
          .catch(doing(`get ${key}`))
        if ((res.ContentLength ?? 0) > S3_MAX_BYTES) {
          ;(res.Body as Readable | undefined)?.destroy?.()
          throw new ConnectorError(
            'too_large',
            `${key} is larger than ${S3_MAX_BYTES / 1024 / 1024} MB: use a presigned URL`,
          )
        }
        const bytes = await readAll(res.Body, S3_MAX_BYTES)
        let data: unknown
        if (format === 'base64') data = bytes.toString('base64')
        else if (format === 'json') {
          try {
            data = JSON.parse(bytes.toString('utf8'))
          } catch {
            throw new ConnectorError('query', `${key} isn't JSON`)
          }
        } else data = bytes.toString('utf8')
        return {
          data,
          metadata: {
            bucket,
            key,
            size: bytes.length,
            contentType: res.ContentType ?? null,
            etag: res.ETag ?? null,
            lastModified: res.LastModified?.toISOString() ?? null,
            metadata: res.Metadata ?? {},
          },
        }
      }
      case 'put': {
        const bucket = await bucketOf()
        const key = await f.required('key')
        const format = (await f.text('format')) ?? 'text'
        const { bytes, contentType: guessed } = putBody(await f.value('body'), format)
        if (bytes.length > S3_MAX_BYTES)
          throw new ConnectorError('too_large', `The content is larger than ${S3_MAX_BYTES / 1024 / 1024} MB`)
        const metadata = await f.object('metadata')
        const contentType = (await f.text('contentType')) ?? guessed
        const cacheControl = await f.text('cacheControl')
        const res = await s3
          .send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentLength: bytes.length,
              ...(contentType && { ContentType: contentType }),
              ...(cacheControl && { CacheControl: cacheControl }),
              ...(metadata && {
                Metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
              }),
            }),
            opts,
          )
          .catch(doing(`put ${key}`))
        return {
          data: { bucket, key, size: bytes.length, etag: res.ETag ?? null, versionId: res.VersionId ?? null },
          metadata: {},
        }
      }
      case 'delete': {
        const bucket = await bucketOf()
        const keys = await f.list('keys')
        if (keys.length === 0) throw new ConnectorError('invalid_query', 'Keys is empty')
        if (keys.length === 1) {
          await s3
            .send(new DeleteObjectCommand({ Bucket: bucket, Key: keys[0]! }), opts)
            .catch(doing(`delete ${keys[0]}`))
          return { data: { deleted: keys, errors: [] }, metadata: { bucket } }
        }
        const deleted: string[] = []
        const errors: { key: string; code: string; message: string }[] = []
        for (let i = 0; i < keys.length; i += 1000) {
          const res = await s3
            .send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: false },
              }),
              opts,
            )
            .catch(doing(`delete ${keys.length} objects`))
          for (const d of res.Deleted ?? []) if (d.Key) deleted.push(d.Key)
          for (const e of res.Errors ?? [])
            errors.push({ key: e.Key ?? '', code: e.Code ?? '', message: e.Message ?? '' })
        }
        return { data: { deleted, errors }, metadata: { bucket } }
      }
      case 'copy': {
        const bucket = await bucketOf()
        const key = await f.required('key')
        const sourceBucket = (await f.text('sourceBucket')) ?? bucket
        const sourceKey = await f.required('sourceKey')
        const res = await s3
          .send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: key,
              CopySource: copySource(sourceBucket, sourceKey),
            }),
            opts,
          )
          .catch(doing(`copy ${sourceKey}`))
        return {
          data: {
            bucket,
            key,
            from: { bucket: sourceBucket, key: sourceKey },
            etag: res.CopyObjectResult?.ETag ?? null,
          },
          metadata: {},
        }
      }
      case 'head': {
        const bucket = await bucketOf()
        const key = await f.required('key')
        const res = await s3
          .send(new HeadObjectCommand({ Bucket: bucket, Key: key }), opts)
          .catch(doing(`read ${key}`))
        return {
          data: {
            bucket,
            key,
            size: res.ContentLength ?? 0,
            contentType: res.ContentType ?? null,
            etag: res.ETag ?? null,
            lastModified: res.LastModified?.toISOString() ?? null,
            storageClass: res.StorageClass ?? null,
            metadata: res.Metadata ?? {},
          },
          metadata: {},
        }
      }
      case 'presign': {
        const bucket = await bucketOf()
        const key = await f.required('key')
        const method = ((await f.text('method')) ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'PUT')
          throw new ConnectorError('invalid_query', 'A presigned URL is for GET or PUT')
        const expiresIn = Math.floor((await f.number('expiresIn')) ?? 900)
        if (expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS)
          throw new ConnectorError(
            'invalid_query',
            `Expires in is 1 to ${MAX_PRESIGN_SECONDS.toLocaleString('en')} seconds`,
          )
        const contentType = await f.text('contentType')
        const command =
          method === 'GET'
            ? new GetObjectCommand({ Bucket: bucket, Key: key })
            : new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                ...(contentType && { ContentType: contentType }),
              })
        const url = await getSignedUrl(s3, command, { expiresIn }).catch(doing(`sign a URL for ${key}`))
        return {
          data: {
            url,
            method,
            bucket,
            key,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          },
          metadata: {},
        }
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
