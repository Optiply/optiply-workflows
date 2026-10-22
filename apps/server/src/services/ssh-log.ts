import { onSshTunnelEvent } from '@ow/connectors'
import type { Logger } from 'pino'

/**
 * Logs this process's SSH tunnels (M17): connected, connected again after a drop, dropped, failed (with the hop and
 * why). Servers as `user@host:port`; never a key, passphrase or password. Returns the way to stop.
 */
export function logSshTunnels(log: Pick<Logger, 'info' | 'warn'>): () => void {
  return onSshTunnelEvent((event) => {
    if (event.type === 'connected') {
      const message = event.reconnect ? 'ssh tunnel connected again' : 'ssh tunnel connected'
      const fields = { servers: event.servers, durationMs: event.durationMs }
      if (event.reconnect) log.warn(fields, message)
      else log.info(fields, message)
    } else if (event.type === 'dropped') {
      log.warn({ servers: event.servers }, 'ssh tunnel dropped')
    } else {
      log.warn(
        { servers: event.servers, hop: event.hop, code: event.code, error: event.message },
        'ssh tunnel failed',
      )
    }
  })
}
