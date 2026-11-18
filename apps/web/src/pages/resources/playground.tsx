import { defaultActionQuery, isServiceType } from '@ow/connectors/actions'
import { useMutation } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { ActionQueryForm, type RequestAuth, RequestAuthFields } from '@/components/action-query'
import { GraphqlApiTargetFields } from '@/components/graphql-api-target'
import { type MultipartPart, MultipartParts } from '@/components/multipart-parts'
import { OpenApiQueryForm } from '@/components/openapi-query'
import { SqlSchemaPanel } from '@/components/sql-schema-panel'
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { useGraphqlApiSchema } from '@/lib/graphql-schema'
import { useOpenApiOperations } from '@/lib/openapi-operations'
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQLAPI_QUERY,
  PLACEHOLDERS,
  queryKind,
} from '@/lib/resource-types'
import { useSqlSchema } from '@/lib/sql-schema'
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
  /** The built-in REST API's request (M27): a full URL and its own sign-in. */
  restapi: Draft['rest'] & { url: string; auth: { type: string; [key: string]: string } }
  graphql: { query: string; variables: string; operationName: string; headers: KeyValue[] }
  /** The built-in GraphQL resource's query (session 57): GraphQL's, with the endpoint's URL and its own sign-in. */
  graphqlapi: Draft['graphql'] & { url: string; auth: RequestAuth }
  /** An OpenAPI resource's operation call (M29). */
  openapi: { operationId: string; parameters: string; body: string; contentType: string }
  /** A service's action query (M27), per type. */
  services: Record<string, Record<string, unknown>>
  scope: string
}

const EMPTY: Draft = {
  sql: 'select * from information_schema.tables limit 10',
  rest: { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } },
  restapi: {
    method: 'GET',
    path: '',
    url: 'https://',
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
  graphql: { ...DEFAULT_GRAPHQL_QUERY, headers: [] },
  graphqlapi: { ...structuredClone(DEFAULT_GRAPHQLAPI_QUERY), headers: [] },
  openapi: { operationId: '', parameters: '{}', body: '', contentType: '' },
  services: {},
  scope: '{\n  \n}',
}

/** A first query in each SQL dialect that has no `LIMIT` (M38). */
const STARTER_SQL: Record<string, string> = {
  mssql: 'SELECT TOP 10 * FROM INFORMATION_SCHEMA.TABLES',
  // Oracle (23ai), Snowflake and ClickHouse all take it.
  jdbc: 'SELECT 1 AS ok',
}

/** Drafts are per resource and per browser; a convenience, so failures to read or write are ignored. */
function loadDraft(resourceId: string, type: string): Draft {
  const empty = STARTER_SQL[type] ? { ...EMPTY, sql: STARTER_SQL[type] } : EMPTY
  try {
    const raw = localStorage.getItem(`ow:playground:${resourceId}`)
    return raw ? { ...empty, ...JSON.parse(raw) } : empty
  } catch {
    return empty
  }
}

