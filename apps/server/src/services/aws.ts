import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { awsCredentials, configureAws, describeAws } from '@ow/connectors'
import type { Config } from '../config'

type AwsConfig = Pick<Config, 'AWS_SERVER_IDENTITY' | 'AWS_STS_URL'>

let allowed = false

/**
 * Hands the connectors their AWS settings (M26): the server's own credentials only where AWS_SERVER_IDENTITY=allow,
 * and the fake STS's endpoint in tests. Called once at startup by the API and the worker, like `configureGoogle`.
 */
export function configureAwsServer(config: AwsConfig): void {
  allowed = config.AWS_SERVER_IDENTITY === 'allow'
  configureAws({
    ...(allowed ? { serverCredentials: fromNodeProviderChain() } : {}),
    ...(config.AWS_STS_URL ? { stsEndpoint: config.AWS_STS_URL } : {}),
  })
}

/** What the settings form shows of the server's AWS credentials: whether resources may use them, and whose they are. */
export type AwsIdentityView =
  | { allowed: false }
  | { allowed: true; canChoose: boolean; identity: string | null; error: string | null }

export async function awsIdentityView(user: { isAdmin: boolean }): Promise<AwsIdentityView> {
  if (!allowed) return { allowed: false }
  try {
    // STS answers in any region; the global one names the caller as well as any.
    const arn = await describeAws(
      'us-east-1',
      awsCredentials({ region: 'us-east-1', identity: 'server' }),
      AbortSignal.timeout(5_000),
    )
    return { allowed: true, canChoose: user.isAdmin, identity: arn, error: null }
  } catch (err) {
    return { allowed: true, canChoose: user.isAdmin, identity: null, error: (err as Error).message }
  }
}

/**
 * Why an AWS identity's settings (an AWS resource) couldn't sign in, checked on save: an access
 * key's id and secret for `identity: 'key'`; for the server's credentials, the instance allowing them. Null when fine.
 */
export function awsSettingsProblem(config: unknown, secrets: Record<string, unknown>): string | null {
  const c = (config ?? {}) as { identity?: string; accessKeyId?: string }
  if (c.identity === 'server')
    return allowed
      ? null
      : "This instance doesn't let resources use its own AWS credentials; use an access key"
  if (!c.accessKeyId) return 'Add the access key id'
  return secrets.secretAccessKey ? null : 'Add the secret access key'
}
