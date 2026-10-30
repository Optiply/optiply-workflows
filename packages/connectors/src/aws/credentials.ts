import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'
import { z } from 'zod'
import { ConnectorError } from '../types'

/** This process's AWS settings (M26), set once by the server, like `configurePubSub`. */
export interface AwsDefaults {
  /**
   * The server's own credentials (the SDK's default chain: environment, `~/.aws`, SSO, web identity, ECS and EC2
   * metadata), only where the instance allows resources to use them (`AWS_SERVER_IDENTITY=allow`).
   */
  serverCredentials?: AwsCredentialIdentityProvider
  /** STS's and SQS's endpoints for every region, for tests (a resource's own `endpoint` wins for SQS). */
  stsEndpoint?: string
  sqsEndpoint?: string
}

let defaults: AwsDefaults = {}

export function configureAws(next: AwsDefaults): void {
  defaults = next
}

export function awsDefaults(): AwsDefaults {
  return defaults
}

/** The AWS identity's settings, shared by SQS and Kafka's MSK IAM. */
export const awsIdentityConfig = {
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'An AWS region, such as eu-west-1'),
  /** An access key kept with the settings, or the server's own credentials (if the instance allows). */
  identity: z.enum(['key', 'server']).default('key'),
  /** The access key's id (not a secret: AWS shows it in logs and consoles), for `identity: 'key'`. */
  accessKeyId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{16,128}$/, 'An access key id, such as AKIA…')
    .optional(),
  /** A role assumed through STS with the identity above: short-lived credentials, other accounts. */
  roleArn: z
    .string()
    .trim()
    .regex(
      /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/,
      'A role ARN, such as arn:aws:iam::123456789012:role/name',
    )
    .optional(),
  /** The external id the role's trust policy asks for, if any. */
  externalId: z.string().trim().min(2).max(1224).optional(),
}

export const awsIdentitySecrets = {
  /** The access key's secret, for `identity: 'key'`. */
  secretAccessKey: z.string().trim().min(1).optional(),
}

export interface AwsIdentity {
  region: string
  identity: 'key' | 'server'
  accessKeyId?: string | undefined
  roleArn?: string | undefined
  externalId?: string | undefined
  secretAccessKey?: string | undefined
}

/**
 * The credentials of an AWS identity: the access key or the server's own, then the role assumed with them (cached by
 * the SDK and renewed before they expire).
 */
export function awsCredentials(identity: AwsIdentity): AwsCredentialIdentityProvider {
  let base: AwsCredentialIdentityProvider
  if (identity.identity === 'server') {
    const server = defaults.serverCredentials
    if (!server)
      throw new ConnectorError(
        'invalid_config',
        "This instance doesn't let resources use its own AWS credentials; use an access key",
      )
    base = server
  } else {
    if (!identity.accessKeyId)
      throw new ConnectorError('invalid_config', 'Add the access key id (accessKeyId)')
    if (!identity.secretAccessKey)
      throw new ConnectorError('invalid_config', 'Add the secret access key (secretAccessKey)')
    const key: AwsCredentialIdentity = {
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
    }
    base = async () => key
  }
  if (!identity.roleArn) return base
  return fromTemporaryCredentials({
    masterCredentials: base,
    params: {
      RoleArn: identity.roleArn,
      RoleSessionName: 'optiply-workflows',
      ...(identity.externalId ? { ExternalId: identity.externalId } : {}),
      DurationSeconds: 3600,
    },
    clientConfig: {
      region: identity.region,
      ...(defaults.stsEndpoint ? { endpoint: defaults.stsEndpoint } : {}),
    },
  })
}

/** Who the credentials are, as STS says (`GetCallerIdentity`): an ARN, for Test connection. */
export async function describeAws(
  region: string,
  credentials: AwsCredentialIdentityProvider,
  signal: AbortSignal,
): Promise<string> {
  const sts = new STSClient({
    region,
    credentials,
    maxAttempts: 2,
    ...(defaults.stsEndpoint ? { endpoint: defaults.stsEndpoint } : {}),
  })
  try {
    const who = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal })
    return who.Arn ?? 'an unnamed identity'
  } catch (err) {
    throw awsError(err, 'sign in')
  } finally {
    sts.destroy()
  }
}

/** Error names that mean the identity, not the request, is wrong. */
const AUTH_ERRORS = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidAccessKeyId',
  'CredentialsProviderError',
  'AuthFailure',
  'MissingAuthenticationToken',
])

/**
 * An AWS SDK error as a `ConnectorError`: `connection` for the identity (with what was being done), `timeout` and
 * `aborted` as such, `query` otherwise; `details.retryable` where the SDK says so (throttling, 5xx).
 */
export function awsError(err: unknown, doing: string): ConnectorError {
  if (err instanceof ConnectorError) return err
  if (!(err instanceof Error)) return new ConnectorError('query', String(err))
  const named = err as Error & {
    Code?: string
    $metadata?: { httpStatusCode?: number }
    $retryable?: unknown
    $fault?: string
  }
  const name = named.Code ?? err.name
  const status = named.$metadata?.httpStatusCode
  if (name === 'AbortError') return new ConnectorError('aborted', 'Stopped')
  if (name === 'TimeoutError') return new ConnectorError('timeout', `AWS didn't answer in time (${doing})`)
  const details = {
    awsError: name,
    ...(status ? { status } : {}),
    ...(named.$retryable || named.$fault === 'server' ? { retryable: true } : {}),
  }
  if (AUTH_ERRORS.has(name) || status === 401 || status === 403)
    return new ConnectorError('connection', `AWS refused to ${doing}: ${err.message} (${name})`, details)
  if (
    (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
    (err as NodeJS.ErrnoException).code === 'ENOTFOUND'
  )
    return new ConnectorError('connection', `Couldn't reach AWS to ${doing}: ${err.message}`, details)
  return new ConnectorError('query', `Couldn't ${doing}: ${err.message} (${name})`, details)
}
