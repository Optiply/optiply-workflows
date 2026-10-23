import { Duplex } from 'node:stream'
import { parseServiceAccountKey, type ServerIdentity, serviceAccountTokens } from '../google-auth'
import { ConnectorError } from '../types'
import { type SshConfig, type SshHop, type SshSecrets, SshSettingsError, sshCredentials } from './settings'
import { SshError, SshTunnel, type SshTunnelOptions, type TunnelIap } from './tunnel'

/** This process's IAP settings (M18), set once by the server. */
export interface IapDefaults {
  /** The server's own Google identity, only where the instance allows resources to use it. */
  serverIdentity?: ServerIdentity
  /** IAP's endpoint and Google's token endpoint, for tests. */
  url?: string
  tokenUrl?: string
}

let iapDefaults: IapDefaults = {}

export function configureIap(defaults: IapDefaults): void {
  iapDefaults = defaults
}

const IAP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

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
  const ssh = config.ssh
  let hops: ConstructorParameters<typeof SshTunnel>[0]
  try {
    hops = ssh.hops.map(({ reach, iap, ...hop }) => ({
      ...hop,
      credential: credentials.get(hop.id)!,
      ...(reach === 'iap' && iap ? { iap: iapFor(hop, iap, secrets.ssh?.[hop.id]?.iapKey) } : {}),
    }))
  } catch (err) {
    if (err instanceof SshSettingsError) throw new ConnectorError('invalid_config', err.message)
    throw err
  }
  return new SshTunnel(hops, options)
}

/**
 * Checks the IAP part of SSH settings as they're saved or tested (M18): each IAP hop's service account key is there and
 * is one, or the server's own identity is allowed here. Throws `SshSettingsError` naming the hop; opens nothing.
 */
export function checkSshIap(ssh: SshConfig, secrets: SshSecrets | undefined): void {
  for (const { reach, iap, ...hop } of ssh.hops) {
    if (reach === 'iap' && iap) iapFor(hop, iap, secrets?.[hop.id]?.iapKey)
  }
}

/** How a hop reaches its VM through IAP: the target, and tokens of the key or of the server's own identity. */
function iapFor(
  hop: Pick<SshHop, 'id' | 'host' | 'port'>,
  iap: NonNullable<SshHop['iap']>,
  key: string | undefined,
): TunnelIap {
  const target = {
    project: iap.project,
    zone: iap.zone,
    instance: iap.instance,
    interface: iap.interface,
    port: hop.port,
  }
  const where = `SSH server ${hop.host}`
  const url = iapDefaults.url ? { url: iapDefaults.url } : {}
  if (iap.identity === 'server') {
    const identity = iapDefaults.serverIdentity
    if (!identity)
      throw new SshSettingsError(
        hop.id,
        'iapKey',
        `${where}: this instance doesn't let resources use its own Google identity; use a service account key`,
      )
    return { target, tokens: identity, describe: (signal) => identity.describe(signal), ...url }
  }
  if (!key)
    throw new SshSettingsError(
      hop.id,
      'iapKey',
      `${where}: add the service account key that opens the Google IAP tunnel`,
    )
  let parsed: ReturnType<typeof parseServiceAccountKey>
  try {
    parsed = parseServiceAccountKey(key, `ssh.${hop.id}.iapKey`)
  } catch (err) {
    if (err instanceof ConnectorError)
      throw new SshSettingsError(hop.id, 'iapKey', `${where}: ${err.message}`)
    throw err
  }
  const tokens = serviceAccountTokens(parsed, {
    scope: IAP_SCOPE,
    field: `ssh.${hop.id}.iapKey`,
    ...(iapDefaults.tokenUrl ? { tokenUrl: iapDefaults.tokenUrl } : {}),
  })
  return { target, tokens, describe: async () => parsed.client_email, ...url }
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
