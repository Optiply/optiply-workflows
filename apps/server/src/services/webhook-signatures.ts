import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Keyring } from '@ow/crypto'
import { configVars, configVarValues, type Db } from '@ow/db'
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  DEFAULT_SIGNED_PAYLOAD,
  parseSignedPayload,
  type SignedPayloadPart,
  WEBHOOK_PRESETS,
  type WebhookSignatureAuth,
} from '@ow/definition'
import { and, eq } from 'drizzle-orm'
import { decryptForRow } from './secrets'

/**
 * HMAC signatures on webhook deliveries (M15, architecture §2.18): the five provider presets and custom ones.
 * Everything is computed over the raw body bytes and compared in constant time.
 */

export interface SignedRequest {
  method: string
  /** The URL the caller used, rebuilt from PUBLIC_URL with the query string (HubSpot and `{url}` sign it). */
  url: string
  /** Node's headers: lowercase names. */
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** Why a signature was refused; recorded with the rejection, never sent to the caller. */
export type SignatureFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_signature'
  | 'expired_timestamp'
  | 'signature_mismatch'

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure; message: string }

const fail = (reason: SignatureFailure, message: string): SignatureCheck => ({ ok: false, reason, message })

type Algorithm = 'sha256' | 'sha1' | 'sha512'
type Encoding = 'hex' | 'base64'

/** How one scheme reads the request: what is signed, and the signatures presented. */
interface Scheme {
  algorithm: Algorithm
  encoding: Encoding
  header: string
  /** Text before each signature, e.g. `sha256=`. */
  prefix: string
  /** The signing time as sent, when the scheme has one (it's signed as sent). */
  timestamp?: (req: SignedRequest, signatureHeader: string) => string | undefined
  /** HubSpot sends milliseconds; the others seconds. */
  timestampUnit?: 'ms'
  /** Several signatures in one header (Stripe's `v1=…,v1=…`); default: the header is one signature. */
  signatures?: (signatureHeader: string) => string[]
  payload: (req: SignedRequest, timestamp: string) => (string | Buffer)[]
}

/**
 * Checks a delivery against a webhook's signature settings, trying each secret (several during a rotation). The
 * tolerance applies both ways, so a timestamp far in the future is refused too.
 */
export function verifyWebhookSignature(
  auth: WebhookSignatureAuth,
  secrets: readonly string[],
  req: SignedRequest,
  now = Date.now(),
): SignatureCheck {
  const scheme = schemeFor(auth)
  const signatureHeader = header(req, scheme.header)
  if (!signatureHeader) return fail('missing_signature', `The ${scheme.header} header is missing`)

  let timestamp = ''
  if (scheme.timestamp) {
    timestamp = scheme.timestamp(req, signatureHeader)?.trim() ?? ''
    if (!/^\d{1,16}$/.test(timestamp)) {
      return fail('missing_timestamp', 'The signing time is missing or not a number')
    }
    const seconds = Number(timestamp) / (scheme.timestampUnit === 'ms' ? 1000 : 1)
    const tolerance = auth.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS
    if (Math.abs(now / 1000 - seconds) > tolerance) {
      return fail(
        'expired_timestamp',
        `The signing time is more than ${tolerance} s away from the server's clock`,
      )
    }
  }

  const presented: Buffer[] = []
  for (const raw of scheme.signatures ? scheme.signatures(signatureHeader) : [signatureHeader.trim()]) {
    if (!raw.startsWith(scheme.prefix)) continue
    const bytes = decode(raw.slice(scheme.prefix.length), scheme.encoding)
    if (bytes) presented.push(bytes)
  }
  if (!presented.length) return fail('malformed_signature', `The ${scheme.header} header isn't a signature`)

  const payload = scheme.payload(req, timestamp)
  for (const secret of secrets) {
    const hmac = createHmac(scheme.algorithm, secret)
    for (const piece of payload) hmac.update(piece)
    const expected = hmac.digest()
    if (presented.some((p) => p.length === expected.length && timingSafeEqual(p, expected)))
      return { ok: true }
  }
  return fail('signature_mismatch', "The signature doesn't match the body and the secret")
}

