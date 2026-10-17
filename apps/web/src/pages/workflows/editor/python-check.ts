import { lineColumnOffset } from '@ow/definition'
import { useEffect, useState } from 'react'
import { trpcClient } from '@/lib/trpc'
import type { FieldProblem } from './code-field'

/** How long a Python field must be still before the executor checks it. */
const CHECK_DELAY_MS = 1000

/**
 * Python's syntax errors in `code`, from the code executor (`workflows.checkPython`: compiled, never run), a second
 * after the code stops changing; a newer edit drops an older answer. `unavailable` says why there's no check (no
 * executor on this instance, or it can't be reached): runs would fail the same way.
 */
export function usePythonCheck(
  code: string,
  enabled = true,
): { problems: FieldProblem[]; unavailable?: string } {
  const [checked, setChecked] = useState<{ code: string; problems: FieldProblem[]; unavailable?: string }>()

  useEffect(() => {
    if (!enabled) return
    let current = true
    const timer = setTimeout(async () => {
      try {
        const result = await trpcClient.workflows.checkPython.mutate({ fields: [{ id: 'code', code }] })
        if (!current) return
        if (!result.available) {
          setChecked({ code, problems: [], unavailable: result.message })
          return
        }
        setChecked({
          code,
          problems: result.problems.map((p) => {
            // Python may point just past the code: mark its last character then (as the server does).
            const start = Math.min(lineColumnOffset(code, p.line, p.column), Math.max(0, code.length - 1))
            return { start, end: Math.min(code.length, start + 1), message: p.message, severity: 'error' }
          }),
        })
      } catch {
        // The check is a convenience: the server checks again before running.
      }
    }, CHECK_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [code, enabled])

  // An answer for older code would put markers in the wrong places.
  if (!enabled || checked?.code !== code) return { problems: [] }
  return { problems: checked.problems, ...(checked.unavailable && { unavailable: checked.unavailable }) }
}
