import type { ResolvedBlockSettings } from '@ow/definition'

/**
 * Delay before retry number `retry` (1 = the first retry): `intervalMs`, multiplied by `coefficient` per earlier
 * retry when exponential, never more than `maxIntervalMs`.
 */
export function retryDelayMs(settings: ResolvedBlockSettings['retry'], retry: number): number {
  const base = settings.exponential
    ? settings.intervalMs * settings.coefficient ** (retry - 1)
    : settings.intervalMs
  return Math.min(base, settings.maxIntervalMs)
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