function schemeFor(auth: WebhookSignatureAuth): Scheme {
  switch (auth.preset) {
    case 'stripe':
      // Stripe-Signature: t=1492774577,v1=5257a8…,v1=…,v0=… (v0 is Stripe's test scheme, ignored).
      return {
        algorithm: 'sha256',
        encoding: 'hex',
        header: WEBHOOK_PRESETS.stripe.header,
        prefix: '',
        timestamp: (_req, value) => stripeFields(value).get('t')?.[0],
        signatures: (value) => stripeFields(value).get('v1') ?? [],
        payload: (req, t) => [`${t}.`, req.body],
      }
    case 'github':
      return {
        algorithm: 'sha256',
        encoding: 'hex',
        header: WEBHOOK_PRESETS.github.header,
        prefix: 'sha256=',
        payload: (req) => [req.body],
      }
    case 'slack':
      return {
        algorithm: 'sha256',
        encoding: 'hex',
        header: WEBHOOK_PRESETS.slack.header,
        prefix: 'v0=',
        timestamp: (req) => header(req, WEBHOOK_PRESETS.slack.timestampHeader!),
        payload: (req, t) => [`v0:${t}:`, req.body],
      }
    case 'hubspot':
      // v3: method + URI + body + timestamp (in milliseconds, as sent).
      return {
        algorithm: 'sha256',
        encoding: 'base64',
        header: WEBHOOK_PRESETS.hubspot.header,
        prefix: '',
        timestamp: (req) => header(req, WEBHOOK_PRESETS.hubspot.timestampHeader!),
        timestampUnit: 'ms',
        payload: (req, t) => [`${req.method}${hubspotUri(req.url)}`, req.body, t],
      }
    case 'shopify':
      return {
        algorithm: 'sha256',
        encoding: 'base64',
        header: WEBHOOK_PRESETS.shopify.header,
        prefix: '',
        payload: (req) => [req.body],
      }
    case 'custom': {
      const parsed = parseSignedPayload(auth.signedPayload ?? DEFAULT_SIGNED_PAYLOAD)
      // The validator refuses a bad payload before a release; treat one as the body alone if it ever gets here.
      const pieces = parsed.ok ? parsed.pieces : [{ part: 'body' as SignedPayloadPart }]
      const timestampHeader = auth.timestampHeader?.toLowerCase()
      return {
        algorithm: auth.algorithm ?? 'sha256',
        encoding: auth.encoding ?? 'hex',
        header: (auth.header ?? '').toLowerCase(),
        prefix: auth.prefix ?? '',
        ...(timestampHeader && { timestamp: (req: SignedRequest) => header(req, timestampHeader) }),
        payload: (req, t) =>
          pieces.map((p) => {
            if ('text' in p) return p.text
            if (p.part === 'body') return req.body
            if (p.part === 'timestamp') return t
            if (p.part === 'method') return req.method
            return req.url
          }),
      }
    }
  }
}

function header(req: SignedRequest, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function stripeFields(value: string): Map<string, string[]> {
  const fields = new Map<string, string[]>()
  for (const item of value.split(',')) {
    const eq = item.indexOf('=')
    if (eq < 0) continue
    const key = item.slice(0, eq).trim()
    fields.set(key, [...(fields.get(key) ?? []), item.slice(eq + 1).trim()])
  }
  return fields
}

const HEX = /^(?:[0-9a-fA-F]{2})+$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function decode(text: string, encoding: Encoding): Buffer | null {
  const trimmed = text.trim()
  if (!(encoding === 'hex' ? HEX : BASE64).test(trimmed)) return null
  return Buffer.from(trimmed, encoding)
}

/** HubSpot signs the URI with these escapes decoded (its v3 documentation lists them). */
const HUBSPOT_DECODED: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
}

function hubspotUri(url: string): string {
  return url.replace(/%(?:3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => HUBSPOT_DECODED[m.toUpperCase()]!)
}

/**
 * The signing secrets in a secret config var for one environment: one per line, so a rotation can accept the old
 * and the new secret for a while. Null when the var doesn't exist, isn't secret, or has no value there.
 */
export async function readSigningSecrets(
  db: Db,
  keyring: Keyring,
  name: string,
  environmentId: string,
): Promise<string[] | null> {
  const [row] = await db
    .select({ isSecret: configVars.isSecret, value: configVarValues })
    .from(configVars)
    .innerJoin(
      configVarValues,
      and(eq(configVarValues.configVarId, configVars.id), eq(configVarValues.environmentId, environmentId)),
    )
    .where(eq(configVars.name, name))
  if (!row?.isSecret || !row.value.valueEncrypted) return null
  const plain = decryptForRow<string>(keyring, 'config_var_values', row.value, row.value.valueEncrypted)
  const secrets = String(plain)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  return secrets.length ? secrets : null
}
