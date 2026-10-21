import { useMutation } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { type MultipartPart, MultipartParts } from '@/components/multipart-parts'
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { isSqlType, PLACEHOLDERS } from '@/lib/resource-types'
import { useTRPC } from '@/lib/trpc'
import { ConnectorErrorNote, type KeyValue, KeyValueEditor, type ResourceDetail, ResultView } from './shared'

type RestBody =
  | { type: 'none' }
  | { type: 'json'; json: string }
  | { type: 'form'; fields: KeyValue[] }
  | { type: 'raw'; raw: string; contentType: string }
  | { type: 'multipart'; parts: MultipartPart[] }

interface Draft {
  sql: string
  rest: { method: string; path: string; params: KeyValue[]; headers: KeyValue[]; body: RestBody }
  scope: string
}

const EMPTY: Draft = {
  sql: 'select * from information_schema.tables limit 10',
  rest: { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } },
  scope: '{\n  \n}',
}

/** Drafts are per resource and per browser; a convenience, so failures to read or write are ignored. */
function loadDraft(resourceId: string): Draft {
  try {
    const raw = localStorage.getItem(`ow:playground:${resourceId}`)
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY
  } catch {
    return EMPTY
  }
}

export function Playground({ resource, environmentId }: { resource: ResourceDetail; environmentId: string }) {
  const trpc = useTRPC()
  const [draft, setDraft] = useState<Draft>(() => loadDraft(resource.id))
  const run = useMutation(trpc.resources.run.mutationOptions())
  const configured = !!resource.environments.find((e) => e.environmentId === environmentId)?.config

  useEffect(() => {
    try {
      localStorage.setItem(`ow:playground:${resource.id}`, JSON.stringify(draft))
    } catch {
      // Storage unavailable (private mode, quota): the draft just isn't remembered.
    }
  }, [draft, resource.id])

  let scope: Record<string, unknown> | undefined
  let scopeError: string | undefined
  try {
    const parsed = draft.scope.trim() ? JSON.parse(draft.scope) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) scope = parsed
    else scopeError = 'Test values must be a JSON object'
  } catch (err) {
    scopeError = `Test values aren't valid JSON: ${(err as Error).message}`
  }

  const execute = () => {
    if (!scope) return
    const query = isSqlType(resource.type) ? { sql: draft.sql } : draft.rest
    run.mutate({ resourceId: resource.id, environmentId, query, scope })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      execute()
    }
  }
  const setRest = (patch: Partial<Draft['rest']>) =>
    setDraft((d) => ({ ...d, rest: { ...d.rest, ...patch } }))

  if (!configured) {
    return (
      <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">
        This resource isn't configured in this environment yet.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-4 lg:col-span-2">
          {isSqlType(resource.type) ? (
            <Field
              label="SQL"
              hint={`{{ expression }} becomes a bind parameter (${PLACEHOLDERS[resource.type] ?? '$1'}); values are never pasted into the SQL.`}
            >
              <Textarea
                rows={10}
                spellCheck={false}
                className="font-mono text-[13px]"
                value={draft.sql}
                onKeyDown={onKeyDown}
                onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
              />
            </Field>
          ) : (
            <RestQueryEditor rest={draft.rest} setRest={setRest} onKeyDown={onKeyDown} />
          )}
        </Card>
        <Card className="space-y-2 p-4">
          <Field
            label="Test values"
            hint={
              <>
                JSON available to <code>{'{{ }}'}</code>, alongside <code>configVars</code> (non-secret) and{' '}
                <code>current_user</code>.
              </>
            }
          >
            <Textarea
              rows={10}
              spellCheck={false}
              className="font-mono text-[13px]"
              value={draft.scope}
              onKeyDown={onKeyDown}
              onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
            />
          </Field>
          {scopeError && <p className="text-xs text-danger">{scopeError}</p>}
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" loading={run.isPending} disabled={!scope} onClick={execute}>
          <Play className="size-4" /> Run
        </Button>
        <span className="text-xs text-muted">⌘/Ctrl + Enter</span>
      </div>

      <ErrorNote error={run.error} />
      {run.data && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={run.data.ok ? 'success' : 'danger'}>{run.data.ok ? 'Success' : 'Failed'}</Badge>
            <span className="text-muted">{run.data.durationMs} ms</span>
            {run.data.ok && <Summary metadata={run.data.metadata} />}
          </div>
          {run.data.ok ? (
            <ResultView data={run.data.data} />
          ) : (
            <ConnectorErrorNote error={run.data.error} onConnected={execute} />
          )}
        </Card>
      )}
    </div>
  )
}

