import { type CodeKind, freeIdentifierRefs, parseTemplate, TemplateError } from '@ow/expressions'
import type { Block, LoopRunner } from './schema'

export type FieldKind =
  /** Text with `{{ }}` expressions. */
  | 'template'
  /** One JS expression, written without `{{ }}` (branch and filter conditions). */
  | 'expression'
  /** A code block's body. */
  | 'function-body'
  /** A function body run synchronously (app transformers). */
  | 'sync-function-body'

/** One piece of user code inside a block. */
export interface CodeField {
  /** Path from the block, e.g. `['config', 'conditions', 0, 'expression']`. */
  path: (string | number)[]
  kind: FieldKind
  source: string
  /** Names the engine defines for this field only (`value` and `index` in a filter condition or loop runner). */
  locals?: string[]
}

/** What a filter condition and a loop runner see for the current item. */
const ITEM_LOCALS = ['value', 'index']

/** A free identifier found in a field; offsets are into `CodeField.source`. */
export interface FieldRef {
  name: string
  start: number
  end: number
  /** A shorthand property (`{ name }`): renaming must keep the key. */
  shorthand?: true
  /** With `{ properties: true }`: the property read straight off it (`b` in `a.b`). */
  property?: string
}

/** Every field of a block that holds code or templates, in a stable order. */
export function codeFields(block: Block): CodeField[] {
  switch (block.type) {
    case 'startTrigger':
      return []
    case 'code':
      return [{ path: ['config', 'code'], kind: 'function-body', source: block.config.code }]
    case 'resourceQuery':
      // Connector-agnostic: every string in the query is a template.
      return templateStrings(block.config.query, ['config', 'query'])
    case 'branch':
      return block.config.conditions.map((c, i) => ({
        path: ['config', 'conditions', i, 'expression'],
        kind: 'expression' as const,
        source: c.expression,
      }))
    case 'filter':
      return [
        { path: ['config', 'input'], kind: 'template', source: block.config.input },
        {
          path: ['config', 'condition'],
          kind: 'expression',
          source: block.config.condition,
          locals: ITEM_LOCALS,
        },
      ]
    case 'response': {
      const { status, headers, body } = block.config
      const fields: CodeField[] = []
      if (status !== undefined) fields.push({ path: ['config', 'status'], kind: 'template', source: status })
      headers?.forEach((h, i) => {
        fields.push({ path: ['config', 'headers', i, 'value'], kind: 'template', source: h.value })
      })
      if (body !== undefined) fields.push({ path: ['config', 'body'], kind: 'template', source: body })
      return fields
    }
    case 'loop':
      return [
        { path: ['config', 'input'], kind: 'template', source: block.config.input },
        ...runnerFields(block.config.runner),
      ]
    case 'function':
      return argFields(block.config.params, ['config', 'params'])
    case 'workflow':
      return block.config.input === undefined
        ? []
        : [{ path: ['config', 'input'], kind: 'template', source: block.config.input }]
    case 'wait':
      return block.config.kind === 'duration'
        ? [{ path: ['config', 'amount'], kind: 'template', source: block.config.amount }]
        : [{ path: ['config', 'until'], kind: 'template', source: block.config.until }]
    case 'userTask': {
      const { title, description, assignees, fields, due } = block.config
      const out: CodeField[] = [{ path: ['config', 'title'], kind: 'template', source: title }]
      if (description !== undefined) {
        out.push({ path: ['config', 'description'], kind: 'template', source: description })
      }
      assignees.users?.forEach((u, i) => {
        out.push({ path: ['config', 'assignees', 'users', i], kind: 'template', source: u })
      })
      assignees.groups?.forEach((g, i) => {
        out.push({ path: ['config', 'assignees', 'groups', i], kind: 'template', source: g })
      })
      fields?.forEach((f, i) => {
        if (f.default !== undefined) {
          out.push({ path: ['config', 'fields', i, 'default'], kind: 'template', source: f.default })
        }
      })
      if (due) out.push({ path: ['config', 'due', 'amount'], kind: 'template', source: due.amount })
      return out
    }
    case 'errorTrigger':
      return []
  }
}

/**
 * Free identifiers in a field, minus its locals, plus any syntax errors (offsets into `field.source`). A template
 * with an unterminated `{{` stops at that error; other templates report each bad expression separately.
 */
export function fieldRefs(
  field: Pick<CodeField, 'kind' | 'source' | 'locals'>,
  options: { properties?: boolean } = {},
): { refs: FieldRef[]; errors: TemplateError[] } {
  const refs: FieldRef[] = []
  const errors: TemplateError[] = []
  const collect = (code: string, kind: CodeKind, offset: number) => {
    try {
      for (const ref of freeIdentifierRefs(code, kind, options)) {
        refs.push({ ...ref, start: ref.start + offset, end: ref.end + offset })
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err
      errors.push(new TemplateError(err.message, err.start + offset, err.end + offset, err.hint))
    }
  }

  if (field.kind === 'template') {
    try {
      for (const part of parseTemplate(field.source)) {
        if (part.type === 'expression') collect(part.code, 'expression', part.start + 2)
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err
      errors.push(err)
    }
  } else {
    collect(field.source, field.kind, 0)
  }

  const locals = new Set(field.locals)
  return { refs: refs.filter((r) => !locals.has(r.name)), errors }
}

/** Names a block's code reads that aren't its own locals (blocks, globals or mistakes). */
export function referencedNames(block: Block): Set<string> {
  const names = new Set<string>()
  for (const field of codeFields(block)) for (const ref of fieldRefs(field).refs) names.add(ref.name)
  return names
}

function templateStrings(value: unknown, path: (string | number)[], locals?: string[]): CodeField[] {
  if (typeof value === 'string') return [{ path, kind: 'template', source: value, ...(locals && { locals }) }]
  if (Array.isArray(value)) return value.flatMap((v, i) => templateStrings(v, [...path, i], locals))
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((k) => templateStrings((value as Record<string, unknown>)[k], [...path, k], locals))
  }
  return []
}

/** A loop runner's code, query or arguments, where `value` and `index` are the current item. */
function runnerFields(runner: LoopRunner): CodeField[] {
  const at = ['config', 'runner']
  switch (runner.kind) {
    case 'code':
      return [{ path: [...at, 'code'], kind: 'function-body', source: runner.code, locals: ITEM_LOCALS }]
    case 'query':
      return templateStrings(runner.query, [...at, 'query'], ITEM_LOCALS)
    case 'function':
      return argFields(runner.params, [...at, 'params'], ITEM_LOCALS)
    case 'workflow':
      return runner.input === undefined
        ? []
        : [{ path: [...at, 'input'], kind: 'template', source: runner.input, locals: ITEM_LOCALS }]
  }
}

/** A function call's argument templates, by parameter name. */
function argFields(
  params: Record<string, string> | undefined,
  path: (string | number)[],
  locals?: string[],
): CodeField[] {
  return templateStrings(params ?? {}, path, locals)
}
