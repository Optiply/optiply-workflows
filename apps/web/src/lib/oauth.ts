/** Whose account: the resource's shared one, or the signed-in person's own (per-user resources). */
export type OAuthAccount = 'shared' | 'mine'

export interface ConnectOutcome {
  ok: boolean
  message: string
}

/** What a query's `auth_required` error says about the connection it needs (see the server's `authDetails`). */
export interface AuthRequired {
  reason: string
  account: 'shared' | 'user'
  resourceId: string
  environmentId: string
  /** `form`: a custom auth flow asking each person for their own details (the sign-in dialog), not OAuth's popup. */
  flow?: 'form'
  /** A live run acting as the release's publisher (§2.47): only they can connect the account it needs. */
  publisherId?: string
}

export function authRequired(
  error: { code?: string; details?: unknown } | null | undefined,
): AuthRequired | null {
  if (error?.code !== 'auth_required') return null
  const d = error.details as Partial<AuthRequired> | null | undefined
  if (!d || typeof d.resourceId !== 'string' || typeof d.environmentId !== 'string') return null
  return {
    reason: String(d.reason ?? ''),
    account: d.account === 'user' ? 'user' : 'shared',
    resourceId: d.resourceId,
    environmentId: d.environmentId,
    ...((d as { flow?: unknown }).flow === 'form' && { flow: 'form' as const }),
    ...(typeof (d as { publisherId?: unknown }).publisherId === 'string' && {
      publisherId: (d as { publisherId: string }).publisherId,
    }),
  }
}

const POPUP_FEATURES = 'popup,width=560,height=720'

/**
 * Connects an account in a popup: the server sends it through the provider's consent screen and ends on a page
 * that posts `ow:oauth` back here and closes. Resolves when that message arrives, or when the popup is closed
 * without it.
 */
export function connectAccount(target: {
  resourceId: string
  environmentId: string
  account: OAuthAccount
  /** The app it's for, when the person has no access to the resource itself. */
  appId?: string
}): Promise<ConnectOutcome> {
  const params = new URLSearchParams({
    resourceId: target.resourceId,
    environmentId: target.environmentId,
    account: target.account,
    ...(target.appId && { appId: target.appId }),
  })
  const url = `/api/oauth/start?${params}`
  const popup = window.open(url, 'ow-oauth', POPUP_FEATURES)
  if (!popup) {
    return Promise.resolve({ ok: false, message: 'Allow pop-ups for this site to connect an account.' })
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ConnectOutcome) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(watch)
      resolve(outcome)
    }
    const onMessage = (event: MessageEvent) => {
      // Only our own server's page, about this connection.
      if (event.origin !== window.location.origin || event.source !== popup) return
      const data = event.data as { type?: unknown; ok?: unknown; message?: unknown; resourceId?: unknown }
      if (data?.type !== 'ow:oauth') return
      if (data.resourceId !== undefined && data.resourceId !== target.resourceId) return
      finish({ ok: data.ok === true, message: typeof data.message === 'string' ? data.message : '' })
    }
    window.addEventListener('message', onMessage)
    // The page posts and then closes: give a message already on its way a moment to arrive.
    const watch = setInterval(() => {
      if (popup.closed)
        setTimeout(() => finish({ ok: false, message: 'The sign-in window was closed.' }), 300)
    }, 500)
  })
}
