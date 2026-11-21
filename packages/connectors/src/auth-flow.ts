import { scrubSecrets, scrubSecretsDeep } from '@ow/crypto'
import { type Evaluate, renderTemplate } from '@ow/expressions'
import {
  type AuthFlowStep,
  type AuthFormValues,
  FORM_VALUE_MAX,
  type RestConfig,
  type RestSecrets,
  restConnector,
} from './rest'
import { ConnectorError } from './types'

/** What a custom auth flow needs from the sandbox (the server's `CodeRuntime`). */
export interface FlowSandbox {
  evalExpression(
    expression: string,
    scope: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>
  runCode(code: string, scope: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>
}

/** Each `{{ }}` gets this long; each request and code step its own STEP_TIMEOUT_MS. */
const EXPRESSION_TIMEOUT_MS = 5_000
const STEP_TIMEOUT_MS = 30_000

/**
 * Runs a custom auth flow's steps in order and returns its variables (`auth.<name>`).
 *
 * In scope for each step: `secrets` (the resource's secret values), `auth` (the variables so far, starting from
 * `previous` in a refresh flow), and every earlier step by its name: a request's `{ data, status, headers }`, a code
 * step's return value, a variable's value. Requests go through the REST connector against the resource's base URL,
 * allowed hosts and network settings, without its default headers and parameters (they may need `auth`) or auth.
 * A failing step fails the flow with `auth_required`, naming the step.
 *
 * A form step's result is what the person typed (`form`, by step name: each field a string, missing ones empty).
 * Without values for every form step, the flow fails before any step runs (`reason: 'form_needed'`). Typed values
 * are scrubbed from the failure (an API may echo them back).
 */
export async function runAuthFlow(
  resource: { config: RestConfig; secrets: RestSecrets },
  steps: readonly AuthFlowStep[],
  opts: {
    sandbox: FlowSandbox
    signal: AbortSignal
    previous?: Record<string, unknown>
    form?: AuthFormValues
  },
): Promise<Record<string, unknown>> {
  // Only what was sent: a step or field named like an Object member (`constructor`) mustn't read the prototype's.
  const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
    record && Object.hasOwn(record, key) ? record[key] : undefined
  const typedValue = (step: string, field: string) =>
    String(own(own(opts.form, step), field) ?? '').slice(0, FORM_VALUE_MAX)
  const formSteps = steps.filter((s) => s.type === 'form')
  const missing = formSteps.find((s) => {
    const values = own(opts.form, s.name)
    return !values || typeof values !== 'object'
  })
  if (missing) {
    throw new ConnectorError('auth_required', 'Sign in with your own details to use this resource.', {
      reason: 'form_needed',
      step: missing.name,
    })
  }
  const typed = formSteps.flatMap((s) => s.fields.map((f) => typedValue(s.name, f.name)))
  const variables: Record<string, unknown> = {}
  const scope: Record<string, unknown> = {
    secrets: { ...resource.secrets.values },
    auth: { ...(opts.previous ?? {}) },
  }
  const evaluate: Evaluate = (code) =>
    opts.sandbox.evalExpression(code, scope, { timeoutMs: EXPRESSION_TIMEOUT_MS })
  const client = restConnector.createClient({
    id: 'auth-flow',
    resourceId: 'auth-flow',
    environmentId: 'auth-flow',
    version: 'auth-flow',
    config: { ...resource.config, headers: [], params: [], auth: { type: 'none' } },
    secrets: resource.secrets,
  }) as Awaited<ReturnType<typeof restConnector.createClient>>
  try {
    for (const step of steps) {
      if (opts.signal.aborted) throw opts.signal.reason
      try {
        switch (step.type) {
          case 'request': {
            const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])
            const result = await restConnector.execute(client, step, {
              evaluate,
              signal,
              timeoutMs: STEP_TIMEOUT_MS,
            })
            scope[step.name] = {
              data: result.data,
              status: result.metadata.status,
              headers: result.metadata.headers,
            }
            break
          }
          case 'code':
            scope[step.name] = await opts.sandbox.runCode(step.code, scope, { timeoutMs: STEP_TIMEOUT_MS })
            break
          case 'form':
            scope[step.name] = Object.fromEntries(
              step.fields.map((f) => [f.name, typedValue(step.name, f.name)]),
            )
            break
          case 'variable': {
            const value = await renderTemplate(step.value, evaluate)
            scope[step.name] = value
            variables[step.name] = value
            scope.auth = { ...(scope.auth as Record<string, unknown>), [step.name]: value }
            break
          }
        }
      } catch (err) {
        if (opts.signal.aborted) throw err
        const inner = err instanceof ConnectorError ? err : undefined
        throw new ConnectorError(
          'auth_required',
          scrubSecrets(`Signing in failed at step "${step.name}": ${(err as Error).message}`, typed),
          {
            reason: 'flow_failed',
            step: step.name,
            ...(inner?.details?.status !== undefined && { status: inner.details.status }),
            ...(inner?.details?.body !== undefined && { body: scrubSecretsDeep(inner.details.body, typed) }),
          },
        )
      }
    }
  } finally {
    await restConnector.destroyClient(client)
  }
  return variables
}
