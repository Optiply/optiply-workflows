import { JS_GLOBALS } from '@ow/definition'
import { freeIdentifiers, parseTemplate } from '@ow/expressions'
import { templateStrings } from './fields'
import { APP_STDLIB_GLOBALS } from './names'

/**
 * How a resource query's `{{ }}` values get to the server. The query itself is stored in the app; the browser
 * evaluates each `{{ }}` against the app's state and sends the values, keyed by the expression's code, and the
 * server binds them as parameters.
 *
 * Values from the browser are whatever the viewer sends, so they can't vouch for who the viewer is: an expression
 * reading `current_user` (and nothing else of the app's) is evaluated **on the server** with the signed-in user, and
 * one mixing `current_user` with app values is refused, so `where owner = {{ current_user.email }}` can be trusted.
 */

export type ExpressionSide =
  /** Reads the app's state: the browser sends its value. */
  | 'browser'
  /** Reads `current_user` or `configVars` and only globals: the server evaluates it. */
  | 'server'
  /** Reads `current_user` or `configVars` and app state: refused. */
  | 'mixed'

/**
 * The server-side globals: `current_user` is `{ id, email, name }` of the signed-in user; `configVars` (M36) the
 * environment's config vars, secret ones only for the live release (as in workflows: a draft's editor could show one).
 * They never reach the browser.
 */
export const SERVER_QUERY_GLOBALS: ReadonlySet<string> = new Set(['current_user', 'configVars'])

/** Fields of a query whose `{{ }}` values go to the server (a resource query's query, a library query's params). */
export function isServerQueryField(path: readonly (string | number)[]): boolean {
  return path[0] === 'queries' && (path[2] === 'query' || path[2] === 'params' || path[2] === 'input')
}

/** Who evaluates one `{{ }}` of a resource query. Throws `TemplateError` on a syntax error. */
export function expressionSide(code: string): ExpressionSide {
  const names = freeIdentifiers(code)
  if (!names.some((n) => SERVER_QUERY_GLOBALS.has(n))) return 'browser'
  const onlyGlobals = names.every(
    (n) => SERVER_QUERY_GLOBALS.has(n) || JS_GLOBALS.has(n) || APP_STDLIB_GLOBALS.has(n),
  )
  return onlyGlobals ? 'server' : 'mixed'
}

/**
 * The code of every `{{ }}` in a server query's templates (`queryTemplates`: a resource query's connector query, a
 * library query's parameters) whose value the browser sends, without duplicates. Fields whose templates don't
 * parse are skipped (running the query reports them).
 */
export function browserExpressions(query: Record<string, unknown>): string[] {
  const codes = new Set<string>()
  templateStrings(query, [], (_path, source) => {
    if (!source.includes('{{')) return
    try {
      for (const part of parseTemplate(source)) {
        if (part.type === 'expression' && safeSide(part.code) === 'browser') codes.add(part.code)
      }
    } catch {
      // Reported when the query runs.
    }
  })
  return [...codes]
}

function safeSide(code: string): ExpressionSide | null {
  try {
    return expressionSide(code)
  } catch {
    return null
  }
}
