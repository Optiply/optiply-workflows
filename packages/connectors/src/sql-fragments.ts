import {
  type CompiledSql,
  type Evaluate,
  fragmentText,
  type SqlDialect,
  SqlFragmentError,
  withFragments,
} from '@ow/expressions'
import { ConnectorError } from './types'

/**
 * Puts the `{{ sql.column(…) }}` and `{{ sql.direction(…) }}` of a query into its SQL text. Each value is checked
 * here, against the list written in the query, whoever computed it: in apps it comes from the viewer's browser.
 * Runs before anything is sent to the database, so the statement the database sees is complete.
 */
export async function resolveFragments(
  plan: CompiledSql,
  dialect: SqlDialect,
  evaluate: Evaluate,
): Promise<CompiledSql> {
  if (!plan.fragments.length) return plan
  const texts: string[] = []
  for (const fragment of plan.fragments) {
    const value = await evaluate(fragment.code)
    try {
      texts.push(fragmentText(fragment.spec, value, dialect))
    } catch (err) {
      if (!(err instanceof SqlFragmentError)) throw err
      throw new ConnectorError('expression', `Error in {{ ${fragment.code.trim()} }}: ${err.message}`, {
        start: fragment.start,
        end: fragment.end,
      })
    }
  }
  return withFragments(plan, texts)
}
