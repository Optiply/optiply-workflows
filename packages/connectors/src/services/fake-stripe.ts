import type { Handler } from './fake'

// A fake of Stripe's API for tests (M29): form bodies parsed by Stripe's bracket rules, lists newest first with
// `starting_after`, search with `page`, idempotency keys replayed (and refused for another body), a declined card.

export interface FakeStripe {
  key: string
  /** Objects by kind, then id, in creation order. */
  objects: Map<string, Map<string, Record<string, unknown>>>
  /** Each request's method, path, Idempotency-Key and Stripe-Version / Stripe-Account headers. */
  requests: { method: string; path: string; idempotencyKey?: string; version?: string; account?: string }[]
}

/** Parses `a[b][0]=x&c=y` into nested objects and arrays, as Stripe reads a form. */
export function parseStripeForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = rawKey.split(/\[|\]\[|\]/).filter((p) => p !== '')
    let node: Record<string, unknown> | unknown[] = root
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      const key: string | number = Array.isArray(node) ? Number(part) : part
      if (last) {
        ;(node as Record<string | number, unknown>)[key] = value
        return
      }
      const nextIsIndex = /^\d+$/.test(parts[i + 1]!)
      const existing = (node as Record<string | number, unknown>)[key]
      if (existing === undefined || typeof existing !== 'object') {
        ;(node as Record<string | number, unknown>)[key] = nextIsIndex ? [] : {}
      }
      node = (node as Record<string | number, unknown>)[key] as Record<string, unknown> | unknown[]
    })
  }
  return root
}

const PREFIX: Record<string, string> = {
  customers: 'cus',
  payment_intents: 'pi',
  charges: 'ch',
  invoices: 'in',
  subscriptions: 'sub',
  products: 'prod',
  prices: 'price',
  refunds: 're',
  payment_methods: 'pm',
  coupons: 'co',
  events: 'evt',
}

export function fakeStripe(key = 'sk_test_fake_key'): { state: FakeStripe; handler: Handler } {
  const state: FakeStripe = { key, objects: new Map(), requests: [] }
  const replays = new Map<string, { body: string; status: number; json: unknown }>()
  let seq = 0
  let clock = 1_760_000_000
  const err = (status: number, error: Record<string, unknown>) => ({
    status,
    json: { error },
    headers: { 'request-id': `req_${++seq}` },
  })
  const bucket = (kind: string) => {
    let m = state.objects.get(kind)
    if (!m) {
      m = new Map()
      state.objects.set(kind, m)
    }
    return m
  }
  const matches = (obj: Record<string, unknown>, query: string) =>
    query.split(/\s+AND\s+/i).every((clause) => {
      const meta = /^metadata\["([^"]+)"\]:"([^"]*)"$/.exec(clause.trim())
      if (meta) return (obj.metadata as Record<string, unknown> | undefined)?.[meta[1]!] === meta[2]
      const field = /^(\w+):"([^"]*)"$/.exec(clause.trim())
      if (field) return String(obj[field[1]!] ?? '') === field[2]
      return false
    })

  const handler: Handler = async (req, url, raw) => {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const path = url.pathname.replace(/^\/stripe/, '')
    state.requests.push({
      method: req.method ?? '',
      path,
      ...(req.headers['idempotency-key'] && { idempotencyKey: String(req.headers['idempotency-key']) }),
      ...(req.headers['stripe-version'] && { version: String(req.headers['stripe-version']) }),
      ...(req.headers['stripe-account'] && { account: String(req.headers['stripe-account']) }),
    })
    if (auth !== state.key)
      return err(401, { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_****' })
    const body = raw.toString()
    if (req.method === 'POST' && body && !/x-www-form-urlencoded/.test(req.headers['content-type'] ?? ''))
      return err(400, { type: 'invalid_request_error', message: 'Stripe takes form-encoded bodies' })
    const params =
      req.method === 'POST' ? parseStripeForm(body) : parseStripeForm(url.searchParams.toString())

    const idem = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined
    if (req.method === 'POST' && idem) {
      const seen = replays.get(idem)
      if (seen) {
        if (seen.body !== `${path}\n${body}`)
          return err(400, {
            type: 'idempotency_error',
            message:
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
          })
        return { status: seen.status, json: seen.json, headers: { 'idempotent-replayed': 'true' } }
      }
    }
    const remember = (out: { status: number; json?: unknown; headers?: Record<string, string> }) => {
      if (req.method === 'POST' && idem)
        replays.set(idem, { body: `${path}\n${body}`, status: out.status, json: out.json })
      return out
    }

    if (path === '/v1/balance' && req.method === 'GET')
      return {
        status: 200,
        json: { object: 'balance', livemode: state.key.startsWith('sk_live'), available: [] },
      }

    const m = /^\/v1\/(\w+)(?:\/(search|[\w-]+))?$/.exec(path)
    if (!m || !PREFIX[m[1]!])
      return err(404, {
        type: 'invalid_request_error',
        message: `Unrecognized request URL (${req.method}: ${path})`,
      })
    const kind = m[1]!
    const objects = bucket(kind)

    if (m[2] === 'search' && req.method === 'GET') {
      const all = [...objects.values()].reverse().filter((o) => matches(o, String(params.query ?? '')))
      const start = Number(params.page ?? 0)
      const limit = Number(params.limit ?? 10)
      const data = all.slice(start, start + limit)
      const more = start + limit < all.length
      return {
        status: 200,
        json: {
          object: 'search_result',
          data,
          has_more: more,
          next_page: more ? String(start + limit) : null,
        },
      }
    }
    if (!m[2]) {
      if (req.method === 'GET') {
        let all = [...objects.values()].reverse()
        for (const [k, v] of Object.entries(params)) {
          if (k === 'limit' || k === 'starting_after') continue
          all = all.filter((o) => String(o[k]) === String(v))
        }
        const after = params.starting_after ? all.findIndex((o) => o.id === params.starting_after) + 1 : 0
        const limit = Number(params.limit ?? 10)
        const data = all.slice(after, after + limit)
        return {
          status: 200,
          json: { object: 'list', url: `/v1/${kind}`, data, has_more: after + limit < all.length },
        }
      }
      if (req.method === 'POST') {
        if (params.payment_method === 'pm_card_chargeDeclined')
          return remember(
            err(402, {
              type: 'card_error',
              code: 'card_declined',
              decline_code: 'generic_decline',
              message: 'Your card was declined.',
              param: 'payment_method',
            }),
          )
        const id = `${PREFIX[kind]}_${String(++seq).padStart(6, '0')}`
        const obj = {
          id,
          object: kind.replace(/s$/, ''),
          created: ++clock,
          livemode: false,
          metadata: {},
          ...params,
        }
        objects.set(id, obj)
        return remember({ status: 200, json: obj })
      }
    }
    const id = m[2]!
    const obj = objects.get(id)
    if (!obj)
      return err(404, {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No such ${kind.replace(/s$/, '')}: '${id}'`,
        param: 'id',
      })
    if (req.method === 'GET') return { status: 200, json: obj }
    if (req.method === 'POST') {
      for (const [k, v] of Object.entries(params)) {
        if (v === '') delete obj[k]
        else if (k === 'metadata' && typeof v === 'object')
          obj.metadata = { ...(obj.metadata as object), ...(v as object) }
        else obj[k] = v
      }
      return remember({ status: 200, json: obj })
    }
    if (req.method === 'DELETE') {
      objects.delete(id)
      return { status: 200, json: { id, object: obj.object, deleted: true } }
    }
    return err(405, { type: 'invalid_request_error', message: 'Method not allowed' })
  }
  return { state, handler }
}
