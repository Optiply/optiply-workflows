import {
  type AppDefinition,
  appFields,
  appNameReason,
  appNameSchema,
  isAppGlobalName,
  renameAppEntity,
  setAt,
  type Variable,
} from '@ow/app-definition'
import { fieldRefs } from '@ow/definition'
import { parseTemplate } from '@ow/expressions'
import type { ReportBuilder } from '../report'

/**
 * Retool's names for what our components and queries have under another name, rewritten where code reads them:
 * keyed by the Retool kind of the thing read. Each is `property` → what it becomes (`$` is the thing's name).
 */
const MEMBER_RENAMES: Record<string, Record<string, string>> = {
  TableWidget2: { selectedSourceRow: '$.selectedRow', selectedSourceRows: '$.selectedRows' },
  TableWidget: {
    selectedSourceRow: '$.selectedRow',
    // The legacy table's selectedRow is `{ data, index }`.
    'selectedRow.data': '$.selectedRow',
    'selectedRow.index': '$.selectedIndex',
  },
  ModalFrameWidget: { show: '$.open', hide: '$.close' },
  ModalWidget: { show: '$.open', hide: '$.close' },
  ContainerWidget2: {
    currentViewKey: '($.views.find((v) => v.name === $.currentView)?.label ?? $.currentView)',
    currentViewIndex: 'Math.max(0, $.views.findIndex((v) => v.name === $.currentView))',
  },
  FileInputWidget: { clearFiles: '$.clearValue', resetValue: '$.clearValue' },
  FileDropzoneWidget: { clearFiles: '$.clearValue', resetValue: '$.clearValue' },
  FileButtonWidget: { clearFiles: '$.clearValue', resetValue: '$.clearValue' },
}

/** Every input's `resetValue()` is our `clearValue()`. */
const INPUT_KINDS = [
  'TextInputWidget2',
  'NumberInputWidget',
  'SelectWidget2',
  'DateWidget',
  'DateRangeWidget',
  'CheckboxWidget2',
  'SwitchWidget2',
  'TextAreaWidget',
  'RadioGroupWidget2',
  'EditableTextWidget2',
  'EditableNumberWidget',
]
for (const kind of INPUT_KINDS) MEMBER_RENAMES[kind] = { ...MEMBER_RENAMES[kind], resetValue: '$.clearValue' }

/** Globals Retool has under other names. */
const GLOBAL_RENAMES: [RegExp, string][] = [
  [/(^|[^\w$.])current_user\s*\.\s*fullName\b/g, '$1current_user.name'],
]

/**
 * Rewrites Retool-only names in every template and piece of code (`kinds`: each name's Retool kind), and gives the
 * legacy table's `setData()` a variable to set.
 */
