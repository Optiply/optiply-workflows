import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { Field, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { Checkbox, type FieldsProps, Grid, isSet } from './settings-forms'
import { type SecretEdit, SecretField } from './shared'

const appRoute = getRouteApi('/app')

/**
 * The AWS identity (M26), for the S3 resource: the region, an access key or this server's own credentials where
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
