import type { Response } from 'undici'
import { ConnectorError } from './types'

/** Reads a response body, refusing more than `maxBytes` (by Content-Length, then while streaming). */
export async function readBody(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > maxBytes) {
    await res.body?.cancel()
    throw tooLarge(maxBytes)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (!res.body) return Buffer.alloc(0)
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > maxBytes) {
      await res.body.cancel().catch(() => {})
      throw tooLarge(maxBytes)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function tooLarge(maxBytes: number): ConnectorError {
  return new ConnectorError('too_large', `The response is larger than ${maxBytes} bytes`)
}

/** Maps fetch failures; a blocked lookup surfaces as the `cause` (possibly nested) of undici's TypeError. */
export function networkError(err: unknown, url: URL): unknown {
  if ((err as Error).name === 'AbortError') return err
  for (
    let e = err as { cause?: unknown; code?: string; message?: string } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === 'OW_BLOCKED_ADDRESS') return new ConnectorError('blocked', e.message ?? 'Blocked address')
    // Already ours (an SSH tunnel that couldn't open, M17): it says which server and why.
    if (e instanceof ConnectorError) return e
  }
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  return new ConnectorError(
    'connection',
    `Could not reach ${url.host}: ${cause?.message ?? (err as Error).message}`,
    {
      code: cause?.code,
    },
  )
}
