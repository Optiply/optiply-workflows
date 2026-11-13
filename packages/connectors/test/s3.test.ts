import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copySource, putBody, s3Connector } from '../src/aws/s3'
import { s3Available, startTestS3, type TestS3 } from '../src/aws/test-s3'
import { PoolManager } from '../src/pool'
import { runQuery, testResource } from '../src/run'
import { resource, scopeEvaluator } from './helpers'

// The `s3` resource (M29 step 1) against a throwaway S3-compatible store (Versity Gateway) that checks signatures.
// Skipped locally without Docker; CI runs it.
const available = s3Available()
let store: TestS3
const pool = new PoolManager()

beforeAll(async () => {
  if (!available) return
  store = await startTestS3()
}, 120_000)
afterAll(async () => {
  await pool.closeAll()
  await store?.stop()
})

const s3 = (config: object = {}, secret?: string) =>
  resource(
    {
      region: store.region,
      accessKeyId: store.accessKeyId,
      endpoint: store.endpoint,
      forcePathStyle: true,
      ...config,
    },
    { secretAccessKey: secret ?? store.secretAccessKey },
  )
const query = (res: ReturnType<typeof s3>, action: string, fields: Record<string, string>, scope = {}) =>
  runQuery(pool, s3Connector, res, { action, ...fields }, { evaluate: scopeEvaluator(scope) })

describe('s3 helpers', () => {
  it('encodes a copy source segment by segment', () => {
    expect(copySource('my-bucket', 'a dir/ü/x+y.csv')).toBe('my-bucket/a%20dir/%C3%BC/x%2By.csv')
  })

  it('writes text, JSON and base64 content', () => {
    expect(putBody('hello', 'text')).toEqual({
      bytes: Buffer.from('hello'),
      contentType: 'text/plain; charset=utf-8',
    })
    expect(putBody({ a: 1 }, 'text')).toEqual({
      bytes: Buffer.from('{"a":1}'),
      contentType: 'application/json',
    })
    expect(putBody('aGk=', 'base64').bytes.toString()).toBe('hi')
    expect(putBody({ base64: 'aGk=', filename: 'x.txt', contentType: 'text/plain' }, 'base64')).toEqual({
      bytes: Buffer.from('hi'),
      contentType: 'text/plain',
    })
    expect(() => putBody('not base64!', 'base64')).toThrow(/needs base64 text/)
  })
})

