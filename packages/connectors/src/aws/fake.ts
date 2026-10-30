import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A fake AWS for tests (M26): STS (`GetCallerIdentity`, `AssumeRole`) and, from step 2b, SQS, on one local port.
 * Every request's SigV4 signature is checked against the key it names, so a test proves the right secret (or the
 * assumed role's session) signed it. Not AWS: one account, no policies beyond who may assume which role.
 */
export interface FakeAwsOptions {
  /** The account every identity is in. */
  account?: string
}

export interface FakeAwsKey {
  accessKeyId: string
  secretAccessKey: string
  /** For a role's session: the token its requests must carry. */
  sessionToken?: string
  arn: string
  /** When a session's credentials stop working (ms since the epoch). */
  expiresAt?: number
}

export interface FakeAwsRole {
  arn: string
  /** Access key ids (or role ARNs) allowed to assume it; all when left out. */
  trusted?: string[]
  externalId?: string
  /** How long sessions last, in seconds (default 3600). */
  durationSeconds?: number
}

export interface FakeAws {
  url: string
  account: string
  /** A new long-lived key for an IAM user `name`. */
  addUser(name: string): FakeAwsKey
  addRole(name: string, role?: Omit<FakeAwsRole, 'arn'>): FakeAwsRole
  /** Requests by service and action, oldest first, with the ARN that signed each. */
  calls: { service: string; action: string; arn: string }[]
  /** Makes the next `count` calls to `action` fail with `code` (an AWS error name) and HTTP `status`. */
  fail(action: string, code: string, status?: number, count?: number): void
  close(): Promise<void>
  /** Service handlers added by later parts (SQS). */
  readonly handlers: Map<string, ServiceHandler>
}

export type ServiceHandler = (req: SignedRequest, res: ServerResponse) => void | Promise<void>

export interface SignedRequest {
  service: string
  region: string
  /** The signer's key (a user's, or a role session's). */
  key: FakeAwsKey
  headers: IncomingMessage['headers']
  path: string
  body: Buffer
}

