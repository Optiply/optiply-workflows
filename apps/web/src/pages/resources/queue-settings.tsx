import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { Checkbox, type FieldsProps, Grid, isSet } from './settings-forms'
import { type SecretEdit, SecretField } from './shared'

const appRoute = getRouteApi('/app')

/**
 * The AWS identity (M26), for SQS and Kafka's MSK IAM: the region, an access key or this server's own credentials where
 * the instance allows them (only admins choose them, or change the role used with them), and a role to assume.
 */
function AwsIdentityFields({
  config,
  set,
  secrets,
  edits,
  setEdit,
  disabled,
  uses,
}: FieldsProps & { uses: string }) {
  const trpc = useTRPC()
  const server = useQuery(trpc.resources.awsIdentity.queryOptions()).data
  const canChoose = !!server?.allowed && server.canChoose
  const identity = (config.identity as string | undefined) ?? 'key'
  // Editors keep the server's credentials an admin chose, but can't change the region or role used with them.
  const locked = disabled || (identity === 'server' && !canChoose)
  const text = (key: string, lock = disabled) => ({
    value: String(config[key] ?? ''),
    disabled: lock,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value.trim() || undefined),
  })
  return (
    <>
      <Grid>
        <Field label="Region" hint={`The AWS region ${uses} is in.`}>
          <Input {...text('region', locked)} placeholder="eu-west-1" data-testid="aws-region" />
        </Field>
        <Field
          label="AWS credentials"
          hint="An IAM user's access key, or this server's own (instance role, ~/.aws)."
        >
          <Select
            value={identity}
            disabled={locked}
            data-testid="aws-identity"
            onChange={(e) => set('identity', e.target.value)}
          >
            <option value="key">An access key</option>
            <option value="server" disabled={!canChoose}>
              This server's AWS credentials
            </option>
          </Select>
        </Field>
      </Grid>
      {identity === 'server' ? (
        server &&
        (server.allowed ? (
          <div className="space-y-1 text-xs" data-testid="aws-server-note">
            {server.identity && (
              <p className="text-muted">
                Signs in as <code className="text-ink">{server.identity}</code>
              </p>
            )}
            {server.error && <p className="text-danger">{server.error}</p>}
            {!canChoose && (
              <p className="text-muted">
                Chosen by an admin: only admins can change the region or role used with them.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-danger" data-testid="aws-server-note">
            This instance doesn't let resources use its own AWS credentials (any more): use an access key.
          </p>
        ))
      ) : (
        <>
          {server && !canChoose && (
            <p className="text-xs text-muted">
              {server.allowed
                ? "Only admins can choose this server's own AWS credentials."
                : "This instance doesn't let resources use its own AWS credentials (AWS_SERVER_IDENTITY)."}
            </p>
          )}
          <Grid>
            <Field label="Access key id">
              <Input
                {...text('accessKeyId')}
                className="font-mono"
                placeholder="AKIA…"
                data-testid="aws-access-key-id"
              />
            </Field>
            <Field label="Secret access key" hint="Stored encrypted; never shown again.">
              <SecretField
                isSet={isSet(secrets, 'secretAccessKey')}
                edit={edits.secretAccessKey as SecretEdit}
                onChange={(e) => setEdit('secretAccessKey', e)}
                disabled={disabled}
                placeholder="wJalrXUtnFEMI/K7MDENG/…"
              />
            </Field>
          </Grid>
        </>
      )}
      <Grid>
        <Field
          label="Role to assume"
          hint="Optional: a role assumed with the credentials above (short-lived, other accounts)."
        >
          <Input
            {...text('roleArn', locked)}
            className="font-mono"
            placeholder="arn:aws:iam::123456789012:role/workflows"
            data-testid="aws-role-arn"
          />
        </Field>
        <Field label="External id" hint="If the role's trust policy asks for one.">
          <Input {...text('externalId', locked)} />
        </Field>
      </Grid>
    </>
  )
}

/** An SQS resource's settings (M26): the AWS identity, and (admins only) another endpoint such as LocalStack's. */
export function SqsFields(props: FieldsProps) {
  const { me } = appRoute.useRouteContext()
  const { config, set, disabled } = props
  return (
    <>
      <AwsIdentityFields {...props} uses="the queues" />
      <p className="text-xs text-muted">
        Triggers need sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility and sqs:GetQueueUrl
        on their queues; sending needs sqs:SendMessage.
      </p>
      <Field
        label="Endpoint"
        hint={
          me.isAdmin
            ? 'Optional: another SQS endpoint (LocalStack, ElasticMQ). STS is asked there too. Only admins set it.'
            : 'Another SQS endpoint can only be set by an admin.'
        }
      >
        <Input
          value={String(config.endpoint ?? '')}
          disabled={disabled || !me.isAdmin}
          placeholder="https://sqs.eu-west-1.amazonaws.com"
          data-testid="sqs-endpoint"
          onChange={(e) => set('endpoint', e.target.value.trim() || undefined)}
        />
      </Field>
    </>
  )
}

/**
 * An S3 resource's settings (M29): the AWS identity, a default bucket, and (admins only) another endpoint for
 * S3-compatible stores (MinIO, Cloudflare R2, Google Cloud Storage's interoperability) with path-style addressing.
 */
export function S3Fields(props: FieldsProps) {
  const { me } = appRoute.useRouteContext()
  const { config, set, disabled } = props
  return (
    <>
      <AwsIdentityFields {...props} uses="the buckets" />
      <p className="text-xs text-muted">
        Listing needs s3:ListBucket; reading s3:GetObject; writing s3:PutObject; deleting s3:DeleteObject.
        Presigned URLs act with the identity's rights.
      </p>
      <Field label="Default bucket" hint="Optional: queries that name no bucket use this one.">
        <Input
          value={String(config.bucket ?? '')}
          disabled={disabled}
          placeholder="optiply-exports"
          data-testid="s3-bucket"
          onChange={(e) => set('bucket', e.target.value.trim() || undefined)}
        />
      </Field>
      <Field
        label="Endpoint"
        hint={
          me.isAdmin
            ? 'Optional: an S3-compatible store (MinIO, Cloudflare R2, Google Cloud Storage). Only admins set it.'
            : 'Another endpoint can only be set by an admin.'
        }
      >
        <Input
          value={String(config.endpoint ?? '')}
          disabled={disabled || !me.isAdmin}
          placeholder="https://s3.eu-west-1.amazonaws.com"
          data-testid="s3-endpoint"
          onChange={(e) => set('endpoint', e.target.value.trim() || undefined)}
        />
      </Field>
      <Checkbox
        label="Path-style URLs"
        hint="endpoint/bucket/key instead of bucket.endpoint/key, as most S3-compatible stores need."
        checked={config.forcePathStyle === true}
        disabled={disabled}
        onChange={(v) => set('forcePathStyle', v)}
      />
    </>
  )
}

const KAFKA_AUTH: { value: string; label: string }[] = [
  { value: 'none', label: 'No sign-in' },
  { value: 'plain', label: 'SASL PLAIN (username and password)' },
  { value: 'scram-sha-256', label: 'SASL SCRAM-SHA-256' },
  { value: 'scram-sha-512', label: 'SASL SCRAM-SHA-512' },
  { value: 'mtls', label: 'Client certificate (mTLS)' },
  { value: 'aws-msk-iam', label: 'AWS MSK IAM' },
]

/**
 * A Kafka resource's settings (M26): the bootstrap brokers and how it signs in: none, SASL PLAIN or SCRAM (over TLS
 * when ticked), a client certificate, or AWS MSK IAM; a CA for clusters with their own.
 */
export function KafkaFields(props: FieldsProps) {
  const { config, set, secrets, edits, setEdit, disabled } = props
  const auth = (config.auth as string | undefined) ?? 'none'
  const sasl = auth === 'plain' || auth.startsWith('scram')
  const alwaysTls = auth === 'mtls' || auth === 'aws-msk-iam'
  const brokers = (config.brokers as string[] | undefined) ?? []
  const pem = (key: string) => ({
    value: String(config[key] ?? ''),
    disabled,
    rows: 4,
    spellCheck: false,
    className: 'font-mono text-xs',
    placeholder: '-----BEGIN CERTIFICATE-----',
    onChange: (e: { target: { value: string } }) => set(key, e.target.value.trim() || undefined),
  })
  return (
    <>
      <Field label="Brokers" hint="The bootstrap brokers, host:port, one per line.">
        <Textarea
          rows={3}
          spellCheck={false}
          className="font-mono text-[13px]"
          disabled={disabled}
          data-testid="kafka-brokers"
          placeholder={'kafka-1.example.com:9092\nkafka-2.example.com:9092'}
          value={brokers.join('\n')}
          onChange={(e) =>
            set(
              'brokers',
              e.target.value
                .split('\n')
                .map((b) => b.trim())
                .filter((b, i, all) => b || i === all.length - 1),
            )
          }
          onBlur={() => set('brokers', brokers.filter(Boolean))}
        />
      </Field>
      <Grid>
        <Field label="Sign-in">
          <Select
            value={auth}
            disabled={disabled}
            data-testid="kafka-auth"
            onChange={(e) => set('auth', e.target.value)}
          >
            {KAFKA_AUTH.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Client id" hint="How the brokers name this client in their logs and quotas.">
          <Input
            value={String(config.clientId ?? '')}
            disabled={disabled}
            placeholder="optiply-workflows"
            onChange={(e) => set('clientId', e.target.value.trim() || undefined)}
          />
        </Field>
      </Grid>
      {alwaysTls ? (
        <p className="text-xs text-muted">Always over TLS.</p>
      ) : (
        <Checkbox
          checked={!!config.tls}
          disabled={disabled}
          onChange={(v) => set('tls', v)}
          label="TLS"
          hint="Encrypt the connection (SASL_SSL or SSL listeners). Managed clusters need it."
        />
      )}
      {sasl && (
        <Grid>
          <Field label="Username">
            <Input
              value={String(config.username ?? '')}
              disabled={disabled}
              data-testid="kafka-username"
              onChange={(e) => set('username', e.target.value.trim() || undefined)}
            />
          </Field>
          <Field label="Password" hint="Stored encrypted; never shown again.">
            <SecretField
              isSet={isSet(secrets, 'password')}
              edit={edits.password as SecretEdit}
              onChange={(e) => setEdit('password', e)}
              disabled={disabled}
            />
          </Field>
        </Grid>
      )}
      {auth === 'mtls' && (
        <Grid>
          <Field label="Client certificate" hint="PEM.">
            <Textarea {...pem('clientCertificate')} data-testid="kafka-client-certificate" />
          </Field>
          <Field label="Client key" hint="The certificate's private key (PEM). Stored encrypted.">
            <SecretField
              isSet={isSet(secrets, 'clientKey')}
              edit={edits.clientKey as SecretEdit}
              onChange={(e) => setEdit('clientKey', e)}
              disabled={disabled}
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
          </Field>
        </Grid>
      )}
      {(alwaysTls || !!config.tls) && (
        <Field
          label="CA certificate"
          hint="Optional: a CA (PEM) to trust besides the system's, for a cluster with its own."
        >
          <Textarea {...pem('caCertificate')} data-testid="kafka-ca" />
        </Field>
      )}
      {auth === 'aws-msk-iam' && <AwsIdentityFields {...props} uses="the MSK cluster" />}
    </>
  )
}
