import { type ReactNode, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Select } from '@/components/ui'
import type { OpenApiOperationView } from '@/lib/openapi-operations'

// An OpenAPI resource's query form (M29): an operation from the document (filtered, grouped by tag), its parameters
// listed with where they go and their types, values as JSON with {{ }}, and a body in one of the operation's media
// types. The same form in the workflow inspector, the playground and the app editor; each host brings its editor.

export interface OpenApiCodeProps {
  field: 'parameters' | 'body'
  value: string
  onChange: (value: string) => void
  height: number
}

const typeOf = (p: OpenApiOperationView['parameters'][number]) => {
  const s = p.schema
  if (!s) return ''
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.map(String).join(' | ')
  return [Array.isArray(s.type) ? s.type.join(' | ') : s.type, s.format].filter(Boolean).join(' ')
}

/** Parameter values to start from: each one's name (`in:name` where two share it), empty or its first enum value. */
export function parameterSkeleton(op: OpenApiOperationView): string {
  const counts = new Map<string, number>()
  for (const p of op.parameters) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  const entries = op.parameters.map((p) => {
    const key = (counts.get(p.name) ?? 0) > 1 ? `${p.in}:${p.name}` : p.name
    const value = Array.isArray(p.schema?.enum) && p.schema.enum.length ? p.schema.enum[0] : ''
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`
  })
  return entries.length ? `{\n${entries.join(',\n')}\n}` : '{}'
}

export function OpenApiQueryForm({
  query,
  operations,
  message,
  onChange,
  code,
  disabled,
}: {
  query: Record<string, unknown>
  operations: OpenApiOperationView[]
  /** Why there are no operations (no document in this environment, one that doesn't parse). */
  message?: string | undefined
  onChange: (patch: Record<string, unknown>) => void
  code: (props: OpenApiCodeProps) => ReactNode
  disabled?: boolean
}) {
  const [filter, setFilter] = useState('')
  const id = typeof query.operationId === 'string' ? query.operationId : ''
  const op = operations.find((o) => o.id === id)
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const shown = operations.filter(
      (o) =>
        !needle ||
        o.id.toLowerCase().includes(needle) ||
        o.path.toLowerCase().includes(needle) ||
        (o.summary ?? '').toLowerCase().includes(needle),
    )
    const byTag = new Map<string, OpenApiOperationView[]>()
    for (const o of shown) {
      const tag = o.tags[0] ?? 'Other'
      byTag.set(tag, [...(byTag.get(tag) ?? []), o])
    }
    return [...byTag]
  }, [operations, filter])

  return (
    <div className="flex flex-col gap-4" data-testid="openapi-query">
      {message && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-strong">{message}</p>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
        <Field label="Find">
          <Input
            value={filter}
            placeholder="items, /orders, list…"
            data-testid="openapi-filter"
            onChange={(e) => setFilter(e.target.value)}
          />
        </Field>
        <Field label="Operation" {...(op?.summary && { hint: op.summary })}>
          <Select
            value={id}
            disabled={disabled}
            data-testid="openapi-operation"
            onChange={(e) => {
              const next = operations.find((o) => o.id === e.target.value)
              onChange({
                operationId: e.target.value,
                parameters: next ? parameterSkeleton(next) : '{}',
                body: next?.body?.example !== undefined ? JSON.stringify(next.body.example, null, 2) : '',
                contentType: '',
              })
            }}
          >
            <option value="">Choose an operation…</option>
            {id && !op && <option value={id}>{id} (not in the document)</option>}
            {groups.map(([tag, ops]) => (
              <optgroup key={tag} label={tag}>
                {ops.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.method} {o.path} · {o.id}
                    {o.deprecated ? ' (deprecated)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>
      {id && !op && operations.length > 0 && (
        <p className="text-sm text-danger" data-testid="openapi-missing">
          The document has no operation “{id}” any more: choose another.
        </p>
      )}
      {op && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{op.method}</Badge>
            <code className="text-xs">{op.path}</code>
          </div>
          {op.parameters.length > 0 && (
            <table className="w-full text-left text-xs" data-testid="openapi-parameters">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Parameter</th>
                  <th className="py-1 pr-2 font-medium">In</th>
                  <th className="py-1 pr-2 font-medium">Type</th>
                  <th className="py-1 font-medium">About</th>
                </tr>
              </thead>
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}:${p.name}`} className="border-t border-border align-top">
                    <td className="py-1 pr-2 font-mono">
                      {p.name}
                      {p.required && <span className="text-danger">*</span>}
                    </td>
                    <td className="py-1 pr-2">{p.in}</td>
                    <td className="py-1 pr-2 font-mono">{typeOf(p)}</td>
                    <td className="py-1 text-muted">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Field
            label="Parameters"
            hint="Values by name as JSON; {{ }} anywhere. Path values are sent as one encoded segment."
          >
            <div className="space-y-1.5">
              {code({
                field: 'parameters',
                value: String(query.parameters ?? ''),
                onChange: (v) => onChange({ parameters: v }),
                height: 120,
              })}
              {op.parameters.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  data-testid="openapi-fill-parameters"
                  onClick={() => onChange({ parameters: parameterSkeleton(op) })}
                >
                  Fill in the names
                </Button>
              )}
            </div>
          </Field>
          {op.body && (
            <>
              {op.body.contentTypes.length > 1 && (
                <Field label="Media type">
                  <Select
                    value={String(query.contentType || op.body.contentTypes[0])}
                    disabled={disabled}
                    data-testid="openapi-content-type"
                    onChange={(e) =>
                      onChange({
                        contentType: e.target.value === op.body?.contentTypes[0] ? '' : e.target.value,
                      })
                    }
                  >
                    {op.body.contentTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field
                label={`Body${op.body.required ? ' (required)' : ''}`}
                hint="JSON with {{ }}, or a lone {{ }} for any value (file objects for uploads)."
              >
                <div className="space-y-1.5">
                  {code({
                    field: 'body',
                    value: String(query.body ?? ''),
                    onChange: (v) => onChange({ body: v }),
                    height: 160,
                  })}
                  {op.body.example !== undefined && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      data-testid="openapi-example-body"
                      onClick={() => onChange({ body: JSON.stringify(op.body?.example, null, 2) })}
                    >
                      Use the example
                    </Button>
                  )}
                </div>
              </Field>
            </>
          )}
        </>
      )}
    </div>
  )
}
