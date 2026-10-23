import { useQuery } from '@tanstack/react-query'
import {
  CircleCheck,
  CircleX,
  Cloud,
  Copy,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { type SecretEdit, SecretField } from './shared'

/** One SSH server of a tunnel, as stored in the config (M17, architecture §2.20). */
export interface SshHop {
  id: string
  /** How the first server is reached (M18): at `host:port` (left out), or through Google Cloud IAP to the VM. */
  reach?: 'direct' | 'iap'
  iap?: SshIap
  host: string
  port: number
  username: string
  auth: 'key' | 'password'
  hostKey?: { algorithm: string; fingerprint: string }
}
export interface SshConfig {
  hops: SshHop[]
}
/** A VM reached through Google Cloud IAP, and whose Google identity opens the tunnel (M18, architecture §2.21). */
export interface SshIap {
  project: string
  zone: string
  instance: string
  interface?: string
  identity: 'key' | 'server'
}
/** What the settings show of a stored key: never the key. */
export type SshKeyInfo = { type: string; fingerprint: string; publicKey: string } | { error: string }
/** What the settings show of a stored IAP key: the service account it signs in as. */
export type IapKeyInfo = { clientEmail: string } | { error: string }
/** Secret edits per hop id: `privateKey`, `passphrase`, `password`, `iapKey`. */
export type SshEdits = Record<string, Record<string, SecretEdit>>
/** Which of each hop's secrets are stored (`{ [hopId]: { privateKey: { set: true } } }`). */
type SshMask = Record<string, Record<string, unknown>> | undefined

/** The SSH server and at most two jump hosts before it. */
const MAX_HOPS = 3

const newHop = (): SshHop => ({
  id: Math.random().toString(36).slice(2, 10),
  host: '',
  port: 22,
  username: '',
  auth: 'key',
})

/**
 * A resource configuration's SSH tunnel: off, or an SSH server reached directly or through jump hosts, each with its
 * key or password. Shown for Postgres, MySQL and REST resources.
 */
export function SshTunnelFields({
  ssh,
  onChange,
  mask,
  edits,
  setEdits,
  keys,
  iapKeys,
  disabled,
  target,
}: {
  ssh: SshConfig | undefined
  onChange: (ssh: SshConfig | undefined) => void
  mask: SshMask
  edits: SshEdits | undefined
  setEdits: (edits: SshEdits | undefined) => void
  keys: Record<string, SshKeyInfo> | null | undefined
  iapKeys: Record<string, IapKeyInfo> | null | undefined
  disabled: boolean
  /** What the last SSH server connects to, in words ("the database", "the API"). */
  target: string
}) {
  const hops = ssh?.hops ?? []
  const setHop = (index: number, patch: Partial<SshHop>) => {
    const next = hops.map((h, i) => {
      if (i !== index) return h
      const updated = { ...h, ...patch }
      // Another server: its trusted key isn't this one's.
      if (
        (patch.host !== undefined && patch.host !== h.host) ||
        (patch.port !== undefined && patch.port !== h.port)
      )
        delete updated.hostKey
      return updated
    })
    onChange({ hops: next })
  }
  const setHopEdit = (id: string, field: string, edit: SecretEdit) =>
    setEdits({ ...edits, [id]: { ...edits?.[id], [field]: edit } })

  return (
    <div className="space-y-4" data-testid="ssh-tunnel">
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-accent"
          checked={!!ssh}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.checked ? { hops: [newHop()] } : undefined)
            if (!e.target.checked) setEdits(undefined)
          }}
        />
        <span>
          <span className="font-medium">Connect through an SSH tunnel</span>
          <span className="block text-xs text-muted">
            For {target} only reachable through an SSH server (a bastion), as with <code>ssh -L</code>. The
            connection is made from here: nothing to start by hand.
          </span>
        </span>
      </label>
      {ssh && (
        <div className="space-y-3 border-l-2 border-divider pl-4">
          {hops.map((hop, index) => (
            <HopFields
              key={hop.id}
              hop={hop}
              label={index === hops.length - 1 ? 'SSH server' : `Jump host ${index + 1}`}
              hint={
                index === hops.length - 1
                  ? hops.length === 1 && hop.reach === 'iap'
                    ? `Reached through Google Cloud IAP; connects to ${target}.`
                    : `Connects to ${target}${hops.length > 1 ? `, reached through the jump host${hops.length > 2 ? 's' : ''} above` : ''}.`
                  : index === 0
                    ? hop.reach === 'iap'
                      ? 'Connected to first, through Google Cloud IAP.'
                      : 'Connected to first, directly.'
                    : 'Reached through the jump host above.'
              }
              first={index === 0}
              onChange={(patch) => setHop(index, patch)}
              onRemove={
                index === hops.length - 1
                  ? undefined
                  : () => onChange({ hops: hops.filter((_, i) => i !== index) })
              }
              mask={mask?.[hop.id]}
              edits={edits?.[hop.id]}
              setEdit={(field, edit) => setHopEdit(hop.id, field, edit)}
              keyInfo={keys?.[hop.id]}
              iapKeyInfo={iapKeys?.[hop.id]}
              disabled={disabled}
            />
          ))}
          {!disabled && hops.length < MAX_HOPS && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange({ hops: [...hops.slice(0, -1), newHop(), ...hops.slice(-1)] })}
            >
              <Plus className="size-4" /> Add a jump host
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function HopFields({
  hop,
  label,
  hint,
  first,
  onChange,
  onRemove,
  mask,
  edits,
  setEdit,
  keyInfo,
  iapKeyInfo,
  disabled,
}: {
  hop: SshHop
  label: string
  hint: string
  /** Only the first server can be reached through IAP: the others are reached through the one before. */
  first: boolean
  onChange: (patch: Partial<SshHop>) => void
  onRemove: (() => void) | undefined
  mask: Record<string, unknown> | undefined
  edits: Record<string, SecretEdit> | undefined
  setEdit: (field: string, edit: SecretEdit) => void
  keyInfo: SshKeyInfo | undefined
  iapKeyInfo: IapKeyInfo | undefined
  disabled: boolean
}) {
  const isSet = (field: string) => !!mask && field in mask
  const viaIap = first && hop.reach === 'iap' && !!hop.iap
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md bg-canvas p-3" data-testid={`ssh-hop-${hop.id}`}>
      <div className="flex items-center justify-between">
        <legend className="text-sm font-medium">{label}</legend>
        {onRemove && !disabled && (
          <Button size="icon" variant="ghost" title="Remove this jump host" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <p className="-mt-2 text-xs text-muted">{hint}</p>
      {first && (
        <Field label="Reach it">
          <Select
            value={viaIap ? 'iap' : 'direct'}
            disabled={disabled}
            data-testid="ssh-reach"
            onChange={(e) =>
              // Through IAP the server is the VM: its name is the host (and another VM, another host key).
              onChange(
                e.target.value === 'iap'
                  ? { reach: 'iap', iap: { project: '', zone: '', instance: '', identity: 'key' }, host: '' }
                  : { reach: undefined, iap: undefined, host: '' },
              )
            }
          >
            <option value="direct">Directly</option>
            <option value="iap">Through Google Cloud IAP</option>
          </Select>
        </Field>
      )}
      {viaIap ? (
        <IapFields
          hop={hop}
          onChange={onChange}
          isSet={isSet('iapKey')}
          edit={edits?.iapKey}
          setEdit={(edit) => setEdit('iapKey', edit)}
          keyInfo={iapKeyInfo}
          disabled={disabled}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_2fr]">
          <Field label="Host">
            <Input
              value={hop.host}
              disabled={disabled}
              placeholder="bastion.optiply.nl"
              onChange={(e) => onChange({ host: e.target.value })}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={String(hop.port)}
              disabled={disabled}
              onChange={(e) => onChange({ port: Number(e.target.value) || 22 })}
            />
          </Field>
          <Field label="User">
            <Input
              value={hop.username}
              disabled={disabled}
              onChange={(e) => onChange({ username: e.target.value })}
            />
          </Field>
        </div>
      )}
      <Field label="Sign in with">
        <Select
          value={hop.auth}
          disabled={disabled}
          onChange={(e) => onChange({ auth: e.target.value as SshHop['auth'] })}
        >
          <option value="key">A private key</option>
          <option value="password">A password</option>
        </Select>
      </Field>
      {hop.auth === 'key' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Private key"
            hint="OpenSSH, PEM or PuTTY (.ppk). Stored encrypted; never shown again."
          >
            <PrivateKeyField
              what="key"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              testId="ssh-private-key"
              isSet={isSet('privateKey')}
              edit={edits?.privateKey}
              onChange={(e) => setEdit('privateKey', e)}
              disabled={disabled}
            />
          </Field>
          <Field label="Passphrase" hint="If the key has one.">
            <SecretField
              isSet={isSet('passphrase')}
              edit={edits?.passphrase}
              onChange={(e) => setEdit('passphrase', e)}
              disabled={disabled}
            />
          </Field>
        </div>
      ) : (
        <Field label="Password">
          <SecretField
            isSet={isSet('password')}
            edit={edits?.password}
            onChange={(e) => setEdit('password', e)}
            disabled={disabled}
          />
        </Field>
      )}
      {hop.auth === 'key' && keyInfo && edits?.privateKey === undefined && <KeyInfo info={keyInfo} />}
      <HostKey
        hostKey={hop.hostKey}
        onForget={disabled ? undefined : () => onChange({ hostKey: undefined })}
      />
    </fieldset>
  )
}

/** A multi-line secret (a private key, a service account key): pasted or read from a file, never shown once stored. */
function PrivateKeyField({
  what,
  placeholder,
  testId,
  isSet,
  edit,
  onChange,
  disabled,
}: {
  what: string
  placeholder: string
  testId: string
  isSet: boolean
  edit: SecretEdit
  onChange: (edit: SecretEdit) => void
  disabled: boolean
}) {
  const file = useRef<HTMLInputElement>(null)
  if ((edit === undefined && isSet) || edit === null) {
    return <SecretField isSet={isSet} edit={edit} onChange={onChange} disabled={disabled} />
  }
  return (
    <div className="space-y-1.5">
      <Textarea
        rows={4}
        className="font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
        value={edit ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      <div className="flex gap-1">
        <input
          ref={file}
          type="file"
          className="hidden"
          onChange={async (e) => {
            const chosen = e.target.files?.[0]
            if (chosen) onChange(await chosen.text())
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => file.current?.click()}>
          <Upload className="size-4" /> From a file
        </Button>
        {isSet && (
          <Button
            size="sm"
            variant="ghost"
            title={`Keep the stored ${what}`}
            onClick={() => onChange(undefined)}
          >
            <X className="size-4" /> Keep the stored {what}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The VM reached through Google Cloud IAP (M18): its project, zone and name, the SSH port on it, and whose Google
 * identity opens the tunnel: a service account key kept here, or this server's own where the instance allows it.
 * Only admins choose the server's identity or point it at another VM; others keep it as it is.
 */
function IapFields({
  hop,
  onChange,
  isSet,
  edit,
  setEdit,
  keyInfo,
  disabled,
}: {
  hop: SshHop
  onChange: (patch: Partial<SshHop>) => void
  isSet: boolean
  edit: SecretEdit
  setEdit: (edit: SecretEdit) => void
  keyInfo: IapKeyInfo | undefined
  disabled: boolean
}) {
  const trpc = useTRPC()
  const server = useQuery(trpc.resources.serverIdentity.queryOptions()).data
  const iap = hop.iap!
  const canChoose = !!server?.allowed && server.canChoose
  // Editors keep the server's identity where an admin chose it, but can't move it to another VM.
  const locked = disabled || (iap.identity === 'server' && !canChoose)
  const setIap = (patch: Partial<SshIap>) =>
    onChange({ iap: { ...iap, ...patch }, ...(patch.instance !== undefined ? { host: patch.instance } : {}) })
  const text = (key: 'project' | 'zone' | 'instance') => ({
    value: iap[key],
    disabled: locked,
    onChange: (e: { target: { value: string } }) => setIap({ [key]: e.target.value }),
  })
  const pastedEmail = typeof edit === 'string' ? clientEmail(edit) : undefined
  return (
    <div className="space-y-3" data-testid="ssh-iap">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Project">
          <Input {...text('project')} placeholder="optiply-production" />
        </Field>
        <Field label="Zone">
          <Input {...text('zone')} placeholder="europe-west4-a" />
        </Field>
        <Field label="Instance" hint="The VM's name.">
          <Input {...text('instance')} placeholder="bastion" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
        <Field label="Port" hint="SSH on the VM.">
          <Input
            type="number"
            value={String(hop.port)}
            disabled={locked}
            onChange={(e) => onChange({ port: Number(e.target.value) || 22 })}
          />
        </Field>
        <Field label="User">
          <Input
            value={hop.username}
            disabled={disabled}
            onChange={(e) => onChange({ username: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Google identity"
        hint="It needs the IAP-secured Tunnel User role on the VM or its project."
      >
        <Select
          value={iap.identity}
          disabled={locked}
          data-testid="iap-identity"
          onChange={(e) => setIap({ identity: e.target.value as SshIap['identity'] })}
        >
          <option value="key">A service account key</option>
          <option value="server" disabled={!canChoose}>
            This server's Google identity
          </option>
        </Select>
      </Field>
      {iap.identity === 'server' ? (
        <ServerIdentityNote server={server} canChoose={canChoose} />
      ) : (
        <>
          {server && !canChoose && (
            <p className="text-xs text-muted" data-testid="iap-server-unavailable">
              {server.allowed
                ? "Only admins can choose this server's own Google identity."
                : "This instance doesn't let resources use its own Google identity (GOOGLE_SERVER_IDENTITY)."}
            </p>
          )}
          <Field label="Service account key" hint="The JSON key file. Stored encrypted; never shown again.">
            <PrivateKeyField
              what="key"
              placeholder='{ "type": "service_account", … }'
              testId="iap-key"
              isSet={isSet}
              edit={edit}
              onChange={setEdit}
              disabled={disabled}
            />
          </Field>
          {pastedEmail !== undefined ? (
            <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="iap-key-info">
              <Cloud className="size-3.5" />
              {pastedEmail ? (
                <>
                  Signs in as <code className="text-ink">{pastedEmail}</code>
                </>
              ) : (
                "This doesn't look like a service account key (JSON with a client_email)."
              )}
            </p>
          ) : (
            keyInfo &&
            edit === undefined &&
            ('error' in keyInfo ? (
              <p className="text-xs text-danger">The stored key can't be read: {keyInfo.error}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="iap-key-info">
                <Cloud className="size-3.5" /> Signs in as{' '}
                <code className="text-ink">{keyInfo.clientEmail}</code>
              </p>
            ))
          )}
        </>
      )}
    </div>
  )
}

/** Whose identity the server's is, or why it has none; for editors, that an admin chose it. */
function ServerIdentityNote({
  server,
  canChoose,
}: {
  server: { allowed: boolean; identity?: string | null; error?: string | null } | undefined
  canChoose: boolean
}) {
  if (!server) return null
  if (!server.allowed)
    return (
      <p className="text-xs text-danger" data-testid="iap-server-note">
        This instance doesn't let resources use its own Google identity (any more): choose a service account
        key.
      </p>
    )
  return (
    <div className="space-y-1 text-xs" data-testid="iap-server-note">
      {server.identity && (
        <p className="flex items-center gap-1.5 text-muted">
          <Cloud className="size-3.5" /> Signs in as <code className="text-ink">{server.identity}</code>
        </p>
      )}
      {server.error && <p className="text-danger">{server.error}</p>}
      {!canChoose && (
        <p className="text-muted">Chosen by an admin: only admins can point it at another VM.</p>
      )}
    </div>
  )
}

/** A pasted service account key's `client_email`; '' when it isn't one, undefined while nothing is pasted. */
function clientEmail(text: string): string | undefined {
  if (!text.trim()) return undefined
  try {
    const email = (JSON.parse(text) as { client_email?: unknown }).client_email
    return typeof email === 'string' ? email : ''
  } catch {
    return ''
  }
}

/** The stored key's type, fingerprint and public half (for the server's authorized_keys). */
function KeyInfo({ info }: { info: SshKeyInfo }) {
  const [copied, setCopied] = useState(false)
  if ('error' in info)
    return <p className="text-xs text-danger">The stored key can't be read: {info.error}</p>
  return (
    <div className="space-y-1 text-xs" data-testid="ssh-key-info">
      <p className="flex items-center gap-1.5 text-muted">
        <KeyRound className="size-3.5" />
        {info.type} key <code className="text-ink">{info.fingerprint}</code>
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-subtle px-2 py-1" title={info.publicKey}>
          {info.publicKey}
        </code>
        <Button
          size="sm"
          variant="ghost"
          title="Copy the public key, for the SSH server's authorized_keys"
          onClick={() =>
            void navigator.clipboard.writeText(info.publicKey).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy public key'}
        </Button>
      </div>
    </div>
  )
}

/** The server's trusted host key, or that none is trusted yet. */
function HostKey({ hostKey, onForget }: { hostKey: SshHop['hostKey']; onForget: (() => void) | undefined }) {
  if (!hostKey) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="ssh-host-key">
        <ShieldQuestion className="size-3.5" /> Host key not trusted yet: Test connection shows the server's
        key to check and trust.
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="ssh-host-key">
      <ShieldCheck className="size-3.5 text-success" /> Trusted host key ({hostKey.algorithm}){' '}
      <code className="text-ink">{hostKey.fingerprint}</code>
      {onForget && (
        <Button size="sm" variant="ghost" onClick={onForget}>
          Forget
        </Button>
      )}
    </p>
  )
}

/** One SSH hop as Test connection reports it. */
export interface SshTestStep {
  hop: string
  host: string
  port: number
  ok: boolean
  durationMs: number
  hostKey?: {
    algorithm: string
    fingerprint: string
    status: 'trusted' | 'untrusted' | 'changed'
    trusted?: string
  }
  error?: { code: string; message: string }
  /** The step that reaches the first server through Google Cloud IAP (M18): `host` is the VM, `hop` the first's. */
  via?: 'iap'
  /** Whose Google identity opened the IAP tunnel, where known. */
  identity?: string
}

/**
 * Test connection's SSH hops, one line each: reached or not, how long it took, the host key it presented. An untrusted
 * key can be trusted here (it goes into the settings, saved with them); a changed one only after a warning. Through
 * Google Cloud IAP, a line for IAP comes first: the VM and whose identity opened it.
 */
export function SshTestSteps({
  steps,
  hops,
  onTrust,
  disabled,
}: {
  steps: SshTestStep[]
  hops: SshHop[]
  onTrust: (hop: string, hostKey: { algorithm: string; fingerprint: string }) => void
  disabled: boolean
}) {
  // The VM as project/zone/instance, as the settings name it.
  const iapTarget = (step: SshTestStep) => {
    const iap = hops.find((h) => h.id === step.hop)?.iap
    return iap ? `${iap.project}/${iap.zone}/${iap.instance}` : step.host
  }
  const label = (id: string) => {
    const index = hops.findIndex((h) => h.id === id)
    return index === hops.length - 1 ? 'SSH server' : `Jump host ${index + 1}`
  }
  return (
    <ul className="space-y-2" data-testid="ssh-test-steps">
      {steps.map((step) => (
        <li
          key={`${step.hop}${step.via ? `-${step.via}` : ''}`}
          className="space-y-1 text-sm"
          data-testid={`ssh-step-${step.hop}${step.via ? `-${step.via}` : ''}`}
        >
          <p
            className={
              step.ok ? 'flex items-center gap-2 text-success' : 'flex items-center gap-2 text-danger'
            }
          >
            {step.ok ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />}
            {step.via === 'iap' ? (
              <>
                Google Cloud IAP to {iapTarget(step)}:{step.port}
                {step.identity && <span className="text-muted">· as {step.identity}</span>}
              </>
            ) : (
              <>
                {label(step.hop)} {step.host}:{step.port}
              </>
            )}
            <span className="text-muted">· {step.durationMs} ms</span>
          </p>
          {step.error && !step.hostKey?.status.match(/untrusted|changed/) && (
            <p className="pl-6 text-danger">{step.error.message}</p>
          )}
          {step.hostKey && <HostKeyResult step={step} onTrust={onTrust} disabled={disabled} />}
        </li>
      ))}
    </ul>
  )
}

function HostKeyResult({
  step,
  onTrust,
  disabled,
}: {
  step: SshTestStep
  onTrust: (hop: string, hostKey: { algorithm: string; fingerprint: string }) => void
  disabled: boolean
}) {
  const key = step.hostKey!
  const trust = () => onTrust(step.hop, { algorithm: key.algorithm, fingerprint: key.fingerprint })
  if (key.status === 'trusted')
    return (
      <p className="flex items-center gap-1.5 pl-6 text-xs text-muted">
        <ShieldCheck className="size-3.5 text-success" /> Host key trusted <code>{key.fingerprint}</code>
      </p>
    )
  if (key.status === 'untrusted')
    return (
      <div className="space-y-1.5 rounded-md bg-canvas p-2.5 pl-6 text-xs">
        <p className="flex items-center gap-1.5">
          <ShieldQuestion className="size-3.5" /> The server presented this host key ({key.algorithm}):
        </p>
        <code className="block text-sm text-ink" data-testid="ssh-presented-key">
          {key.fingerprint}
        </code>
        <p className="text-muted">
          Check it with whoever runs the server (on it:{' '}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_{shortType(key.algorithm)}_key.pub</code>), then trust it.
        </p>
        {!disabled && (
          <Button size="sm" variant="primary" onClick={trust}>
            Trust this key
          </Button>
        )}
      </div>
    )
  return (
    <div className="space-y-1.5 rounded-md bg-op-red-1 p-2.5 pl-6 text-xs text-op-red-4">
      <p className="flex items-center gap-1.5 font-medium">
        <ShieldAlert className="size-3.5" /> This server's host key changed
      </p>
      <p>
        Trusted: <code>{key.trusted}</code>
        <br />
        Presented: <code data-testid="ssh-presented-key">{key.fingerprint}</code>
      </p>
      <p>
        If the server was reinstalled or its keys replaced, check the new key and trust it. Otherwise
        something may be between here and the server: don't.
      </p>
      {!disabled && (
        <Button size="sm" variant="danger" onClick={trust}>
          Trust the new key
        </Button>
      )}
    </div>
  )
}

/** `ssh-ed25519` → `ed25519`, `ecdsa-sha2-nistp256` → `ecdsa`, `ssh-rsa`/`rsa-sha2-*` → `rsa`: sshd's key file names. */
function shortType(algorithm: string): string {
  if (algorithm.includes('ed25519')) return 'ed25519'
  if (algorithm.startsWith('ecdsa')) return 'ecdsa'
  return 'rsa'
}
