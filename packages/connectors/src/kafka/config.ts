import { z } from 'zod'
import { awsIdentityConfig, awsIdentitySecrets } from '../aws/credentials'
import { schemaRegistrySchema } from './registry'

/** A broker's `host:port`. */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/

export const KAFKA_AUTH = ['none', 'plain', 'scram-sha-256', 'scram-sha-512', 'mtls', 'aws-msk-iam'] as const
export type KafkaAuth = (typeof KAFKA_AUTH)[number]

/**
 * A Kafka resource's settings (M26): its bootstrap brokers and how it signs in. `tls` applies to `none` and the SASL
 * mechanisms; mTLS and MSK IAM always use TLS. The AWS identity's fields are read for MSK IAM only.
 */
export const kafkaConfigSchema = z.object({
  brokers: z
    .array(z.string().trim().regex(BROKER, 'A broker is host:port, such as kafka-1.example.com:9092'))
    .min(1, 'Add a broker')
    .max(20),
  auth: z.enum(KAFKA_AUTH).default('none'),
  tls: z.boolean().default(false),
  /** SASL PLAIN and SCRAM's user. */
  username: z.string().trim().min(1).max(255).optional(),
  /** A CA (PEM) to trust besides the system's, for a cluster with its own. */
  caCertificate: z.string().trim().includes('-----BEGIN CERTIFICATE-----').optional(),
  /** mTLS: the client's certificate (PEM; its key is a secret). */
  clientCertificate: z.string().trim().includes('-----BEGIN CERTIFICATE-----').optional(),
  clientId: z.string().trim().min(1).max(255).optional(),
  // MSK IAM: the AWS identity (region, key or the server's own credentials, an assumed role).
  region: awsIdentityConfig.region.optional(),
  identity: awsIdentityConfig.identity,
  accessKeyId: awsIdentityConfig.accessKeyId,
  roleArn: awsIdentityConfig.roleArn,
  externalId: awsIdentityConfig.externalId,
  /** The Schema Registry (M30): triggers decode the Confluent wire format; produce encodes by subject. */
  schemaRegistry: schemaRegistrySchema.optional(),
})

export const kafkaSecretsSchema = z.object({
  /** SASL PLAIN and SCRAM's password. */
  password: z.string().min(1).optional(),
  /** The Schema Registry's password (M30), with its username. */
  schemaRegistryPassword: z.string().min(1).optional(),
  /** mTLS: the client certificate's private key (PEM). */
  clientKey: z.string().trim().includes('PRIVATE KEY-----').optional(),
  ...awsIdentitySecrets,
})

export type KafkaConfig = z.output<typeof kafkaConfigSchema>
export type KafkaSecrets = z.output<typeof kafkaSecretsSchema>

/** What each auth mode needs, as a message for the settings form and Test connection; null when all is there. */
export function kafkaSettingsProblem(config: KafkaConfig, secrets: KafkaSecrets): string | null {
  // M30: a Schema Registry signed in to needs its password.
  if (config.schemaRegistry?.username && !secrets.schemaRegistryPassword)
    return "Add the schema registry's password"
  switch (config.auth) {
    case 'plain':
    case 'scram-sha-256':
    case 'scram-sha-512':
      if (!config.username) return 'Add the username'
      return secrets.password ? null : 'Add the password'
    case 'mtls':
      if (!config.clientCertificate) return 'Add the client certificate (PEM)'
      return secrets.clientKey ? null : "Add the client certificate's private key (PEM)"
    case 'aws-msk-iam':
      return config.region ? null : "Add the cluster's AWS region"
    default:
      return null
  }
}

/** Whether the connection is encrypted: mTLS and MSK IAM always, the others when `tls` says so. */
export function usesTls(config: KafkaConfig): boolean {
  return config.auth === 'mtls' || config.auth === 'aws-msk-iam' || config.tls
}

/**
 * librdkafka's settings for a Kafka resource: brokers, security protocol, SASL or certificates. MSK IAM's token
 * callback is added by the client (`client.ts`).
 */
export function rdkafkaSettings(
  config: KafkaConfig,
  secrets: KafkaSecrets,
): Record<string, string | number | boolean> {
  const tls = usesTls(config)
  const settings: Record<string, string | number | boolean> = {
    'bootstrap.servers': config.brokers.join(','),
    'client.id': config.clientId ?? 'optiply-workflows',
    // librdkafka retries brokers forever; a call fails after these instead.
    'socket.connection.setup.timeout.ms': 10_000,
    'metadata.max.age.ms': 60_000,
  }
  switch (config.auth) {
    case 'none':
      settings['security.protocol'] = tls ? 'ssl' : 'plaintext'
      break
    case 'plain':
    case 'scram-sha-256':
    case 'scram-sha-512':
      settings['security.protocol'] = tls ? 'sasl_ssl' : 'sasl_plaintext'
      settings['sasl.mechanisms'] = config.auth === 'plain' ? 'PLAIN' : config.auth.toUpperCase()
      settings['sasl.username'] = config.username ?? ''
      settings['sasl.password'] = secrets.password ?? ''
      break
    case 'mtls':
      settings['security.protocol'] = 'ssl'
      settings['ssl.certificate.pem'] = config.clientCertificate ?? ''
      settings['ssl.key.pem'] = secrets.clientKey ?? ''
      break
    case 'aws-msk-iam':
      settings['security.protocol'] = 'sasl_ssl'
      settings['sasl.mechanisms'] = 'OAUTHBEARER'
      break
  }
  if (tls && config.caCertificate) settings['ssl.ca.pem'] = config.caCertificate
  return settings
}