function Summary({ metadata }: { metadata: Record<string, unknown> }) {
  const parts: string[] = []
  if (typeof metadata.status === 'number') parts.push(`HTTP ${metadata.status}`)
  if (typeof metadata.rowCount === 'number') {
    parts.push(`${metadata.command ? `${metadata.command} · ` : ''}${metadata.rowCount} rows`)
  }
  return <span className="text-muted">{parts.join(' · ')}</span>
}

function RestQueryEditor({
  rest,
  setRest,
  onKeyDown,
}: {
  rest: Draft['rest']
  setRest: (patch: Partial<Draft['rest']>) => void
  onKeyDown: (e: KeyboardEvent) => void
}) {
  const body = rest.body
  const hasBody = rest.method !== 'GET' && rest.method !== 'HEAD'
  return (
    <>
      <div className="flex gap-2">
        <Select
          value={rest.method}
          onChange={(e) =>
            setRest({
              method: e.target.value,
              ...(e.target.value === 'GET' || e.target.value === 'HEAD' ? { body: { type: 'none' } } : {}),
            })
          }
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Input
          className="font-mono"
          placeholder="/orders/{{ id }}"
          value={rest.path}
          onKeyDown={onKeyDown}
          onChange={(e) => setRest({ path: e.target.value })}
        />
      </div>
      <Field label="Query parameters">
        <KeyValueEditor rows={rest.params} onChange={(params) => setRest({ params })} />
      </Field>
      <Field label="Headers">
        <KeyValueEditor
          rows={rest.headers}
          onChange={(headers) => setRest({ headers })}
          keyPlaceholder="Header"
        />
      </Field>
      {hasBody && (
        <Field label="Body">
          <div className="space-y-2">
            <Select
              value={body.type}
              onChange={(e) => {
                const type = e.target.value as RestBody['type']
                setRest({
                  body:
                    type === 'json'
                      ? { type, json: '{\n  \n}' }
                      : type === 'form'
                        ? { type, fields: [] }
                        : type === 'raw'
                          ? { type, raw: '', contentType: 'text/plain' }
                          : type === 'multipart'
                            ? { type, parts: [] }
                            : { type: 'none' },
                })
              }}
            >
              <option value="none">None</option>
              <option value="json">JSON</option>
              <option value="form">Form (urlencoded)</option>
              <option value="multipart">Multipart (form-data)</option>
              <option value="raw">Raw</option>
            </Select>
            {body.type === 'json' && (
              <Textarea
                rows={8}
                spellCheck={false}
                className="font-mono text-[13px]"
                value={body.json}
                onKeyDown={onKeyDown}
                onChange={(e) => setRest({ body: { type: 'json', json: e.target.value } })}
              />
            )}
            {body.type === 'form' && (
              <KeyValueEditor
                rows={body.fields}
                onChange={(fields) => setRest({ body: { type: 'form', fields } })}
              />
            )}
            {body.type === 'multipart' && (
              <MultipartParts
                parts={body.parts}
                onChange={(parts) => setRest({ body: { type: 'multipart', parts } })}
              />
            )}
            {body.type === 'raw' && (
              <>
                <Input
                  className="font-mono"
                  value={body.contentType}
                  onChange={(e) => setRest({ body: { ...body, contentType: e.target.value } })}
                />
                <Textarea
                  rows={6}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  value={body.raw}
                  onKeyDown={onKeyDown}
                  onChange={(e) => setRest({ body: { ...body, raw: e.target.value } })}
                />
              </>
            )}
          </div>
        </Field>
      )}
    </>
  )
}
