import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  exampleOf,
  openapiConnector,
  PoolManager,
  parseOpenApi,
  runQuery,
  testResource,
} from '../src'
import { serializeParameter } from '../src/openapi'
import { codeEvaluator, resource, scopeEvaluator } from './helpers'

// The OpenAPI resource (M29 step 5) against an echo server described by a document with every parameter style.

const SPEC = `
openapi: 3.0.3
info: { title: Stock API, version: '1.2' }
servers:
  - url: https://{region}.stock.example/v1
    variables: { region: { default: eu } }
components:
  parameters:
    Sku: { name: sku, in: path, required: true, schema: { type: string } }
  schemas:
    Item:
      type: object
      required: [sku, qty]
      properties:
        sku: { type: string, example: A-1 }
        qty: { type: integer }
        tags: { type: array, items: { type: string } }
paths:
  /items/{sku}:
    parameters: [{ $ref: '#/components/parameters/Sku' }]
    get:
      operationId: getItem
      tags: [items]
      summary: One item
      parameters:
        - { name: fields, in: query, schema: { type: array, items: { type: string } }, explode: false }
        - { name: X-Shop, in: header, schema: { type: string } }
        - { name: session, in: cookie, schema: { type: string } }
    put:
      operationId: putItem
      tags: [items]
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/Item' } }
  /items:
    get:
      operationId: listItems
      tags: [items]
      parameters:
        - { name: tag, in: query, schema: { type: array, items: { type: string } } }
        - { name: filter, in: query, style: deepObject, explode: true, schema: { type: object } }
        - { name: sku, in: query, schema: { type: string } }
    post:
      operationId: importItems
      requestBody:
        content:
          application/x-www-form-urlencoded: { schema: { type: object } }
          multipart/form-data:
            schema:
              type: object
              properties: { file: { type: string, format: binary }, note: { type: string } }
  /ping:
    head: {}
    delete: { summary: no id }
`

const SWAGGER = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Old API', version: '1' },
  host: 'old.example',
  basePath: '/api',
  schemes: ['https'],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        parameters: [
          {
            name: 'status',
            in: 'query',
            type: 'array',
            items: { type: 'string' },
            collectionFormat: 'pipes',
          },
          { name: 'ids', in: 'query', type: 'array', items: { type: 'integer' }, collectionFormat: 'multi' },
        ],
      },
      post: {
        operationId: 'createOrder',
        consumes: ['application/json'],
        parameters: [{ name: 'order', in: 'body', required: true, schema: { $ref: '#/definitions/Order' } }],
      },
    },
    '/orders/{id}/label': {
      post: {
        operationId: 'uploadLabel',
        parameters: [
          { name: 'id', in: 'path', required: true, type: 'integer' },
          { name: 'file', in: 'formData', type: 'file', required: true },
        ],
      },
    },
  },
  definitions: {
    Order: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', default: 1 } } },
  },
})

let server: Server
let base: string
const pool = new PoolManager()

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.endsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"nope"}')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: [...url.searchParams],
        shop: req.headers['x-shop'] ?? null,
        cookie: req.headers.cookie ?? null,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks).toString(),
      }),
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(async () => {
  await pool.closeAll()
  await new Promise((r) => server.close(r))
})

const api = (spec = SPEC) =>
  resource(
    {
      baseUrl: base,
      auth: { type: 'bearer' },
      allowPrivateNetwork: true,
      spec,
      headers: [],
      params: [],
      allowedHosts: [],
    },
    { bearerToken: 'stock-token' },
    spec.length.toString(),
  )
type Echo = {
  method: string
  path: string
  query: [string, string][]
  shop: string | null
  cookie: string | null
  authorization: string | null
  contentType: string | null
  body: string
}
const call = async (query: object, scope: Record<string, unknown> = {}) =>
  (await runQuery(pool, openapiConnector, api(), query, { evaluate: scopeEvaluator(scope) })).data as Echo

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected a failure')
}

