import { ConnectorError } from '@ow/connectors'
import { scrubSecrets, scrubSecretsDeep } from '@ow/crypto'
import { TemplateError } from '@ow/expressions'
import { SandboxError } from '@ow/sandbox'
import type { EngineError } from './types'

/** A block failure raised by the engine itself (timeouts, bad input, oversized results). */
export class BlockFailure extends Error {
  override name = 'BlockFailure'
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** The store refused a write because another worker holds the run now (its epoch moved on). */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError'
}

/** Why a run's signal aborted when someone cancelled it: the run stops and finishes as `cancelled`. */
export class RunCancelledError extends Error {
  override name = 'RunCancelledError'
  constructor(message = 'The run was cancelled') {
    super(message)
  }
}

/** Normalises anything a block can throw, scrubbing secret values out of the message and details. */
export function toEngineError(err: unknown, secrets: readonly string[] = []): EngineError {
  let error: EngineError
  if (err instanceof BlockFailure || err instanceof ConnectorError) {
    error = { code: err.code, message: err.message, ...(err.details && { details: err.details }) }
  } else if (err instanceof SandboxError) {
    error = { code: err.kind, message: err.message, ...(err.details && { details: err.details }) }
  } else if (err instanceof TemplateError) {
    error = {
      code: 'expression',
      message: err.message,
      details: { start: err.start, end: err.end, ...(err.hint && { hint: err.hint }) },
    }
  } else {
    error = { code: 'internal', message: err instanceof Error ? err.message : String(err) }
  }
  if (!secrets.length) return error
  return {
    ...error,
    message: scrubSecrets(error.message, secrets),
    ...(error.details && { details: scrubSecretsDeep(error.details, secrets) }),
  }
}