export function applyCompat(
  def: AppDefinition,
  kinds: Map<string, string>,
  report: ReportBuilder,
): AppDefinition {
  const out = structuredClone(def)
  const rules: { pattern: RegExp; replace: string }[] = []
  for (const [name, kind] of kinds) {
    for (const [member, to] of Object.entries(MEMBER_RENAMES[kind] ?? {})) {
      const path = member
        .split('.')
        .map((m) => `\\s*\\.\\s*${m}`)
        .join('')
      rules.push({
        pattern: new RegExp(`(^|[^\\w$.])${name}${path}(?![\\w$])`, 'g'),
        replace: `$1${to.replaceAll('$', name)}`,
      })
    }
  }
  // The legacy table's setData(rows): a variable the table's data reads first.
  const legacy = [...kinds].filter(([, kind]) => kind === 'TableWidget').map(([name]) => name)
  const setDataUsed = new Set<string>()
  for (const field of appFields(def)) {
    for (const name of legacy)
      if (new RegExp(`(^|[^\\w$.])${name}\\s*\\.\\s*setData\\s*\\(`).test(field.source)) setDataUsed.add(name)
  }
  const taken = new Set(
    [...def.components, ...def.queries, ...(def.transformers ?? []), ...(def.variables ?? [])].map(
      (x) => x.name,
    ),
  )
  const added: Variable[] = []
  for (const name of setDataUsed) {
    let variable = `${name}Data`
    for (let n = 2; taken.has(variable); n++) variable = `${name}Data${n}`
    taken.add(variable)
    added.push({ name: variable, description: `The data ${name}.setData() set in Retool` })
    rules.push({
      pattern: new RegExp(`(^|[^\\w$.])${name}\\s*\\.\\s*setData\\s*\\(`, 'g'),
      replace: `$1${variable}.setValue(`,
    })
    const table = out.components.find((c) => c.name === name)
    if (table) {
      const data = table.props?.data
      const code =
        typeof data === 'string' ? (loneCode(data) ?? JSON.stringify(data)) : JSON.stringify(data ?? [])
      table.props = { ...table.props, data: `{{ ${variable}.value ?? (${code}) }}` }
    }
    report.note(
      `${name}.setData() (Retool's legacy table) sets the variable ${variable}, which the table shows first`,
    )
  }
  for (const [pattern, replace] of GLOBAL_RENAMES) rules.push({ pattern, replace })
  // Retool's SQL data is by column (`{ id: [1, 2] }`); ours by row. A column read off it is its rows' values.
  const sql = [...kinds].filter(([, kind]) => kind === 'SqlQueryUnified').map(([name]) => name)
  for (const name of sql) {
    rules.push({
      pattern: new RegExp(
        `(^|[^\\w$.])${name}\\s*\\.\\s*data\\s*\\.\\s*(?!(?:${ARRAY_MEMBERS})(?![\\w$]))([A-Za-z_$][\\w$]*)`,
        'g',
      ),
      replace: `$1${name}.data.map((r) => r.$2)`,
    })
  }
  const sqlTransform = new RegExp(
    `(^|[^\\w$.])data\\s*\\.\\s*(?!(?:${ARRAY_MEMBERS})(?![\\w$]))([A-Za-z_$][\\w$]*)`,
    'g',
  )

  let usesXlsx = false
  for (const field of appFields(def)) {
    let rewritten = rewrite(field.source, field.kind === 'template', rules)
    // In an SQL query's transform, `data` is that query's.
    if (field.path[0] === 'queries' && field.path[2] === 'transform' && sql.includes(field.owner)) {
      rewritten = rewritten.replace(sqlTransform, '$1data.map((r) => r.$2)')
    }
    if (field.kind !== 'template' && /(^|[^\w$.])XLSX\s*\./.test(rewritten)) {
      usesXlsx = true
      rewritten = `import * as XLSX from 'xlsx'\n${rewritten}`
    }
    if (rewritten !== field.source) setAt(out, field.path, rewritten)
  }
  if (added.length) out.variables = [...(out.variables ?? []), ...added]
  if (usesXlsx) {
    out.javascript = { packages: [...(out.javascript?.packages ?? []), XLSX_PACKAGE] }
    report.note(
      `Code uses SheetJS (XLSX), which Retool preloads: it's the JavaScript package ${XLSX_PACKAGE}, imported where used. ` +
        "That's the last release on npm (SheetJS publishes newer ones on its own site): check it reads your files",
    )
  }
  declareScopes(out)
  return out
}

/** SheetJS's last release on npm. */
const XLSX_PACKAGE = 'xlsx@0.18.5'

/** What an array has: `q.data.length` stays as it is. */
const ARRAY_MEMBERS = [
  'length',
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'some',
  'every',
  'forEach',
  'reduce',
  'slice',
  'concat',
  'includes',
  'indexOf',
  'join',
  'flatMap',
  'flat',
  'sort',
  'toSorted',
  'at',
  'keys',
  'values',
  'entries',
  'reverse',
  'push',
  'length',
].join('|')

/**
 * Each query's `scope`: the names code passes it with `query.trigger({ additionalScope: { … } })`, anywhere in the
 * app (event handlers' trigger options included, once converted).
 */
