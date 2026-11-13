// Pure data with no Node imports, so the web app's settings form can use it (`@ow/connectors/oauth-presets`).

export const OAUTH_PROVIDERS = ['custom', 'google', 'hubspot', 'slack', 'microsoft'] as const
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number]

/** What the settings form fills in when someone picks a provider; everything stays editable afterwards. */
export interface OAuthProviderPreset {
  id: Exclude<OAuthProviderId, 'custom'>
  label: string
  /** May contain placeholders such as `{tenant}`, filled in with `fillPlaceholders` before saving. */
  authorizeUrl: string
  tokenUrl: string
  /**
   * Where Disconnect revokes the connection (RFC 7009: the token posted as a form); empty when the provider has no
   * such endpoint (Disconnect then only forgets the tokens here). On the token URL's origin.
   */
  revokeUrl: string
  baseUrl: string
  allowedHosts: string[]
  /** A starting point; people replace it with the scopes their queries need. */
  scope: string
  authorizeParams: { key: string; value: string }[]
  pkce: boolean
  clientAuth: 'body' | 'basic'
  placeholders: { name: string; label: string; defaultValue: string }[]
  /** Where to register the OAuth app (the redirect URI goes there). */
  consoleUrl: string
  hint: string
}

export const oauthPresets: Readonly<Record<OAuthProviderPreset['id'], OAuthProviderPreset>> = {
  google: {
    id: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    baseUrl: 'https://www.googleapis.com',
    allowedHosts: ['*.googleapis.com'],
    scope: 'openid email https://www.googleapis.com/auth/spreadsheets.readonly',
    // Without offline access Google issues no refresh token; without consent it issues one only the first time.
    authorizeParams: [
      { key: 'access_type', value: 'offline' },
      { key: 'prompt', value: 'consent' },
    ],
    pkce: true,
    clientAuth: 'body',
    placeholders: [],
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    hint: 'Scopes are space-separated URLs. Keep "openid email" to see which account is connected.',
  },
  hubspot: {
    id: 'hubspot',
    label: 'HubSpot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    // HubSpot deletes a refresh token with its own call (DELETE /oauth/v1/refresh-tokens/:token), not RFC 7009.
    revokeUrl: '',
    baseUrl: 'https://api.hubapi.com',
    allowedHosts: [],
    scope: 'oauth crm.objects.contacts.read',
    authorizeParams: [],
    pkce: false,
    clientAuth: 'body',
    placeholders: [],
    consoleUrl: 'https://developers.hubspot.com/',
    hint: 'Scopes are space-separated and must match the app’s required scopes. Access tokens last 30 minutes.',
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // auth.revoke takes the token to revoke in the form, like RFC 7009 (answering 200 with `ok`).
    revokeUrl: 'https://slack.com/api/auth.revoke',
    baseUrl: 'https://slack.com/api',
    allowedHosts: [],
    scope: 'channels:read,chat:write',
    authorizeParams: [],
    pkce: false,
    clientAuth: 'body',
    placeholders: [],
    consoleUrl: 'https://api.slack.com/apps',
    hint: 'Scopes are comma-separated bot scopes. For a user token, leave scopes empty and add a "user_scope" parameter instead.',
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft 365',
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    // Entra ID has no token revocation endpoint (only revoking all of a user's sessions).
    revokeUrl: '',
    baseUrl: 'https://graph.microsoft.com/v1.0',
    allowedHosts: [],
    // offline_access is what makes Entra ID issue a refresh token.
    scope: 'offline_access openid email User.Read',
    authorizeParams: [],
    pkce: true,
    clientAuth: 'body',
    placeholders: [{ name: 'tenant', label: 'Tenant (directory) ID', defaultValue: 'organizations' }],
    consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    hint: 'Scopes are space-separated; keep offline_access. Refresh tokens change on every refresh.',
  },
}

/** Replaces `{name}` placeholders (e.g. Microsoft's `{tenant}`) with URL-encoded values. */
export function fillPlaceholders(url: string, values: Record<string, string>): string {
  return url.replace(/\{(\w+)\}/g, (match, name: string) =>
    values[name] ? encodeURIComponent(values[name]) : match,
  )
}