export async function startFakeAws(opts: FakeAwsOptions = {}): Promise<FakeAws> {
  const account = opts.account ?? '123456789012'
  const keys = new Map<string, FakeAwsKey>()
  const roles = new Map<string, FakeAwsRole>()
  const failures = new Map<string, { code: string; status: number; count: number }>()
  const calls: FakeAws['calls'] = []
  const handlers = new Map<string, ServiceHandler>()

  function newKey(prefix: string, arn: string, extra: Partial<FakeAwsKey> = {}): FakeAwsKey {
    const key: FakeAwsKey = {
      accessKeyId: prefix + randomBytes(8).toString('hex').toUpperCase(),
      secretAccessKey: randomBytes(30).toString('base64'),
      arn,
      ...extra,
    }
    keys.set(key.accessKeyId, key)
    return key
  }

  handlers.set('sts', (req, res) => {
    const form = new URLSearchParams(req.body.toString('utf8'))
    const action = form.get('Action') ?? ''
    if (action === 'GetCallerIdentity') {
      return xml(
        res,
        200,
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${req.key.arn}</Arn><UserId>${req.key.accessKeyId}</UserId><Account>${account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
      )
    }
    if (action === 'AssumeRole') {
      const role = roles.get(form.get('RoleArn') ?? '')
      const caller = req.key.arn
      const allowed =
        role &&
        (!role.trusted || role.trusted.includes(req.key.accessKeyId) || role.trusted.includes(caller)) &&
        (role.externalId === undefined || role.externalId === form.get('ExternalId'))
      if (!role || !allowed)
        return stsError(
          res,
          403,
          'AccessDenied',
          `User: ${caller} is not authorized to perform: sts:AssumeRole`,
        )
      const session = form.get('RoleSessionName') ?? 'session'
      const name = role.arn.split('/').pop()!
      const seconds = role.durationSeconds ?? 3600
      const temp = newKey('ASIA', `arn:aws:sts::${account}:assumed-role/${name}/${session}`, {
        sessionToken: randomBytes(24).toString('base64'),
        expiresAt: Date.now() + seconds * 1000,
      })
      return xml(
        res,
        200,
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>${temp.accessKeyId}</AccessKeyId><SecretAccessKey>${temp.secretAccessKey}</SecretAccessKey><SessionToken>${temp.sessionToken}</SessionToken><Expiration>${new Date(temp.expiresAt!).toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>${temp.arn}</Arn><AssumedRoleId>AROA${name.toUpperCase()}:${session}</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></AssumeRoleResponse>`,
      )
    }
    return stsError(res, 400, 'InvalidAction', `Could not find operation ${action}`)
  })

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      void handle(req, res, body).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(err))
      })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const signed = verify(req, body, keys)
    if ('error' in signed) {
      const json = String(req.headers['content-type'] ?? '').includes('json')
      return json
        ? jsonError(res, 403, signed.error, signed.message)
        : stsError(res, 403, signed.error, signed.message)
    }
    const action = actionOf(signed.service, req.headers, body)
    calls.push({ service: signed.service, action, arn: signed.key.arn })
    const failure = failures.get(action)
    if (failure && failure.count > 0) {
      failure.count--
      return signed.service === 'sts'
        ? stsError(res, failure.status, failure.code, `Failed on purpose (${failure.code})`)
        : jsonError(res, failure.status, failure.code, `Failed on purpose (${failure.code})`)
    }
    const handler = handlers.get(signed.service)
    if (!handler) return jsonError(res, 400, 'UnknownService', `No fake for ${signed.service}`)
    await handler({ ...signed, headers: req.headers, path: req.url ?? '/', body }, res)
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    account,
    calls,
    handlers,
    addUser(name) {
      return newKey('AKIA', `arn:aws:iam::${account}:user/${name}`)
    },
    addRole(name, role = {}) {
      const full: FakeAwsRole = { arn: `arn:aws:iam::${account}:role/${name}`, ...role }
      roles.set(full.arn, full)
      return full
    },
    fail(action, code, status = 400, count = 1) {
      failures.set(action, { code, status, count })
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The action a request asks for: STS's form `Action`, or a JSON protocol's `X-Amz-Target` (`AmazonSQS.Receive…`). */
function actionOf(service: string, headers: IncomingMessage['headers'], body: Buffer): string {
  const target = headers['x-amz-target']
  if (typeof target === 'string') return target.split('.').pop()!
  if (service === 'sts') return new URLSearchParams(body.toString('utf8')).get('Action') ?? ''
  return ''
}

/**
 * Checks a request's SigV4 signature (AWS's algorithm: the canonical request of the signed headers and the body's
 * hash, signed with keys derived from the secret, date, region and service) and its session token.
 */
function verify(
  req: IncomingMessage,
  body: Buffer,
  keys: Map<string, FakeAwsKey>,
): { service: string; region: string; key: FakeAwsKey } | { error: string; message: string } {
  const auth = req.headers.authorization
  const m = auth?.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/,
  )
  if (!m)
    return { error: 'MissingAuthenticationToken', message: 'Request is missing a SigV4 Authorization header' }
  const [, accessKeyId, date, region, service, signedHeaders, signature] = m as unknown as string[]
  const key = keys.get(accessKeyId!)
  if (!key)
    return {
      error: 'InvalidClientTokenId',
      message: 'The security token included in the request is invalid.',
    }
  if (key.sessionToken !== undefined && req.headers['x-amz-security-token'] !== key.sessionToken)
    return {
      error: 'InvalidClientTokenId',
      message: 'The security token included in the request is invalid.',
    }
  if (key.expiresAt !== undefined && Date.now() > key.expiresAt)
    return { error: 'ExpiredToken', message: 'The security token included in the request is expired' }
  const amzDate = String(req.headers['x-amz-date'] ?? '')
  const [rawPath, rawQuery = ''] = (req.url ?? '/').split('?')
  const query = rawQuery
    .split('&')
    .filter(Boolean)
    .map((p) => p.split('='))
    .sort(([a = '', av = ''], [b = '', bv = '']) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v = '']) => `${k}=${v}`)
    .join('&')
  const names = signedHeaders!.split(';')
  const canonicalHeaders = names
    .map((n) => {
      const value = req.headers[n]
      const text = Array.isArray(value) ? value.join(',') : String(value ?? '')
      return `${n}:${text.trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const payloadHash = String(req.headers['x-amz-content-sha256'] ?? sha256(body))
  const canonical = [req.method, rawPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const kDate = hmac(`AWS4${key.secretAccessKey}`, date!)
  const kSigning = hmac(hmac(hmac(kDate, region!), service!), 'aws4_request')
  const expected = hmac(kSigning, toSign)
  const given = Buffer.from(signature!, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return {
      error: 'SignatureDoesNotMatch',
      message: 'The request signature we calculated does not match the signature you provided.',
    }
  return { service: service!, region: region!, key }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function xml(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/xml' })
  res.end(text)
}

function stsError(res: ServerResponse, status: number, code: string, message: string): void {
  xml(
    res,
    status,
    `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>${randomUUID()}</RequestId></ErrorResponse>`,
  )
}

/** An error in AWS's JSON protocols (SQS): `__type` names it, as the SDK reads it. */
export function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/x-amz-json-1.0',
    'x-amzn-query-error': `${code};Sender`,
  })
  res.end(JSON.stringify({ __type: `com.amazonaws.sqs#${code}`, message }))
}