export function declareScopes(def: AppDefinition) {
  const names = new Map<string, Set<string>>()
  const queries = new Set(def.queries.map((q) => q.name))
  for (const field of appFields(def)) {
    for (const m of field.source.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*trigger\s*\(\s*\{/g)) {
      const query = m[1]!
      if (!queries.has(query)) continue
      const start = field.source.indexOf('{', m.index! + m[0].length - 1)
      const options = objectKeysAndValues(field.source, start)
      const scope = options.get('additionalScope')
      if (scope === undefined) continue
      const open = field.source.indexOf('{', scope)
      if (open < 0 || field.source.slice(scope, open).trim()) continue
      for (const key of objectKeysAndValues(field.source, open).keys()) {
        if (appNameSchema.safeParse(key).success)
          (names.get(query) ?? names.set(query, new Set()).get(query)!).add(key)
      }
    }
  }
  // Queries triggered by name (`queries[name].trigger({ additionalScope })`) can't be traced: a name a query reads
  // that is a key of any additionalScope in the app, and nothing else, is taken as passed in. So is Retool's
  // `triggeredById` (what fired the handler that triggered it), which our handlers pass too.
  const passed = new Set<string>(['triggeredById'])
  for (const field of appFields(def)) {
    for (const m of field.source.matchAll(/additionalScopes?\s*:\s*\{/g)) {
      for (const key of objectKeysAndValues(field.source, m.index! + m[0].length - 1).keys()) passed.add(key)
    }
  }
  const entities = new Set(
    [...def.components, ...def.queries, ...(def.transformers ?? []), ...(def.variables ?? [])].map(
      (x) => x.name,
    ),
  )
  for (const field of appFields(def)) {
    if (field.path[0] !== 'queries' || field.path[2] === 'events') continue
    for (const ref of fieldRefs(field).refs) {
      if (passed.has(ref.name) && !entities.has(ref.name) && !isAppGlobalName(ref.name)) {
        ;(names.get(field.owner) ?? names.set(field.owner, new Set()).get(field.owner)!).add(ref.name)
      }
    }
  }
  for (const q of def.queries) {
    const found = names.get(q.name)
    if (found?.size) q.scope = [...new Set([...(q.scope ?? []), ...found])].sort().slice(0, 50)
  }
}

/** The top-level keys of the object literal whose `{` is at `open`, each with where its value starts. */
function objectKeysAndValues(source: string, open: number): Map<string, number> {
  const keys = new Map<string, number>()
  let depth = 0
  let i = open
  let expectKey = true
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(source, i)
      if (depth === 1 && expectKey) {
        const key = source.slice(i + 1, end - 1)
        const colon = /^\s*:/.exec(source.slice(end))
        if (colon) keys.set(key, end + colon[0].length)
        expectKey = false
      }
      i = end
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) break
    } else if (depth === 1 && ch === ',') expectKey = true
    else if (depth === 1 && expectKey && /[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))![0]
      const after = source.slice(i + word.length)
      const colon = /^\s*:/.exec(after)
      keys.set(word, colon ? i + word.length + colon[0].length : -1)
      expectKey = false
      i += word.length
      continue
    } else if (depth === 1 && expectKey && ch === '.' && source.startsWith('...', i)) {
      expectKey = false
    }
    i++
  }
  return keys
}

function skipString(source: string, start: number): number {
  const quote = source[start]
  let i = start + 1
  while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
  return i + 1
}

function rewrite(source: string, template: boolean, rules: { pattern: RegExp; replace: string }[]): string {
  const apply = (code: string) => rules.reduce((text, rule) => text.replace(rule.pattern, rule.replace), code)
  if (!template) return apply(source)
  if (!source.includes('{{')) return source
  try {
    return parseTemplate(source)
      .map((part) => (part.type === 'text' ? part.value : `{{${apply(part.code)}}}`))
      .join('')
  } catch {
    return source
  }
}

function loneCode(value: string): string | null {
  try {
    const parts = parseTemplate(value.trim())
    return parts.length === 1 && parts[0]!.type === 'expression' ? parts[0]!.code.trim() : null
  } catch {
    return null
  }
}

/**
 * Names Retool allows that ours don't (reserved here: `url`, `utils`, `moment`…, or not identifiers) get a fresh
 * one, with every reference rewritten.
 */
export function fixAppNames(def: AppDefinition, report: ReportBuilder): AppDefinition {
  let out = def
  const all = () =>
    [...out.components, ...out.queries, ...(out.transformers ?? []), ...(out.variables ?? [])].map(
      (x) => x.name,
    )
  for (const name of all()) {
    if (appNameSchema.safeParse(name).success && appNameReason(name) === null) continue
    const taken = new Set(all())
    const base = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_') || 'part'
    for (let n = 1; n < 50; n++) {
      const to = n === 1 ? `${base}_` : `${base}${n}`
      if (taken.has(to) || !appNameSchema.safeParse(to).success || appNameReason(to) !== null) continue
      const renamed = renameAppEntity(out, name, to)
      if (!renamed.ok) continue
      out = renamed.definition
      const entry = report.entries.find((e) => e.retool === name)
      if (entry) {
        entry.name = to
        entry.notes.push(`Renamed to ${to}: "${name}" is taken or reserved here`)
      } else report.note(`"${name}" was renamed to ${to}: the name is taken or reserved here`)
      break
    }
  }
  return out
}
