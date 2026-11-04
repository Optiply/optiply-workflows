import superjson from 'superjson'

/** A failed call: the instance's message, and its HTTP status (0 when it couldn't be reached). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** tRPC's code (`CONFLICT`, `FORBIDDEN`, …), when the instance said. */
    readonly code?: string,
  ) {
    super(message)
  }
}

/**
 * The instance's tRPC API over HTTP (superjson, as the web app speaks it), signed in with a personal access token
 * (M33). Only what the token's scope allows answers: component libraries, `me`, folders.
 */
export class Api {
  readonly url: string

  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.url = url.replace(/\/+$/, '')
  }

  query<T>(path: string, input?: unknown): Promise<T> {
    const qs =
      input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`
    return this.call<T>(`${this.url}/api/trpc/${path}${qs}`, { method: 'GET' })
  }

  mutate<T>(path: string, input?: unknown): Promise<T> {
    return this.call<T>(`${this.url}/api/trpc/${path}`, {
      method: 'POST',
      body: JSON.stringify(superjson.serialize(input ?? null)),
    })
  }

  private async call<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10 * 60_000), // a build or a publish may take minutes
      })
    } catch (err) {
      throw new ApiError(0, `Couldn't reach ${this.url}: ${(err as Error).message}`)
    }
    const text = await res.text()
    let body: {
      result?: { data?: unknown }
      error?: { json?: { message?: string; data?: { code?: string } } }
    }
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(
        res.status,
        `${this.url} answered ${res.status}, not the API (is it the instance's URL?)`,
      )
    }
    if (body.error || !res.ok) {
      const message = body.error?.json?.message ?? `${res.status}`
      throw new ApiError(res.status, message, body.error?.json?.data?.code)
    }
    return superjson.deserialize(body.result?.data as Parameters<typeof superjson.deserialize>[0]) as T
  }
}