describe('reading documents', () => {
  it('reads an OpenAPI 3 document in YAML: servers, shared parameters, refs, bodies', () => {
    const doc = parseOpenApi(SPEC)
    expect(doc).toMatchObject({
      title: 'Stock API',
      version: '1.2',
      openapi: '3.0.3',
      servers: ['https://eu.stock.example/v1'],
    })
    expect(doc.operations.map((o) => o.id)).toEqual([
      'getItem',
      'putItem',
      'listItems',
      'importItems',
      'DELETE /ping',
      'HEAD /ping',
    ])
    const get = doc.operations[0]!
    expect(get.parameters.map((p) => `${p.in}:${p.name}:${p.style}:${p.explode}`)).toEqual([
      'path:sku:simple:false',
      'query:fields:form:false',
      'header:X-Shop:simple:false',
      'cookie:session:form:true',
    ])
    const put = doc.operations[1]!
    expect(put.body).toMatchObject({
      required: true,
      contentTypes: ['application/json'],
      schema: { required: ['sku', 'qty'] },
    })
    expect(exampleOf(put.body!.schema)).toEqual({ sku: 'A-1', qty: 0, tags: [''] })
  })

  it('reads Swagger 2.0 as OpenAPI 3: host and base path, collection formats, body and form data', () => {
    const doc = parseOpenApi(SWAGGER)
    expect(doc.servers).toEqual(['https://old.example/api'])
    const [list, create, upload] = doc.operations
    expect(list!.parameters.map((p) => `${p.name}:${p.style}:${p.explode}`)).toEqual([
      'status:pipeDelimited:false',
      'ids:form:true',
    ])
    expect(create!.body).toMatchObject({
      required: true,
      contentTypes: ['application/json'],
      schema: { properties: { qty: { default: 1 } } },
    })
    expect(upload!.body).toMatchObject({
      contentTypes: ['multipart/form-data'],
      schema: { required: ['file'] },
    })
  })

  it('joins arrays by their style in every place (Swagger 2.0’s tsv and pipes too)', () => {
    const p = (style: string, where: 'query' | 'header' = 'query') => ({
      name: 'p',
      in: where,
      required: false,
      style,
      explode: false,
    })
    expect(serializeParameter(p('tabDelimited'), ['a', 'b'])).toEqual({ pairs: [['p', 'a\tb']] })
    expect(serializeParameter(p('pipeDelimited', 'header'), ['a', 'b'])).toEqual({ value: 'a|b' })
    expect(serializeParameter(p('simple', 'header'), ['a', 'b'])).toEqual({ value: 'a,b' })
    const swagger = JSON.parse(SWAGGER)
    swagger.paths['/orders'].get.parameters.push({
      name: 'tags',
      in: 'query',
      type: 'array',
      items: { type: 'string' },
      collectionFormat: 'tsv',
    })
    expect(parseOpenApi(JSON.stringify(swagger)).operations[0]!.parameters.at(-1)).toMatchObject({
      style: 'tabDelimited',
      explode: false,
    })
  })

  it('refuses what isn’t an OpenAPI document, and remote refs', () => {
    expect(() => parseOpenApi('{"swagger": "1.2"}')).toThrow(/OpenAPI 3.0 or 3.1/)
    expect(() => parseOpenApi('openapi: [unclosed')).toThrow(/doesn't parse/)
    expect(() =>
      parseOpenApi(
        JSON.stringify({
          openapi: '3.1.0',
          info: {},
          paths: { '/a': { get: { parameters: [{ $ref: 'https://x/p.yaml' }] } } },
        }),
      ),
    ).toThrow(/inside the document/)
  })
})

describe('openapi resource', () => {
  it('tests the connection and counts the operations', async () => {
    expect(await testResource(openapiConnector, api())).toMatchObject({
      ok: true,
      message: 'Stock API 1.2: 6 operations (base URL answered HTTP 200)',
    })
  })

  it('places path, query (form, deepObject), header and cookie parameters by the document', async () => {
    const got = await call(
      {
        operationId: 'getItem',
        parameters: '{"sku": {{ sku }}, "fields": ["qty", "tags"], "X-Shop": "nl", "session": "s 1"}',
      },
      { sku: 'A/1 x' },
    )
    expect(got).toMatchObject({
      method: 'GET',
      path: '/v1/items/A%2F1%20x',
      query: [['fields', 'qty,tags']],
      shop: 'nl',
      cookie: 'session=s%201',
      // Sent, and scrubbed from the result (the API echoed it).
      authorization: 'Bearer [REDACTED]',
    })
    const listed = await call({
      operationId: 'listItems',
      parameters: '{"tag": ["a", "b"], "filter": {"min": 2, "shop": "nl"}, "query:sku": "A-1"}',
    })
    expect(listed.query).toEqual([
      ['tag', 'a'],
      ['tag', 'b'],
      ['filter[min]', '2'],
      ['filter[shop]', 'nl'],
      ['sku', 'A-1'],
    ])
  })

  it('sends JSON, form and multipart bodies in their media types', async () => {
    const put = await call(
      { operationId: 'putItem', parameters: '{"sku": "A-1"}', body: '{"sku": "A-1", "qty": {{ qty }}}' },
      { qty: 4 },
    )
    expect(put).toMatchObject({
      method: 'PUT',
      contentType: 'application/json',
      body: '{"sku":"A-1","qty":4}',
    })
    const form = await call({ operationId: 'importItems', body: '{"sku": "A-1", "tags": ["x", "y"]}' })
    expect(form).toMatchObject({
      contentType: 'application/x-www-form-urlencoded',
      body: 'sku=A-1&tags=x&tags=y',
    })
    const file = {
      base64: Buffer.from('sku,qty\nA-1,4').toString('base64'),
      filename: 'stock.csv',
      contentType: 'text/csv',
    }
    const multi = await call(
      {
        operationId: 'importItems',
        contentType: 'multipart/form-data',
        body: '{"file": {{ file }}, "note": "nightly"}',
      },
      { file },
    )
    expect(multi.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(multi.body).toContain('filename="stock.csv"')
    expect(multi.body).toContain('sku,qty\nA-1,4')
    expect(multi.body).toContain('nightly')
  })

  it('checks parameters and bodies before sending, and reports HTTP errors as REST does', async () => {
    expect((await failure(call({ operationId: 'getItem' }))).message).toBe('Missing: sku')
    expect(
      (await failure(call({ operationId: 'getItem', parameters: '{"sku": "a", "colour": "red"}' }))).message,
    ).toMatch(/no parameter "colour"/)
    expect((await failure(call({ operationId: 'putItem', parameters: '{"sku": "a"}' }))).message).toBe(
      'putItem needs a body',
    )
    expect((await failure(call({ operationId: 'DELETE /ping', body: '{"x": 1}' }))).message).toBe(
      'DELETE /ping takes no body',
    )
    expect(
      (await failure(call({ operationId: 'importItems', contentType: 'text/xml', body: '"<a/>"' }))).message,
    ).toMatch(/takes application\/x-www-form-urlencoded, multipart\/form-data/)
    expect((await failure(call({ operationId: 'nope' }))).message).toBe(
      'The OpenAPI document has no operation "nope"',
    )
    const missing = await failure(call({ operationId: 'getItem', parameters: '{"sku": "missing"}' }))
    expect(missing.details).toMatchObject({ status: 404 })
    expect(
      await runQuery(
        pool,
        openapiConnector,
        api(),
        { operationId: 'HEAD /ping' },
        { evaluate: codeEvaluator({}) },
      ),
    ).toMatchObject({ data: null })
  })

  it('keeps a viewer’s value in its parameter: a path value can’t climb out', async () => {
    const got = (
      await runQuery(
        pool,
        openapiConnector,
        api(),
        { operationId: 'getItem', parameters: '{"sku": {{ sku }}}' },
        { evaluate: codeEvaluator({ sku: '../../admin?x=1' }), untrustedValues: true },
      )
    ).data as Echo
    expect(got.path).toBe('/v1/items/..%2F..%2Fadmin%3Fx%3D1')
    expect(got.query).toEqual([])
  })
})
