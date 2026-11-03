import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Field, Input, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import type { FieldsProps } from './settings-forms'

/**
 * An OpenAPI resource's document (M29): pasted (JSON or YAML), or fetched from its URL by the server (public
 * addresses only) into the settings. Fetching fills an empty base URL with the document's first server. The rest of
 * the settings are REST's.
 */
export function OpenApiSpecFields(props: FieldsProps & { resourceId: string; environmentId: string }) {
  const trpc = useTRPC()
  const [url, setUrl] = useState(String(props.config.specUrl ?? ''))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const fetchSpec = useMutation(
    trpc.resources.openapiFetch.mutationOptions({
      onSuccess: (out) => {
        if (!out.ok) {
          setNote({ ok: false, text: out.message })
          return
        }
        props.set('spec', out.spec)
        props.set('specUrl', url)
        const server = out.servers[0]
        if (!String(props.config.baseUrl ?? '') && server) {
          props.set('baseUrl', /^https?:\/\//.test(server) ? server : new URL(server, url).toString())
        }
        setNote({
          ok: true,
          text: `${out.title} ${out.version}: ${out.operations} operations. Save to keep it.`,
        })
      },
    }),
  )
  const spec = String(props.config.spec ?? '')
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="openapi-spec">
      <p className="text-sm font-medium">OpenAPI document</p>
      <div className="flex items-end gap-2">
        <Field
          label="Fetch from a URL"
          hint="A public address; the server reads it once and keeps the text here."
        >
          <Input
            value={url}
            disabled={props.disabled}
            placeholder="https://api.example.com/openapi.json"
            data-testid="openapi-spec-url"
            onChange={(e) => setUrl(e.target.value.trim())}
          />
        </Field>
        <Button
          variant="secondary"
          disabled={props.disabled || !url}
          loading={fetchSpec.isPending}
          data-testid="openapi-fetch"
          onClick={() =>
            fetchSpec.mutate({ resourceId: props.resourceId, environmentId: props.environmentId, url })
          }
        >
          Fetch
        </Button>
      </div>
      {note && <p className={note.ok ? 'text-sm text-success' : 'text-sm text-danger'}>{note.text}</p>}
      <Field
        label="Or paste it"
        hint={`OpenAPI 3.0/3.1 or Swagger 2.0, JSON or YAML, up to 5 MB${spec ? ` (now ${(spec.length / 1024).toFixed(0)} KB)` : ''}.`}
      >
        <Textarea
          rows={8}
          spellCheck={false}
          className="font-mono text-xs"
          value={spec.length > 200_000 ? `${spec.slice(0, 200_000)}\n…` : spec}
          readOnly={props.disabled || spec.length > 200_000}
          data-testid="openapi-spec-text"
          onChange={(e) => props.set('spec', e.target.value)}
        />
      </Field>
    </div>
  )
}
