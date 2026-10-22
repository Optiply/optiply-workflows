import { Copy, KeyRound, Plus, ShieldCheck, ShieldQuestion, Trash2, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Field, Input, Select, Textarea } from '@/components/ui'
import { type SecretEdit, SecretField } from './shared'

/** One SSH server of a tunnel, as stored in the config (M17, architecture §2.20). */
export interface SshHop {
  id: string
  host: string
  port: number
  username: string
  auth: 'key' | 'password'
  hostKey?: { algorithm: string; fingerprint: string }
}
export interface SshConfig {
  hops: SshHop[]
}
/** What the settings show of a stored key: never the key. */
export type SshKeyInfo = { type: string; fingerprint: string; publicKey: string } | { error: string }
/** Secret edits per hop id: `privateKey`, `passphrase`, `password`. */
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
  disabled,
  target,
}: {
  ssh: SshConfig | undefined
  onChange: (ssh: SshConfig | undefined) => void
  mask: SshMask
  edits: SshEdits | undefined
  setEdits: (edits: SshEdits | undefined) => void
  keys: Record<string, SshKeyInfo> | null | undefined
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
                  ? `Connects to ${target}${hops.length > 1 ? `, reached through the jump host${hops.length > 2 ? 's' : ''} above` : ''}.`
                  : index === 0
                    ? 'Connected to first, directly.'
                    : 'Reached through the jump host above.'
              }
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
  onChange,
  onRemove,
  mask,
  edits,
  setEdit,
  keyInfo,
  disabled,
}: {
  hop: SshHop
  label: string
  hint: string
  onChange: (patch: Partial<SshHop>) => void
  onRemove: (() => void) | undefined
  mask: Record<string, unknown> | undefined
  edits: Record<string, SecretEdit> | undefined
  setEdit: (field: string, edit: SecretEdit) => void
  keyInfo: SshKeyInfo | undefined
  disabled: boolean
}) {
  const isSet = (field: string) => !!mask && field in mask
  return (
    <fieldset className="space-y-3 rounded-md bg-canvas p-3" data-testid={`ssh-hop-${hop.id}`}>
      <div className="flex items-center justify-between">
        <legend className="text-sm font-medium">{label}</legend>
        {onRemove && !disabled && (
          <Button size="icon" variant="ghost" title="Remove this jump host" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <p className="-mt-2 text-xs text-muted">{hint}</p>
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

/** A multi-line secret (a private key): pasted or read from a file, never shown once stored. */
function PrivateKeyField({
  isSet,
  edit,
  onChange,
  disabled,
}: {
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
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid="ssh-private-key"
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
          <Button size="sm" variant="ghost" title="Keep the stored key" onClick={() => onChange(undefined)}>
            <X className="size-4" /> Keep the stored key
          </Button>
        )}
      </div>
    </div>
  )
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
