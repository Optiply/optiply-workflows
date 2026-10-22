import { bigqueryConnector } from './bigquery'
import { mysqlConnector } from './mysql'
import { postgresConnector } from './postgres'
import { restConnector } from './rest'
import type { AnyConnector } from './types'

export { type FlowSandbox, runAuthFlow } from './auth-flow'
export { type BigQueryEndpoints, bigqueryConnector, createBigQueryConnector } from './bigquery'
export {
  CodeFetcher,
  type CodeFetcherOptions,
  type CodeFetchRequest,
  type CodeFetchResponse,
} from './code-fetch'
export { mysqlConnector } from './mysql'
export { BlockedAddressError, isPrivateAddress } from './net-guard'
export {
  type AuthorizationCodeSettings,
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  OAuthGrantError,
  parseTokenSet,
  refreshAccessToken,
  type TokenRequestOptions,
  type TokenSet,
} from './oauth'
export {
  fillPlaceholders,
  OAUTH_PROVIDERS,
  type OAuthProviderId,
  type OAuthProviderPreset,
  oauthPresets,
} from './oauth-presets'
export { PoolManager, type PoolOptions, parseResource } from './pool'
export { postgresConnector } from './postgres'
export { type AuthFlowStep, type RestConfig, type RestQuery, type RestSecrets, restConnector } from './rest'
export { type RunOptions, runQuery, testResource } from './run'
export { readPrivateKey, type SshKey, SshKeyError, type SshKeyErrorCode } from './ssh/keys'
export {
  normalizeSsh,
  SSH_MAX_HOPS,
  type SshConfig,
  type SshCredential,
  type SshHop,
  type SshSecrets,
  SshSettingsError,
  sshConfigSchema,
  sshCredentials,
  sshSecretsSchema,
} from './ssh/settings'
export {
  SshError,
  type SshErrorCode,
  type SshHostKey,
  SshTunnel,
  type SshTunnelOptions,
  type TunnelHop,
} from './ssh/tunnel'
export * from './types'

/** Every connector type that resources can use, by `resources.type`. */
export const connectors: Readonly<Record<string, AnyConnector>> = {
  [postgresConnector.type]: postgresConnector,
  [mysqlConnector.type]: mysqlConnector,
  [bigqueryConnector.type]: bigqueryConnector,
  [restConnector.type]: restConnector,
}

export function getConnector(type: string): AnyConnector | undefined {
  return Object.hasOwn(connectors, type) ? connectors[type] : undefined
}
