import type { AppQuery, JsonValue, Transformer, Variable } from '@ow/app-definition'
import { parseTemplate } from '@ow/expressions'
import type { RetoolApp, RetoolPlugin } from '../model'
import type { ReportBuilder } from '../report'
import { convertQuery, isResourceEditor, type ResourceMapping } from '../workflow/queries'

/**
 * Retool's queries (datasources), State and Functions as our app queries, variables and transformers. Events are
 * converted separately (events.ts).
 */

export interface AppLogic {
  queries: AppQuery[]
  variables: Variable[]
  transformers: Transformer[]
}

const MAX_APP_QUERY_TIMEOUT = 600_000

export function convertLogic(app: RetoolApp, report: ReportBuilder, resources: ResourceMapping): AppLogic {
  const queries: AppQuery[] = []
  const variables: Variable[] = []
  const transformers: Transformer[] = []
  const ctx = { report, resources }
  for (const p of app.plugins) {
    if (p.type === 'datasource') {
      const { query, status, notes } = convertAppQuery(p, ctx)
      queries.push(query)
      report.add({ retool: p.id, kind: p.subtype, became: `${query.kind} query`, status, notes })
    } else if (p.type === 'state') {
      variables.push({ name: p.id, ...initialValue(p.template.value), ...description(p) })
      report.add({ retool: p.id, kind: p.subtype, became: 'variable', status: 'converted' })
    } else if (p.type === 'function') {
      const code = typeof p.template.funcBody === 'string' ? inlineBraces(p.template.funcBody) : 'return null'
      transformers.push({ name: p.id, code, ...description(p), ...(p.screen && { page: p.screen }) })
      report.add({ retool: p.id, kind: p.subtype, became: 'transformer', status: 'converted' })
    } else if (p.type === 'setting') {
      report.add({
        retool: p.id,
        kind: p.subtype,
        became: 'nothing',
        status: 'approximated',
        notes:
          p.subtype === 'DocumentTitle'
            ? ["The browser tab shows the app's name here"]
            : ['App settings like this one have no counterpart'],
      })
    }
  }
  return { queries, variables, transformers }
}

function description(p: RetoolPlugin): { description?: string } {
  return p.comment?.trim() ? { description: p.comment.trim().slice(0, 2000) } : {}
}

/** Retool's State value is text: JSON when it reads as JSON (`[]`, `{"a":1}`, `3`), else a template. */
function initialValue(raw: unknown): { initialValue?: JsonValue } {
  if (typeof raw !== 'string')
    return raw === undefined || raw === null ? {} : { initialValue: raw as JsonValue }
  const text = raw.trim()
  if (!text) return {}
  if (!text.includes('{{')) {
    try {
      return { initialValue: JSON.parse(text) as JsonValue }
    } catch {}
  }
  return { initialValue: raw }
}

function convertAppQuery(
  p: RetoolPlugin,
  ctx: { report: ReportBuilder; resources: ResourceMapping },
): { query: AppQuery; status: 'converted' | 'approximated' | 'unsupported'; notes: string[] } {
  const t = p.template
  const notes: string[] = []
  const common: Record<string, unknown> = {
    name: p.id,
    ...description(p),
    ...(p.screen && { page: p.screen }),
  }
  if (t.requireConfirmation === true) {
    common.confirm =
      typeof t.confirmationMessage === 'string' && t.confirmationMessage.trim()
        ? t.confirmationMessage
        : 'Are you sure?'
  }
  const disabled = t.queryDisabled
  if (typeof disabled === 'string' ? disabled.trim() && disabled.trim() !== 'false' : disabled === true) {
    common.disabled = typeof disabled === 'string' ? disabled : 'true'
  }
  if (t.runWhenPageLoads === true) common.runOnLoad = true
  if (t.enableTransformer === true && typeof t.transformer === 'string' && t.transformer.trim()) {
    common.transform = inlineBraces(t.transformer)
  }
  const timeout = Number(t.queryTimeout)
  if (Number.isFinite(timeout) && timeout >= 100 && timeout !== 10_000) {
    common.timeoutMs = Math.min(MAX_APP_QUERY_TIMEOUT, Math.round(timeout))
    if (timeout > MAX_APP_QUERY_TIMEOUT)
      notes.push(`Its ${Math.round(timeout / 1000)} s timeout is 600 s here, the most an app query has`)
  }
  if (t.showSuccessToaster === true) {
    const message =
      typeof t.successMessage === 'string' && t.successMessage.trim() ? t.successMessage : `${p.id} ran`
    common.events = [{ id: 'toast', event: 'success', action: { type: 'notify', message, tone: 'success' } }]
  }
  const run = t.runWhenModelUpdates === true ? 'auto' : 'manual'

  if (p.subtype === 'JavascriptQuery') {
    const code = typeof t.query === 'string' ? inlineBraces(t.query) : ''
    return {
      query: { ...common, kind: 'js', code } as AppQuery,
      status: notes.length ? 'approximated' : 'converted',
      notes,
    }
  }
  if (isResourceEditor(p.subtype)) {
    const q = convertQuery(ctx, p.subtype, p.resourceName, p, p.id)
    if (q.ok) {
      notes.push(...q.notes)
      return {
        query: { ...common, kind: 'resource', resource: q.resource, query: q.query, run } as AppQuery,
        status: notes.length ? 'approximated' : 'converted',
        notes,
      }
    }
    notes.push(q.reason)
  } else if (p.subtype === 'WorkflowRun') {
    notes.push("Apps here can't run workflows yet (M36 step 5 adds it): re-import once it can")
  } else {
    notes.push(`Retool ${p.subtype} queries aren't supported`)
  }
  // A stand-in: a JavaScript query that does nothing but say what it was, and doesn't run.
  return {
    query: {
      ...common,
      kind: 'js',
      code: `// Not imported from Retool: a ${p.subtype} query. ${notes.at(-1)}\nthrow new Error(${JSON.stringify(`${p.id} wasn't imported from Retool (${p.subtype})`)})`,
      disabled: 'true',
    } as AppQuery,
    status: 'unsupported',
    notes,
  }
}

/**
 * Retool lets JavaScript (Functions, transformers) hold `{{ x }}`, which it fills in before running: here the
 * expression itself, in brackets.
 */
export function inlineBraces(code: string): string {
  if (!code.includes('{{')) return code
  try {
    return parseTemplate(code)
      .map((part) => (part.type === 'text' ? part.value : `(${part.code.trim()})`))
      .join('')
  } catch {
    return code
  }
}