export function Playground({ resource, environmentId }: { resource: ResourceDetail; environmentId: string }) {
  const trpc = useTRPC()
  const [draft, setDraft] = useState<Draft>(() => loadDraft(resource.id, resource.type))
  const run = useMutation(trpc.resources.run.mutationOptions())
  const configured = !!resource.environments.find((e) => e.environmentId === environmentId)?.config
  const kind = queryKind(resource.type)
  const openapi = useOpenApiOperations(kind === 'openapi' ? resource : undefined, environmentId)

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
    const query =
      kind === 'sql'
        ? { sql: draft.sql }
        : kind === 'restapi'
          ? (({ path: _path, ...rest }) => rest)(draft.restapi)
          : kind === 'graphql'
            ? draft.graphql
            : kind === 'graphqlapi'
              ? draft.graphqlapi
              : kind === 'openapi'
                ? draft.openapi
                : kind === 'service'
                  ? serviceQuery
                  : draft.rest
    run.mutate({ resourceId: resource.id, environmentId, query, scope })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      execute()
    }
  }
  const sqlSchema = useSqlSchema(kind === 'sql' ? resource : undefined, environmentId)
  /** A table or column name clicked in the tables panel, at the SQL's cursor. */
  const insertSql = (text: string) => {
    const area = document.getElementById('playground-sql') as HTMLTextAreaElement | null
    const start = area?.selectionStart ?? draft.sql.length
    const end = area?.selectionEnd ?? start
    setDraft((d) => ({ ...d, sql: d.sql.slice(0, start) + text + d.sql.slice(end) }))
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(start + text.length, start + text.length)
    })
  }
  const setRest = (patch: Partial<Draft['rest']>) =>
    setDraft((d) => ({ ...d, rest: { ...d.rest, ...patch } }))
  const setRestApi = (patch: Partial<Draft['restapi']>) =>
    setDraft((d) => ({ ...d, restapi: { ...d.restapi, ...patch } }))
  const setGraphqlApi = (patch: Partial<Draft['graphqlapi']>) =>
    setDraft((d) => ({ ...d, graphqlapi: { ...d.graphqlapi, ...patch } }))
  const graphqlApi = useGraphqlApiSchema(
    kind === 'graphqlapi' ? resource : undefined,
    { url: draft.graphqlapi.url, auth: draft.graphqlapi.auth, headers: draft.graphqlapi.headers },
    scope ?? {},
    environmentId,
  )
  const serviceQuery =
    kind === 'service' && isServiceType(resource.type)
      ? (draft.services[resource.type] ?? defaultActionQuery(resource.type))
      : {}

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
          {kind === 'sql' ? (
            <>
              <Field
                label="SQL"
                hint={`{{ expression }} becomes a bind parameter (${PLACEHOLDERS[resource.type] ?? '$1'}); values are never pasted into the SQL.`}
              >
                <Textarea
                  id="playground-sql"
                  rows={10}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  value={draft.sql}
                  onKeyDown={onKeyDown}
                  onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                />
              </Field>
              <SqlSchemaPanel state={sqlSchema.state} onRefresh={sqlSchema.refresh} onInsert={insertSql} />
            </>
          ) : kind === 'service' && isServiceType(resource.type) ? (
            <ActionQueryForm
              type={resource.type}
              query={serviceQuery}
              lookup={{ resourceId: resource.id, environmentId }}
              onChange={(patch, replace) =>
                setDraft((d) => ({
                  ...d,
                  services: {
                    ...d.services,
                    [resource.type]: replace ? patch : { ...serviceQuery, ...patch },
                  },
                }))
              }
              code={({ field, value, onChange, height }) => (
                <Textarea
                  rows={Math.max(3, Math.round(height / 24))}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  value={value}
                  data-testid={`query-field-${field.key}`}
                  onKeyDown={onKeyDown}
                  onChange={(e) => onChange(e.target.value)}
                />
              )}
            />
          ) : kind === 'openapi' ? (
            <OpenApiQueryForm
              query={draft.openapi}
              operations={openapi.operations}
              message={openapi.message}
              onChange={(patch) => setDraft((d) => ({ ...d, openapi: { ...d.openapi, ...patch } }))}
              code={({ field, value, onChange, height }) => (
                <Textarea
                  rows={Math.max(3, Math.round(height / 24))}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  value={value}
                  data-testid={`openapi-field-${field}`}
                  onKeyDown={onKeyDown}
                  onChange={(e) => onChange(e.target.value)}
                />
              )}
            />
          ) : kind === 'graphql' ? (
            <GraphqlDraft
              graphql={draft.graphql}
              setGraphql={(patch) => setDraft((d) => ({ ...d, graphql: { ...d.graphql, ...patch } }))}
              onKeyDown={onKeyDown}
            />
          ) : kind === 'graphqlapi' ? (
            <>
              <GraphqlApiTargetFields
                url={draft.graphqlapi.url}
                onUrl={(url) => setGraphqlApi({ url })}
                auth={draft.graphqlapi.auth}
                onAuth={(auth) => setGraphqlApi({ auth })}
                schema={graphqlApi.state}
                onLoadSchema={graphqlApi.load}
              />
              <GraphqlDraft graphql={draft.graphqlapi} setGraphql={setGraphqlApi} onKeyDown={onKeyDown} />
            </>
          ) : kind === 'restapi' ? (
            <>
              <RestQueryEditor
                rest={{ ...draft.restapi, path: draft.restapi.url }}
                setRest={({ path, ...patch }) =>
                  setRestApi({ ...patch, ...(path !== undefined && { url: path }) })
                }
                onKeyDown={onKeyDown}
                placeholder="https://api.example.com/orders/{{ id }}"
              />
              <RequestAuthFields
                auth={draft.restapi.auth}
                onChange={(auth) => setRestApi({ auth: auth as Draft['restapi']['auth'] })}
              />
            </>
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

/** A GraphQL query to try (M27): the operation, its variables, and which operation. */
function GraphqlDraft({
  graphql,
  setGraphql,
  onKeyDown,
}: {
  graphql: Draft['graphql']
  setGraphql: (patch: Partial<Draft['graphql']>) => void
  onKeyDown: (e: KeyboardEvent) => void
}) {
  return (
    <>
      <Field label="Query" hint="Values go in the variables as $name, not {{ }} in the query.">
        <Textarea
          rows={10}
          spellCheck={false}
          className="font-mono text-[13px]"
          value={graphql.query}
          data-testid="graphql-query"
          onKeyDown={onKeyDown}
          onChange={(e) => setGraphql({ query: e.target.value })}
        />
      </Field>
      <Field label="Variables" hint='JSON with {{ }}, e.g. {"id": {{ id }}}'>
        <Textarea
          rows={3}
          spellCheck={false}
          className="font-mono text-[13px]"
          value={graphql.variables}
          data-testid="graphql-variables"
          onKeyDown={onKeyDown}
          onChange={(e) => setGraphql({ variables: e.target.value })}
        />
      </Field>
      <Field label="Operation name" hint="Only when the query has several operations.">
        <Input
          className="font-mono"
          value={graphql.operationName}
          onChange={(e) => setGraphql({ operationName: e.target.value })}
        />
      </Field>
    </>
  )
}

function RestQueryEditor({
  rest,
  setRest,
  onKeyDown,
  placeholder = '/orders/{{ id }}',
}: {
  rest: Draft['rest']
  setRest: (patch: Partial<Draft['rest']>) => void
  onKeyDown: (e: KeyboardEvent) => void
  placeholder?: string
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
          placeholder={placeholder}
          data-testid="request-url"
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
