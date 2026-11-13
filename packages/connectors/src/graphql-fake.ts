import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildSchema, GraphQLError, graphql, NoSchemaIntrospectionCustomRule, parse, validate } from 'graphql'

// A GraphQL endpoint for tests (M27): a small shop schema on graphql-js, a bearer token checked, introspection that can
// be turned off, and an error with a path and partial data.

export interface TestGraphql {
  url: string
  token: string
  /** Every request's operation name, variables and headers, oldest first. */
  requests: { operationName: string | null; variables: unknown; headers: IncomingMessage['headers'] }[]
  setIntrospection(on: boolean): void
  stop(): Promise<void>
}

const schema = buildSchema(`
  "An order in the shop"
  type Order {
    id: ID!
    customer: String!
    "Amount in cents"
    amount: Int!
    lines: [Line!]!
    "Fails for order 13, to test partial data"
    risk: Float
  }
  type Line { sku: String!, qty: Int! }
  input OrderInput { customer: String!, amount: Int! }
  type Query {
    order(id: ID!): Order
    orders(customer: String): [Order!]!
  }
  type Mutation {
    createOrder(input: OrderInput!): Order!
  }
`)

export async function startTestGraphql(opts: { token?: string } = {}): Promise<TestGraphql> {
  const token = opts.token ?? 'gql-token'
  const orders = [
    { id: '1', customer: 'acme', amount: 1200, lines: [{ sku: 'A-1', qty: 2 }] },
    { id: '13', customer: 'globex', amount: 500, lines: [] },
  ]
  let introspection = true
  const requests: TestGraphql['requests'] = []
  const root = {
    order: ({ id }: { id: string }) =>
      orders.find((o) => o.id === id) && {
        ...orders.find((o) => o.id === id)!,
        risk: () => {
          if (id === '13') throw new Error('Risk service unavailable')
          return 0.1
        },
      },
    orders: ({ customer }: { customer?: string }) =>
      orders.filter((o) => !customer || o.customer === customer),
    createOrder: ({ input }: { input: { customer: string; amount: number } }) => {
      const order = { id: String(orders.length + 100), ...input, lines: [] }
      orders.push(order)
      return order
    },
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { errors: [{ message: 'POST only' }] })
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { errors: [{ message: 'Unauthorized' }] })
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let payload: { query?: string; variables?: Record<string, unknown>; operationName?: string }
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      return send(400, { errors: [{ message: 'Body is not JSON' }] })
    }
    requests.push({
      operationName: payload.operationName ?? null,
      variables: payload.variables ?? null,
      headers: req.headers,
    })
    if (!introspection) {
      try {
        const errors = validate(schema, parse(payload.query ?? ''), [NoSchemaIntrospectionCustomRule])
        if (errors.length) return send(400, { errors: errors.map((e) => e.toJSON()) })
      } catch (err) {
        if (err instanceof GraphQLError) return send(400, { errors: [err.toJSON()] })
        throw err
      }
    }
    const result = await graphql({
      schema,
      source: payload.query ?? '',
      rootValue: root,
      variableValues: payload.variables ?? null,
      operationName: payload.operationName ?? null,
    })
    send(200, result)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`,
    token,
    requests,
    setIntrospection(on) {
      introspection = on
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
