import { setBodySchemaRegExp } from '@ow/definition/body-schema'
import RE2 from 're2'

/**
 * Body schemas' `pattern`s (webhooks, AI extract schemas) run on RE2 in this process: linear time, so a pattern an
 * editor wrote can't stall the event loop on a caller's input. Called by the API and the worker at startup.
 */
export function useRe2ForPatterns(): void {
  setBodySchemaRegExp(
    Object.assign((pattern: string, flags: string) => new RE2(pattern, flags), { code: 're2' }),
  )
}
