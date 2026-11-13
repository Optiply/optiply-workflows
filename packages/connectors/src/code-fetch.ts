import { Agent, fetch, Headers, type Response } from 'undici'
import { networkError, readBody } from './http'
import { guardedLookup, isPrivateAddress } from './net-guard'
import { ConnectorError } from './types'

/** A request from workflow code's `fetch`, as the sandbox hands it over. */
export interface CodeFetchRequest {
  url: string
  method: string
  headers: [string, string][]
  body: string | null
}

export interface CodeFetchResponse {
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: [string, string][]
  /** Decoded as UTF-8, like `Response.text()`. */
  body: string
}

export interface CodeFetcherOptions {
  /** Allow loopback, private and link-local addresses (development and tests). Off by default. */
  allowPrivateNetwork?: boolean
  /** Default 10 MB. */
  maxResponseBytes?: number
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Set by the HTTP client itself. */
const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
])
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/**
 * Makes the HTTP requests workflow code sends with `fetch`. Unlike a REST resource there's no host allowlist, but
 * private, loopback, link-local (cloud metadata) and other internal addresses are refused: IP literals up front and
 * resolved hostnames when connecting, on every redirect hop (followed by hand; credentials are dropped when a
 * redirect leaves the origin). Bodies are capped. Non-2xx answers are responses, not errors, as in `fetch`.
 * One per process; `close()` on shutdown.
 */
export class CodeFetcher {
  private readonly agent: Agent
  private readonly allowPrivate: boolean
  private readonly maxBytes: number

  constructor(opts: CodeFetcherOptions = {}) {
    this.allowPrivate = opts.allowPrivateNetwork ?? false
    this.maxBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024
    this.agent = new Agent({ connections: 32, connect: this.allowPrivate ? {} : { lookup: guardedLookup } })
  }

  async fetch(request: CodeFetchRequest, signal: AbortSignal): Promise<CodeFetchResponse> {
    const method = request.method.toUpperCase()
    if (!METHODS.has(method))
      throw new ConnectorError('invalid_query', `Unsupported method ${request.method}`)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      throw new ConnectorError('invalid_query', `"${request.url}" isn't an absolute URL`)
    }
    const headers = new Headers()
    for (const [name, value] of request.headers) {
      if (!DROPPED_HEADERS.has(name.toLowerCase())) headers.append(name, value)
    }
    if ((method === 'GET' || method === 'HEAD') && request.body !== null) {
      throw new ConnectorError('invalid_query', `${method} requests can't have a body`)
    }

    const res = await this.send(url, { method, headers, body: request.body ?? undefined }, signal)
    const body = method === 'HEAD' ? Buffer.alloc(0) : await readBody(res.response, this.maxBytes)
    if (method === 'HEAD') await res.response.body?.cancel()
    return {
      status: res.response.status,
      statusText: res.response.statusText,
      url: res.url.toString(),
      redirected: res.redirected,
      headers: [...res.response.headers],
      body: body.toString('utf8'),
    }
  }

  close(): Promise<void> {
    return this.agent.close()
  }

  private check(url: URL) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConnectorError('blocked', `Only http and https URLs are allowed (got ${url.protocol})`)
    }
    // IP literals skip DNS, so the connect-time guard never sees them.
    if (!this.allowPrivate && isPrivateAddress(url.hostname)) {
      throw new ConnectorError('blocked', `${url.hostname} is a private address`)
    }
  }

  private async send(
    url: URL,
    init: { method: string; headers: Headers; body?: string },
    signal: AbortSignal,
  ): Promise<{ response: Response; url: URL; redirected: boolean }> {
    let current = url
    let { method, body } = init
    const headers = new Headers(init.headers)
    for (let hop = 0; ; hop++) {
      this.check(current)
      let response: Response
      try {
        response = await fetch(current, {
          method,
          headers,
          body,
          signal,
          redirect: 'manual',
          dispatcher: this.agent,
        })
      } catch (err) {
        throw networkError(err, current)
      }
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return { response, url: current, redirected: hop > 0 }
      }
      await response.body?.cancel()
      if (hop >= MAX_REDIRECTS)
        throw new ConnectorError('http', `Too many redirects (more than ${MAX_REDIRECTS})`)
      const next = new URL(location, current)
      if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name)
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET'
        body = undefined
        headers.delete('content-type')
      }
      current = next
    }
  }
}
