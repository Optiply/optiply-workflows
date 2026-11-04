import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib'
import { z } from 'zod'
import { guardedLookup, isPrivateAddress } from '../net-guard'
import { ConnectorError } from '../types'

// RabbitMQ (M30): an AMQP 0-9-1 connection per resource configuration, a confirm channel for publishing, and plain
// channels for consumers (the trigger's adapter in `packages/engine`).

export const rabbitConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535).optional(),
  vhost: z.string().default('/'),
  username: z.string().trim().min(1),
  tls: z.boolean().default(false),
  /** A CA (PEM) for brokers with their own; empty: the system's. */
  caCertificate: z.string().optional(),
  /** Allow a broker at a private address (inside Optiply's network). Off by default, as REST's. */
  allowPrivateNetwork: z.boolean().default(false),
})
export const rabbitSecretsSchema = z.object({ password: z.string().optional() })

export type RabbitConfig = z.output<typeof rabbitConfigSchema>
export type RabbitSecrets = z.output<typeof rabbitSecretsSchema>

export interface RabbitClient {
  config: RabbitConfig
  /** The connection, opened on first use and again after it closed. */
  connection(): Promise<ChannelModel>
  /** The confirm channel publishes go through. */
  publisher(): Promise<ConfirmChannel>
  /** The broker's product and version, from the connection's properties. */
  server(): Promise<string>
  close(): Promise<void>
}

/** Refuses a host at a private address unless the settings allow it (the address is checked, not just the name). */
async function checkHost(config: RabbitConfig): Promise<void> {
  if (config.allowPrivateNetwork) return
  const addresses = isIP(config.host)
    ? [config.host]
    : (await lookup(config.host, { all: true })).map((a) => a.address)
  const blocked = addresses.find(isPrivateAddress)
  if (blocked)
    throw new ConnectorError(
      'blocked',
      `${config.host} is a private address (${blocked}): allow private network addresses in the settings to reach it`,
    )
}

export function rabbitError(err: unknown, doing: string): ConnectorError {
  if (err instanceof ConnectorError) return err
  const e = err as { code?: number | string; message?: string }
  const message = e.message ?? String(err)
  if (/ACCESS_REFUSED|403/.test(message))
    return new ConnectorError('connection', `RabbitMQ refused the sign-in or the vhost: ${message}`, {
      doing,
    })
  if (/NOT_FOUND|404/.test(message)) return new ConnectorError('query', `RabbitMQ: ${message}`, { doing })
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|socket/i.test(message))
    return new ConnectorError('connection', `Could not reach RabbitMQ to ${doing}: ${message}`)
  return new ConnectorError('query', `RabbitMQ couldn't ${doing}: ${message}`)
}

export function rabbitClient(config: RabbitConfig, secrets: RabbitSecrets): RabbitClient {
  let conn: Promise<ChannelModel> | undefined
  let pub: Promise<ConfirmChannel> | undefined
  const connect = async () => {
    await checkHost(config)
    const c = await amqp.connect(
      {
        protocol: config.tls ? 'amqps' : 'amqp',
        hostname: config.host,
        port: config.port ?? (config.tls ? 5671 : 5672),
        vhost: config.vhost,
        username: config.username,
        password: secrets.password ?? '',
        heartbeat: 30,
      },
      {
        timeout: 10_000,
        // Checked again on the addresses the socket uses: a name that re-resolves to a private one is still refused.
        ...(!config.allowPrivateNetwork && { lookup: guardedLookup }),
        ...(config.tls && config.caCertificate ? { ca: [config.caCertificate] } : {}),
        ...(config.tls ? { servername: config.host } : {}),
      },
    )
    const forget = () => {
      conn = undefined
      pub = undefined
    }
    c.on('close', forget)
    c.on('error', forget)
    return c
  }
  const client: RabbitClient = {
    config,
    connection() {
      conn ??= connect().catch((err) => {
        conn = undefined
        throw rabbitError(err, 'connect')
      })
      return conn
    },
    publisher() {
      pub ??= client
        .connection()
        .then(async (c) => {
          const ch = await c.createConfirmChannel()
          ch.on('close', () => {
            pub = undefined
          })
          ch.on('error', () => {
            pub = undefined
          })
          return ch
        })
        .catch((err) => {
          pub = undefined
          throw rabbitError(err, 'open a channel')
        })
      return pub
    },
    async server() {
      const c = await client.connection()
      const props =
        (c.connection as unknown as { serverProperties?: Record<string, unknown> }).serverProperties ?? {}
      return `${String(props.product ?? 'RabbitMQ')} ${String(props.version ?? '')}`.trim()
    },
    async close() {
      const c = conn
      conn = undefined
      pub = undefined
      if (c) await (await c.catch(() => null))?.close().catch(() => {})
    },
  }
  return client
}
