import { type CodeKind, freeIdentifierRefs, parseTemplate, TemplateError } from '@ow/expressions'
import type { Block } from './schema'

export type FieldKind =
  /** Text with `{{ }}` expressions. */
  | 'template'
  /** One JS expression, written without `{{ }}` (branch and filter conditions). */
  | 'expression'
  /** A code block's body. */
  | 'function-body'

/** One piece of user code inside a block. */
export interface CodeField {
  /** Path from the block, e.g. `['config', 'conditions', 0, 'expression']`. */
  path: (string | number)[]
  kind: FieldKind
  source: string
  /** Names the engine defines for this field only (`value` and `index` in a filter condition). */
  locals?: string[]
}

/** A free identifier found in a field; offsets are into `CodeField.source`. */
export interface FieldRef {
  name: string
  start: number
  end: number
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
          locals: ['value', 'index'],
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
  }
}

/**
 * Free identifiers in a field, minus its locals, plus any syntax errors (offsets into `field.source`). A template
 * with an unterminated `{{` stops at that error; other templates report each bad expression separately.
 */
export function fieldRefs(field: CodeField): { refs: FieldRef[]; errors: TemplateError[] } {
  const refs: FieldRef[] = []
  const errors: TemplateError[] = []
  const collect = (code: string, kind: CodeKind, offset: number) => {
    try {
      for (const ref of freeIdentifierRefs(code, kind)) {
        refs.push({ name: ref.name, start: ref.start + offset, end: ref.end + offset })
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

function templateStrings(value: unknown, path: (string | number)[]): CodeField[] {
  if (typeof value === 'string') return [{ path, kind: 'template', source: value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => templateStrings(v, [...path, i]))
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((k) => templateStrings((value as Record<string, unknown>)[k], [...path, k]))
  }
  return []
}
