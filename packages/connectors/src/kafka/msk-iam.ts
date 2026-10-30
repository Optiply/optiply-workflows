import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentityProvider, SourceData } from '@smithy/types'

const bytes = (d: SourceData): string | Uint8Array =>
  typeof d === 'string'
    ? d
    : d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)

/** How long a token is good for at most: MSK's 15 minutes. */
const EXPIRY_SECONDS = 900

/** SHA-256 for the SigV4 signer, on Node's crypto (the SDK's own checksum shape: update, then digest). */
class Sha256 {
  private hash: Hash | Hmac
  constructor(secret?: SourceData) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret))
  }
  update(data: SourceData): void {
    this.hash.update(bytes(data))
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest())
  }
  reset(): void {}
}

/** RFC 3986's escaping, as the SDK's query strings use. */
const uriEscape = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface MskIamToken {
  /** The SigV4-presigned `kafka-cluster:Connect` URL, base64url without padding: OAUTHBEARER's token. */
  tokenValue: string
  /** When it expires, in ms since the epoch (librdkafka asks for a new one before). */
  lifetime: number
  principal: string
}

/**
 * An MSK IAM token (M26), as AWS's `aws-msk-iam-sasl-signer-js` makes one: a GET to `kafka.<region>.amazonaws.com/`
 * with `Action=kafka-cluster:Connect`, presigned with SigV4 for the service `kafka-cluster` for 15 minutes (less when
 * the credentials expire sooner), a `User-Agent` added after signing, the URL base64url-encoded.
 */
export async function mskIamToken(
  region: string,
  credentials: AwsCredentialIdentityProvider,
  signingDate: Date = new Date(),
): Promise<MskIamToken> {
  const identity = await credentials()
  const hostname = `kafka.${region}.amazonaws.com`
  const ttl = identity.expiration
    ? Math.min((identity.expiration.getTime() - signingDate.getTime()) / 1000, EXPIRY_SECONDS)
    : EXPIRY_SECONDS
  const signer = new SignatureV4({
    service: 'kafka-cluster',
    region,
    credentials: identity,
    sha256: Sha256,
    applyChecksum: false,
  })
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname,
      path: '/',
      headers: { host: hostname },
      query: { Action: 'kafka-cluster:Connect' },
    },
    { expiresIn: ttl, signingDate },
  )
  const query: Record<string, string> = {
    ...(signed.query as Record<string, string>),
    'User-Agent': 'optiply-workflows',
  }
  const search = Object.keys(query)
    .sort()
    .map((k) => `${uriEscape(k)}=${uriEscape(query[k]!)}`)
    .join('&')
  const url = `https://${hostname}/?${search}`
  const date = query['X-Amz-Date']!
  const signedAt = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(date.slice(9, 11)),
    Number(date.slice(11, 13)),
    Number(date.slice(13, 15)),
  )
  return {
    tokenValue: Buffer.from(url, 'utf8').toString('base64url'),
    lifetime: signedAt + ttl * 1000,
    principal: 'optiply-workflows',
  }
}
