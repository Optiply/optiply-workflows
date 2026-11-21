import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Button, Dialog, ErrorNote, Field, Input, SecretInput } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

/**
 * Signing in to a resource whose custom auth flow asks each person for their own details (a form step): the flow's
 * fields, sent once to sign in and never kept (only what the flow signs in to is stored, as the person's own).
 * `appId`: the app the person signs in through, when they have no access to the resource itself.
 */
export function CustomSignInDialog({
  resourceId,
  environmentId,
  appId,
  onClose,
  onSignedIn,
}: {
  resourceId: string
  environmentId: string
  appId?: string
  onClose: () => void
  onSignedIn: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const target = { resourceId, environmentId, ...(appId && { appId }) }
  const form = useQuery(trpc.resources.customAuthForm.queryOptions(target))
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const signIn = useMutation(
    trpc.resources.customAuthSignIn.mutationOptions({
      onSuccess: async (result) => {
        // A failure is kept on the person's sign-in too (the card's "last sign-in failed").
        await queryClient.invalidateQueries({ queryKey: trpc.resources.customAuthStatus.queryKey() })
        await queryClient.invalidateQueries({ queryKey: trpc.resources.customAuthForm.queryKey() })
        if (!result.ok) {
          setProblem(result.error.message)
          return
        }
        setValues({})
        onSignedIn()
      },
    }),
  )
  const steps = form.data?.form ?? []
  const set = (step: string, field: string, value: string) =>
    setValues((v) => ({ ...v, [step]: { ...v[step], [field]: value } }))
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    // One attempt at a time: a second would sign in again (or meet the back-off) behind the first.
    if (signIn.isPending) return
    setProblem(null)
    // Every form step gets its values, empty ones included: the server asks again for any step left out.
    const typed = Object.fromEntries(steps.map((s) => [s.step, values[s.step] ?? {}]))
    signIn.mutate({ ...target, form: typed })
  }

  return (
    <Dialog
      title={form.data ? `Sign in to ${form.data.resourceName}` : 'Sign in'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={signIn.isPending} disabled={!form.data} onClick={() => submit()}>
            Sign in
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} aria-label="Sign in">
        {steps.map((step, i) => (
          <fieldset key={step.step} className="space-y-3">
            {step.title && <legend className="mb-2 text-sm text-muted">{step.title}</legend>}
            {step.fields.map((field, j) => (
              <Field key={field.name} label={field.label}>
                {field.kind === 'password' ? (
                  <SecretInput
                    autoFocus={i === 0 && j === 0}
                    value={values[step.step]?.[field.name] ?? ''}
                    onChange={(e) => set(step.step, field.name, e.target.value)}
                  />
                ) : (
                  <Input
                    autoFocus={i === 0 && j === 0}
                    autoComplete="off"
                    value={values[step.step]?.[field.name] ?? ''}
                    onChange={(e) => set(step.step, field.name, e.target.value)}
                  />
                )}
              </Field>
            ))}
          </fieldset>
        ))}
        {/* Enter in a field signs in. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        <p className="text-xs text-muted">
          What you type is sent to sign in
          {form.data?.sendsTo.length ? (
            <>
              {' '}
              at <strong className="font-medium text-ink">{form.data.sendsTo.join(', ')}</strong>
            </>
          ) : null}{' '}
          and not kept: only your sign-in is stored, for your own queries.
        </p>
        {problem && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
        <ErrorNote error={form.error ?? signIn.error} />
      </form>
    </Dialog>
  )
}
