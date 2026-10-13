import { parseTemplate, singleExpression, TemplateError } from './template'

/** Evaluates the code inside one `{{ }}` (the caller supplies the sandbox and scope). */
export type Evaluate = (code: string) => unknown

/** How a value appears inside text: strings as-is, null/undefined as empty, objects and arrays as JSON. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Evaluates a template. A lone `{{ x }}` yields x's value as-is (number, object, …); anything else yields a
 * string. Expressions are evaluated in order, one at a time.
 */
export async function renderTemplate(src: string, evaluate: Evaluate): Promise<unknown> {
  const parts = parseTemplate(src)
  const single = singleExpression(parts)
  if (single !== null) return await evaluate(single)
  return renderText(src, evaluate)
}

/** Like `renderTemplate`, but always a string (for URLs, headers, form fields). */
export async function renderText(src: string, evaluate: Evaluate): Promise<string> {
  let out = ''
  for (const part of parseTemplate(src)) {
    out += part.type === 'text' ? part.value : stringifyValue(await evaluate(part.code))
  }
  return out
}

/**
 * Renders a JSON document with embedded `{{ }}` and parses it. An expression outside a JSON string is inserted
 * as JSON (`{"id": {{ id }}}` works for numbers, strings and objects alike); inside a JSON string it is inserted
 * as escaped text (`"Hello {{ name }}"`). `undefined` becomes `null`.
 */
export async function renderJson(src: string, evaluate: Evaluate): Promise<unknown> {
  const parts = parseTemplate(src)
  const single = singleExpression(parts)
  if (single !== null) return (await evaluate(single)) ?? null

  let out = ''
  let inString = false
  for (const part of parts) {
    if (part.type === 'text') {
      out += part.value
      inString = endsInsideString(part.value, inString)
      continue
    }
    const value = await evaluate(part.code)
    out += inString ? JSON.stringify(stringifyValue(value)).slice(1, -1) : (JSON.stringify(value) ?? 'null')
  }
  try {
    return JSON.parse(out)
  } catch (err) {
    throw new TemplateError(
      `The JSON body isn't valid JSON after evaluating {{ }}: ${(err as Error).message}`,
      0,
      src.length,
    )
  }
}

/** Tracks whether JSON text leaves us inside a string literal (unescaped `"` toggles it). */
function endsInsideString(text: string, inString: boolean): boolean {
  let state = inString
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (state && ch === '\\') i++
    else if (ch === '"') state = !state
  }
  return state
}
