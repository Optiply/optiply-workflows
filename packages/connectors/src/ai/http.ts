import { type Agent, fetch as undiciFetch } from 'undici'
import { ConnectorError } from '../types'

// One JSON call to an AI API over the platform's HTTP client (M35; shared by OpenAI-compatible and Gemini, M37):
// retried twice on 408/409/429/5xx and connection failures (`retry-after` honoured, at most 30 s), redirects never
// followed (a 3xx could lead past the private-network guard), the API's own error message kept.

const RETRIES = 2

export interface AiRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: unknown
  agent: Agent
  signal: AbortSignal
  timeoutMs: number
  /** Added to an error's message by status, e.g. `{401: ' (check the API key)'}`. */
  hints?: Record<number, string>
  /** What a 3xx should be changed to, in its error ("the base URL"). */
  redirectHint?: string
}

export async function aiRequest<T>(request: AiRequest): Promise<T> {
  const { url, signal } = request
  const deadline = Date.now() + request.timeoutMs
  for (let attempt = 0; ; attempt++) {
    let res: Awaited<ReturnType<typeof undiciFetch>>
    try {
      res = await undiciFetch(url, {
        method: request.method,
        headers: { 'content-type': 'application/json', ...request.headers },
        ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
        dispatcher: request.agent,
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      })
    } catch (err) {
      if (signal.aborted) throw new ConnectorError('aborted', 'The request was cancelled')
      if (Date.now() >= deadline) throw new ConnectorError('timeout', 'The API didn’t answer in time')
      const cause = (err as { cause?: unknown }).cause
      if (cause instanceof Error && /private address|blocked/i.test(cause.message)) {
        throw new ConnectorError(
          'blocked',
          'The API is on a private network: allow private networks in the resource to reach it',
        )
      }
      if (attempt < RETRIES) {
        await wait(500 * 2 ** attempt, signal)
        continue
      }
      throw new ConnectorError(
        'connection',
        `Couldn't reach ${safeUrl(url)}: ${(cause as Error)?.message ?? (err as Error).message}`,
      )
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      throw new ConnectorError(
        'http',
        `The API answered ${res.status}, redirecting to ${res.headers.get('location') ?? 'nowhere'}: use that address as ${request.redirectHint ?? 'the base URL'}`,
        { status: res.status },
      )
    }
    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ConnectorError(
          'http',
          `${safeUrl(url)} answered ${res.status} with something that isn't JSON`,
        )
      }
    }
    if (([408, 409, 429].includes(res.status) || res.status >= 500) && attempt < RETRIES) {
      const after = Number(res.headers.get('retry-after'))
      await wait(
        Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt,
        signal,
      )
      continue
    }
    let message = text.slice(0, 500)
    try {
      const parsed = JSON.parse(text) as
        | { error?: { message?: string } | string }
        | { error?: { message?: string } }[]
      // Google's errors come as an object, or (some proxies) as a list of one.
      const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error
      message = typeof error === 'string' ? error : (error?.message ?? message)
    } catch {}
    throw new ConnectorError(
      'http',
      `The API answered ${res.status}: ${message}${request.hints?.[res.status] ?? ''}`,
      { status: res.status },
    )
  }
}

/** The URL without its query (where some APIs take a key). */
function safeUrl(url: string): string {
  return url.split('?')[0]!
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ConnectorError('aborted', 'The request was cancelled'))
      },
      { once: true },
    )
  })
}
