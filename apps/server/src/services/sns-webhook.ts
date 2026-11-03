import { createPublicKey, createVerify, type KeyObject, X509Certificate } from 'node:crypto'
import {
  ConnectorError,
  createHttpClient,
  destroyHttpClient,
  httpRequest,
  restConfigSchema,
} from '@ow/connectors'

/**
 * Amazon SNS deliveries to a webhook (M30, architecture §2.33): the message's signature checked with the certificate
 * at its SigningCertURL, which must be AWS's own (`https://sns.<region>.amazonaws.com/….pem`), the topic one the
 * webhook lists; a SubscriptionConfirmation confirmed by fetching its SubscribeURL (the same host rule).
 */

export interface SnsEnvelope {
  Type: string
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  Subject?: string
  SubscribeURL?: string
  Token?: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  MessageAttributes?: Record<string, { Type: string; Value: string }>
  [key: string]: unknown
}

export type SnsCheck =
  | { ok: true; envelope: SnsEnvelope }
  | { ok: false; reason: 'malformed_signature' | 'signature_mismatch' | 'unknown_topic'; message: string }

let trustedHosts: string[] = []

/** Hosts (host:port) trusted besides AWS's, over http too: tests only (`SNS_CERT_HOSTS`). */
export function configureSnsWebhooks(hosts: string): void {
  trustedHosts = hosts
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

const AWS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

/** Whether a URL SNS gives (its certificate, a SubscribeURL) is AWS's: https on sns.<region>.amazonaws.com. */
export function isSnsUrl(text: string, path?: RegExp): boolean {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (trustedHosts.includes(url.host)) return true
  return (
    url.protocol === 'https:' &&
    AWS_HOST.test(url.hostname) &&
    url.port === '' &&
    (!path || path.test(url.pathname))
  )
}

const certificates = new Map<string, { at: number; key: KeyObject }>()
const CERT_TTL_MS = 24 * 3_600_000

async function fetchText(url: string): Promise<string> {
  const parsed = new URL(url)
  // AWS's hosts are public; a test host is local, so the guard is off for it alone.
  const client = createHttpClient(
    restConfigSchema.parse({
      baseUrl: url,
      allowPrivateNetwork: trustedHosts.includes(parsed.host),
      maxResponseBytes: 64 * 1024,
    }),
    { headers: {}, values: {} },
  )
  try {
    const res = await httpRequest(
      client,
      { method: 'GET', url: parsed },
      { signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) throw new ConnectorError('http', `HTTP ${res.status}`)
    // A certificate comes as application/x-x509-ca-cert or the like, which the HTTP core reads as base64.
    if (res.base64 && typeof res.data === 'string') return Buffer.from(res.data, 'base64').toString('utf8')
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  } finally {
    await destroyHttpClient(client)
  }
}

async function signingKey(url: string): Promise<KeyObject> {
  const known = certificates.get(url)
  if (known && known.at > Date.now() - CERT_TTL_MS) return known.key
  const pem = await fetchText(url)
  const key = pem.includes('BEGIN CERTIFICATE') ? new X509Certificate(pem).publicKey : createPublicKey(pem)
  certificates.set(url, { at: Date.now(), key })
  if (certificates.size > 50) certificates.delete(certificates.keys().next().value!)
  return key
}

/** The text SNS signs: the type's fields in order, each `Name\nvalue\n`. */
export function snsStringToSign(e: SnsEnvelope): string {
  const keys =
    e.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  return keys
    .filter((k) => e[k] !== undefined && e[k] !== null)
    .map((k) => `${k}\n${String(e[k])}\n`)
    .join('')
}

/** Checks a delivery: its shape, its topic, the certificate's host and its signature. */
export async function verifySnsDelivery(body: Buffer, topicArns: readonly string[]): Promise<SnsCheck> {
  let e: SnsEnvelope
  try {
    e = JSON.parse(body.toString('utf8')) as SnsEnvelope
  } catch {
    return { ok: false, reason: 'malformed_signature', message: "The body isn't an SNS message (not JSON)" }
  }
  for (const field of [
    'Type',
    'MessageId',
    'TopicArn',
    'Message',
    'Timestamp',
    'Signature',
    'SigningCertURL',
    'SignatureVersion',
  ])
    if (typeof e[field] !== 'string')
      return { ok: false, reason: 'malformed_signature', message: `The SNS message has no ${field}` }
  if (!topicArns.includes(e.TopicArn))
    return { ok: false, reason: 'unknown_topic', message: `Topic ${e.TopicArn} isn't one this webhook takes` }
  if (!isSnsUrl(e.SigningCertURL, /\.pem$/))
    return {
      ok: false,
      reason: 'malformed_signature',
      message: "The signing certificate isn't on AWS's SNS host",
    }
  if (e.SignatureVersion !== '1' && e.SignatureVersion !== '2')
    return {
      ok: false,
      reason: 'malformed_signature',
      message: `SignatureVersion ${e.SignatureVersion} isn't known`,
    }
  let key: KeyObject
  try {
    key = await signingKey(e.SigningCertURL)
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_signature',
      message: `The signing certificate couldn't be read: ${(err as Error).message}`,
    }
  }
  const verifier = createVerify(e.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
  verifier.update(snsStringToSign(e))
  if (!verifier.verify(key, e.Signature, 'base64'))
    return { ok: false, reason: 'signature_mismatch', message: "The SNS signature doesn't match the message" }
  return { ok: true, envelope: e }
}

/** Confirms a subscription by fetching its SubscribeURL (AWS's host only). */
export async function confirmSnsSubscription(e: SnsEnvelope): Promise<void> {
  if (!e.SubscribeURL || !isSnsUrl(e.SubscribeURL))
    throw new Error("The SubscribeURL isn't on AWS's SNS host")
  await fetchText(e.SubscribeURL)
}

/** What a Notification's run sees: the message parsed when it is JSON, its subject, attributes and ids. */
export function snsRunData(e: SnsEnvelope): Record<string, unknown> {
  let message: unknown = e.Message
  try {
    message = JSON.parse(e.Message)
  } catch {}
  return {
    message,
    ...(e.Subject !== undefined && { subject: e.Subject }),
    attributes: Object.fromEntries(Object.entries(e.MessageAttributes ?? {}).map(([k, v]) => [k, v.Value])),
    messageId: e.MessageId,
    topicArn: e.TopicArn,
    timestamp: e.Timestamp,
  }
}
