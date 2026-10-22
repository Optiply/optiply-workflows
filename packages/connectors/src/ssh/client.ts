import { Duplex } from 'node:stream'
import { ConnectorError } from '../types'
import { type SshConfig, type SshSecrets, SshSettingsError, sshCredentials } from './settings'
import { SshError, SshTunnel, type SshTunnelOptions } from './tunnel'

/**
 * The tunnel a client of this resource configuration connects through (M17), or none without `ssh`. Made with the
 * client and closed with it: the pool already keys clients by configuration and version.
 */
export function tunnelFor(
  config: { ssh?: SshConfig | undefined },
  secrets: { ssh?: SshSecrets | undefined },
  options?: SshTunnelOptions,
): SshTunnel | undefined {
  if (!config.ssh) return undefined
  let credentials: ReturnType<typeof sshCredentials>
  try {
    credentials = sshCredentials(config.ssh, secrets.ssh)
  } catch (err) {
    if (err instanceof SshSettingsError) throw new ConnectorError('invalid_config', err.message)
    throw err
  }
  return new SshTunnel(
    config.ssh.hops.map((hop) => ({ ...hop, credential: credentials.get(hop.id)! })),
    options,
  )
}

/** A tunnel that couldn't open, as a connection error that says which SSH server and why. */
export function sshConnectionError(err: unknown): ConnectorError | undefined {
  if (!(err instanceof SshError)) return undefined
  return new ConnectorError('connection', err.message, {
    ssh: {
      code: err.code,
      hop: err.hop.id,
      host: err.hop.host,
      ...(err.hostKey ? { hostKey: err.hostKey } : {}),
    },
  })
}

/**
 * A stream to hand over now that becomes `opening`'s once it's there: what's written meanwhile waits, and a failure
 * to open is this stream's error. For drivers that want their socket at once (mysql2's `stream` factory).
 */
export function deferredStream(opening: Promise<Duplex>): Duplex {
  let target: Duplex | undefined
  let ended = false
  const waiting: [chunk: unknown, encoding: BufferEncoding, done: (err?: Error | null) => void][] = []
  const stream = new Duplex({
    read() {
      target?.resume()
    },
    write(chunk, encoding, done) {
      if (target) target.write(chunk, encoding, done)
      else waiting.push([chunk, encoding, done])
    },
    final(done) {
      if (target) target.end(done)
      else {
        ended = true
        done()
      }
    },
    destroy(err, done) {
      target?.destroy()
      done(err)
    },
  })
  opening.then(
    (t) => {
      if (stream.destroyed) return void t.destroy()
      target = t
      t.on('data', (chunk) => {
        if (!stream.push(chunk)) t.pause()
      })
      t.on('end', () => stream.push(null))
      t.on('error', (err) => stream.destroy(err))
      t.on('close', () => stream.destroy())
      for (const [chunk, encoding, done] of waiting.splice(0)) t.write(chunk, encoding, done)
      if (ended) t.end()
    },
    (err) => stream.destroy(sshConnectionError(err) ?? err),
  )
  return stream
}
