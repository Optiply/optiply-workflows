import { X509Certificate } from 'node:crypto'
import Confluent from '@confluentinc/kafka-javascript'
import { ConnectorError } from '../types'
import { type KafkaConfig, type KafkaSecrets, kafkaSettingsProblem, rdkafkaSettings } from './config'
import { type SchemaRegistry, schemaRegistry } from './registry'

type KafkaJs = InstanceType<typeof Confluent.KafkaJS.Kafka>
export type KafkaAdmin = ReturnType<KafkaJs['admin']>
export type KafkaProducer = ReturnType<KafkaJs['producer']>

/** librdkafka's settings value types, callbacks included (MSK IAM's token). */
export type RdkafkaSettings = Record<string, unknown>

/** A logged line from librdkafka, kept to explain a failure its error doesn't (it says "transport failure"). */
interface LogLine {
  at: number
  text: string
}

/**
 * The client of a Kafka resource's settings (M26): librdkafka's settings, an admin and a producer connected on first
 * use, and the last error lines librdkafka logged. The trigger's consumer makes its own consumer from `settings`.
 */
export interface KafkaResourceClient {
  settings: RdkafkaSettings
  /** Who it signs in as: a SASL user, the client certificate's subject, or (MSK IAM) the AWS identity. */
  who(signal: AbortSignal): Promise<string>
  admin(): Promise<KafkaAdmin>
  producer(): Promise<KafkaProducer>
  /** A KafkaJS-style logger keeping librdkafka's warnings and errors, for clients made from `settings`. */
  logger: object
  /** The latest error lines logged since `since` (ms), most telling first: SASL, TLS, certificates. */
  explain(since: number): string | null
  /** The Schema Registry, when the settings name one (M30). */
  registry?: SchemaRegistry
  close(): Promise<void>
}

/** Options the client is made with: MSK IAM adds its token callback and names the AWS identity (step 3b). */
export interface KafkaClientExtras {
  settings?: RdkafkaSettings
  who?: (signal: AbortSignal) => Promise<string>
}

export function kafkaClient(
  config: KafkaConfig,
  secrets: KafkaSecrets,
  extras: KafkaClientExtras = {},
): KafkaResourceClient {
  const problem = kafkaSettingsProblem(config, secrets)
  if (problem) throw new ConnectorError('invalid_config', problem)
  const settings: RdkafkaSettings = { ...rdkafkaSettings(config, secrets), ...extras.settings }
  const lines: LogLine[] = []
  const keep = (text: string) => {
    lines.push({ at: Date.now(), text })
    if (lines.length > 50) lines.shift()
  }
  const logger = {
    info() {},
    debug() {},
    warn: (message: string) => keep(message),
    error: (message: string) => keep(message),
    namespace() {
      return logger
    },
    setLogLevel() {},
  }
  const kafka = new Confluent.KafkaJS.Kafka({ ...settings, kafkaJS: { logger } } as never)
  let admin: Promise<KafkaAdmin> | undefined
  const registry = config.schemaRegistry
    ? schemaRegistry(config.schemaRegistry, secrets.schemaRegistryPassword)
    : undefined
  let producer: Promise<KafkaProducer> | undefined
  const connect = <T extends { connect(): Promise<void>; disconnect(): Promise<void> }>(
    made: T,
  ): Promise<T> =>
    made.connect().then(
      () => made,
      async (err: unknown) => {
        await made.disconnect().catch(() => {})
        throw err
      },
    )

  return {
    ...(registry && { registry }),
    settings,
    logger,
    who: async (signal) => extras.who?.(signal) ?? describeSignIn(config),
    admin() {
      admin ??= connect(kafka.admin()).catch((err: unknown) => {
        admin = undefined
        throw err
      })
      return admin
    },
    producer() {
      producer ??= connect(kafka.producer({ 'message.timeout.ms': 30_000 } as never)).catch(
        (err: unknown) => {
          producer = undefined
          throw err
        },
      )
      return producer
    },
    explain(since) {
      const recent = lines.filter((l) => l.at >= since).map((l) => l.text)
      const telling =
        recent.findLast((t) => /SASL|authenticat|SSL|certificate|handshake|ACL|authoriz/i.test(t)) ??
        recent.at(-1)
      // `[thrd:sasl_ssl://host:9093/bootstrap]: sasl_ssl://host:9093/bootstrap: Connect to … failed` → from `Connect`.
      return telling
        ? telling.replace(/^\[thrd:[^\]]*\]:\s*/, '').replace(/^\S+\/(bootstrap|\d+):\s*/, '')
        : null
    },
    async close() {
      // Forgotten first: a later call connects afresh rather than using a disconnected one.
      const open = [admin, producer]
      admin = undefined
      producer = undefined
      await Promise.all(open.map((p) => p?.then((c) => c.disconnect()).catch(() => {})))
      await registry?.close()
    },
  }
}

function describeSignIn(config: KafkaConfig): string {
  switch (config.auth) {
    case 'none':
      return config.tls ? 'no sign-in (TLS)' : 'no sign-in'
    case 'plain':
      return `${config.username} (SASL PLAIN${config.tls ? ' over TLS' : ''})`
    case 'scram-sha-256':
    case 'scram-sha-512':
      return `${config.username} (${config.auth.toUpperCase()}${config.tls ? ' over TLS' : ''})`
    case 'mtls':
      try {
        return `client certificate ${new X509Certificate(config.clientCertificate ?? '').subject.replace(/\n/g, ', ')}`
      } catch {
        return 'a client certificate'
      }
    default:
      return 'AWS'
  }
}

/** librdkafka's codes this maps (`err.code`): all brokers down, a transport failure, a timeout. */
const TRANSPORT = new Set([-195, -187])
const TIMED_OUT = -185

/**
 * A Kafka client's error as a `ConnectorError`: a transport failure is `connection`, explained by what librdkafka
 * logged meanwhile (a SASL or TLS failure says so only there); a timeout `timeout`; the rest `query`.
 */
export function kafkaError(
  err: unknown,
  client: Pick<KafkaResourceClient, 'explain'>,
  since: number,
  doing: string,
): ConnectorError {
  if (err instanceof ConnectorError) return err
  const e = err as Error & { code?: number; type?: string }
  const why = client.explain(since)
  if (e.code !== undefined && TRANSPORT.has(e.code))
    return new ConnectorError('connection', `Couldn't ${doing}: ${why ?? 'no broker answered'}`, {
      kafkaError: e.type,
    })
  if (e.code === TIMED_OUT)
    return new ConnectorError('timeout', `Kafka didn't answer in time (${doing})`, { kafkaError: e.type })
  return new ConnectorError(
    'query',
    `Couldn't ${doing}: ${e.message}${why && !e.message.includes(why) ? ` (${why})` : ''}`,
    {
      ...(e.type ? { kafkaError: e.type } : {}),
    },
  )
}

/** A promise given up when `signal` aborts (librdkafka's calls take no signal). */
export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new ConnectorError(
          signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted',
          signal.reason?.name === 'TimeoutError' ? "Kafka didn't answer in time" : 'Stopped',
        ),
      )
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', abort)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(err)
      },
    )
  })
}