describe.skipIf(!available)('s3 resource', () => {
  it('tests the connection, and refuses a wrong secret', async () => {
    expect(await testResource(s3Connector, s3())).toMatchObject({
      ok: true,
      message: `0 buckets visible in ${store.region}`,
    })
    const wrong = await testResource(s3Connector, s3({}, 'not-the-secret'))
    expect(wrong.ok).toBe(false)
  })

  it('puts, lists, gets, copies, heads and deletes objects in a bucket', async () => {
    const res = s3()
    await store.createBucket('reports')

    const rows = [{ sku: 'A', qty: 3 }]
    const put = await query(
      res,
      'put',
      { bucket: 'reports', key: 'nov/stock.json', body: '{{ rows }}', format: 'json' },
      { rows },
    )
    expect(put.data).toMatchObject({ bucket: 'reports', key: 'nov/stock.json', size: 21 })
    await query(
      res,
      'put',
      { bucket: 'reports', key: 'nov/notes.txt', body: 'Ünïcode text', metadata: '{"by": "{{ who }}"}' },
      { who: 'ann' },
    )
    await query(res, 'put', { bucket: 'reports', key: 'top.txt', body: 'top' })

    const listed = await query(res, 'list', { bucket: 'reports', prefix: 'nov/' })
    expect((listed.data as { key: string }[]).map((o) => o.key)).toEqual(['nov/notes.txt', 'nov/stock.json'])
    const folders = await query(res, 'list', { bucket: 'reports', delimiter: '/' })
    expect((folders.data as { key: string }[]).map((o) => o.key)).toEqual(['top.txt'])
    expect(folders.metadata.folders).toEqual(['nov/'])
    const paged = await query(res, 'list', { bucket: 'reports', max: '2' })
    expect((paged.data as unknown[]).length).toBe(2)
    expect(paged.metadata.truncated).toBe(true)

    expect(
      (await query(res, 'get', { bucket: 'reports', key: 'nov/stock.json', format: 'json' })).data,
    ).toEqual(rows)
    const text = await query(res, 'get', { bucket: 'reports', key: 'nov/notes.txt' })
    expect(text.data).toBe('Ünïcode text')
    expect(text.metadata).toMatchObject({ contentType: 'text/plain; charset=utf-8', metadata: { by: 'ann' } })
    expect((await query(res, 'get', { bucket: 'reports', key: 'top.txt', format: 'base64' })).data).toBe(
      Buffer.from('top').toString('base64'),
    )

    await query(res, 'copy', {
      sourceKey: 'nov/stock.json',
      bucket: 'reports',
      key: 'archive/stock copy.json',
    })
    expect(
      (await query(res, 'head', { bucket: 'reports', key: 'archive/stock copy.json' })).data,
    ).toMatchObject({
      size: 21,
      contentType: 'application/json',
    })

    const deleted = await query(res, 'delete', {
      bucket: 'reports',
      keys: 'nov/notes.txt\narchive/stock copy.json',
    })
    expect(deleted.data).toEqual({
      deleted: expect.arrayContaining(['nov/notes.txt', 'archive/stock copy.json']),
      errors: [],
    })
    await query(res, 'delete', { bucket: 'reports', keys: 'top.txt' })
    const left = await query(res, 'list', { bucket: 'reports' })
    expect((left.data as { key: string }[]).map((o) => o.key)).toEqual(['nov/stock.json'])
    expect((await query(res, 'listBuckets', {})).data).toMatchObject([{ name: 'reports' }])
  })

  it('uses the default bucket, and says when there is none', async () => {
    const res = s3({ bucket: 'reports' })
    expect(await testResource(s3Connector, res)).toMatchObject({
      ok: true,
      message: `Bucket reports in ${store.region} is reachable`,
    })
    expect((await query(res, 'head', { key: 'nov/stock.json' })).data).toMatchObject({ bucket: 'reports' })
    await expect(query(s3(), 'head', { key: 'nov/stock.json' })).rejects.toThrow(/Name the bucket/)
  })

  it('reports a missing object with S3’s code', async () => {
    await expect(query(s3(), 'get', { bucket: 'reports', key: 'nope.txt' })).rejects.toThrow(
      /NoSuchKey|not exist|NotFound/i,
    )
  })

  it('presigns URLs that download and upload without credentials, and bounds their life', async () => {
    const res = s3({ bucket: 'reports' })
    const up = await query(res, 'presign', {
      key: 'up/hello.txt',
      method: 'PUT',
      expiresIn: '60',
      contentType: 'text/plain',
    })
    const putUrl = (up.data as { url: string }).url
    expect(putUrl).toContain('X-Amz-Signature=')
    const uploaded = await fetch(putUrl, {
      method: 'PUT',
      body: 'hi from a browser',
      headers: { 'content-type': 'text/plain' },
    })
    expect(uploaded.status).toBe(200)
    const down = await query(res, 'presign', { key: 'up/hello.txt' })
    const got = await fetch((down.data as { url: string }).url)
    expect(await got.text()).toBe('hi from a browser')
    await expect(query(res, 'presign', { key: 'x', expiresIn: '604801' })).rejects.toThrow(/Expires in/)
  })

  it('refuses an object over 10 MB', async () => {
    const res = s3({ bucket: 'reports' })
    await expect(
      query(
        res,
        'put',
        { key: 'big.bin', body: '{{ big }}', format: 'base64' },
        { big: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
      ),
    ).rejects.toThrow(/larger than 10 MB/)
  })
})
