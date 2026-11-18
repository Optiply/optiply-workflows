import { anthropicConnector } from './ai/anthropic'
import { geminiConnector } from './ai/gemini'
import { openaiCompatibleConnector } from './ai/openai'
import { s3Connector } from './aws/s3'
import { bigqueryConnector } from './bigquery'
import { graphqlConnector } from './graphql'
import { jdbcConnector } from './jdbc/connector'
import { mssqlConnector } from './mssql/connector'
import { mysqlConnector } from './mysql'
import { openapiConnector } from './openapi'
import { postgresConnector } from './postgres'
import type { RestConfig } from './rest'
import { restConnector } from './rest'
import { restApiConnector } from './restapi'
import { sdkConnector } from './sdk/connector'
import { airtableConnector } from './services/airtable'
import { gmailConnector } from './services/gmail'
import { googleSheetsConnector } from './services/googlesheets'
import { hubspotConnector } from './services/hubspot'
import { jiraConnector } from './services/jira'
import { msteamsConnector } from './services/msteams'
import { notionConnector } from './services/notion'
import { salesforceConnector } from './services/salesforce'
import { sendgridConnector } from './services/sendgrid'
import { slackConnector } from './services/slack'
import { stripeConnector } from './services/stripe'
import type { AnyConnector } from './types'

export { anthropicConnector } from './ai/anthropic'
export type { AiRunContext, AiToolHost, AiToolSpec } from './ai/core'
export { configureGemini, type GeminiDefaults, geminiConnector, VERTEX_SCOPE } from './ai/gemini'
export { openaiCompatibleConnector } from './ai/openai'
export {
  AI_RESOURCE_TYPES,
  type AiUsage,
  ANTHROPIC_MODELS,
  ANTHROPIC_PRICES,
  costOf,
  DEFAULT_ANTHROPIC_MODEL,
  tokensOf,
} from './ai/prices'
export { aiStats } from './ai/stats'
export { type FlowSandbox, runAuthFlow } from './auth-flow'
export {
  type AwsDefaults,
  type AwsIdentity,
  awsCredentials,
  awsDefaults,
  awsError,
  awsIdentityConfig,
  awsIdentitySecrets,
  configureAws,
  describeAws,
} from './aws/credentials'
export { S3_MAX_BYTES, type S3Handle, s3Client, s3Connector } from './aws/s3'
export { type BigQueryEndpoints, bigqueryConnector, createBigQueryConnector } from './bigquery'
export {
  CodeFetcher,
  type CodeFetcherOptions,
  type CodeFetchRequest,
  type CodeFetchResponse,
} from './code-fetch'
export {
  type GoogleTokens,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServerIdentity,
  type ServerIdentityOptions,
  serverIdentity,
} from './google-auth'
export { type GraphqlQuery, graphqlConnector, graphqlIntrospect } from './graphql'
export {
  buildBody,
  createHttpClient,
  destroyHttpClient,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  httpError,
  httpRequest,
} from './http-core'
export { expandParams as jdbcExpandParams, jdbcConnector } from './jdbc/connector'
export {
  configureJdbcForwarder,
  JdbcForwarder,
  type JdbcTunnel,
  jdbcForwarder,
  normalHost as jdbcNormalHost,
} from './jdbc/forwarder'
export {
  configureJdbcDrivers,
  configureJdbcRunner,
  type JarSource,
  type JdbcQueryRequest,
  type JdbcRunner,
  JdbcRunnerClient,
  jdbcRunner,
  type UploadedDriver,
} from './jdbc/runner'
export {
  JDBC_DEFAULT_PORTS,
  JDBC_DRIVERS,
  JDBC_URL_PREFIXES,
  JDBC_URL_TEMPLATES,
  type JdbcConfig,
  type JdbcConnection,
  type JdbcDriver,
  type JdbcSecrets,
  jdbcConnection,
  jdbcUrl,
  snowflakeHost,
} from './jdbc/settings'
export {
  cellValue as mssqlCellValue,
  endsTransaction as mssqlEndsTransaction,
  MSSQL_AUTH_TYPES,
  type MssqlAuth,
  mssqlConnector,
} from './mssql/connector'
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
  revokeToken,
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
export {
  buildOperationRequest,
  exampleOf,
  OPENAPI_MAX_SPEC,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  openApiDocument,
  openapiConnector,
  parseOpenApi,
} from './openapi'
export { PoolManager, type PoolOptions, parseResource } from './pool'
export { postgresConnector } from './postgres'
export {
  type AuthFlowStep,
  type RestAuth,
  type RestConfig,
  type RestQuery,
  type RestSecrets,
  restConfigSchema,
  restConnector,
  restQuerySchema,
  restSecretsSchema,
} from './rest'
export { configureRestApi, type RestApiQuery, restApiConnector } from './restapi'
export { queryStats, type RunOptions, runOperation, runQuery, testResource } from './run'
export { SDK_TEST_INSTALL_MS, sdkAllowedHosts, sdkConnector } from './sdk/connector'
export {
  configureSdkEnvs,
  configureSdkRunner,
  type SdkEnvProvider,
  type SdkEnvSpec,
  type SdkOutcome,
  type SdkRunner,
  SdkRunnerClient,
  type SdkRunRequest,
  sdkEnvs,
  sdkRunner,
} from './sdk/runner'
export { airtableConnector } from './services/airtable'
export { configureServiceUrls, type ServiceUrls } from './services/common'
export { configureGmail, GMAIL_SCOPE, type GmailDefaults, gmailConnector } from './services/gmail'
export {
  configureSheets,
  googleSheetsConnector,
  SHEETS_SCOPE,
  type SheetsClient,
  type SheetsDefaults,
  spreadsheetId,
} from './services/googlesheets'
export { type HubSpotProperty, hubspotConnector, hubspotProperties } from './services/hubspot'
export { jiraConnector } from './services/jira'
export { msteamsConnector, TEAMS_SCOPE } from './services/msteams'
export { notionConnector } from './services/notion'
export { salesforceConnector } from './services/salesforce'
export { sendgridConnector } from './services/sendgrid'
export { slackConnector } from './services/slack'
export { stripeConnector, stripeForm } from './services/stripe'
export { checkSshIap, configureIap, IAP_SCOPE, type IapDefaults } from './ssh/client'
export { IapError, type IapErrorCode, type IapTarget } from './ssh/iap'
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
  onSshTunnelEvent,
  SshError,
  type SshErrorCode,
  type SshHostKey,
  type SshTestStep,
  SshTunnel,
  type SshTunnelEvent,
  type SshTunnelOptions,
  sshTunnelStats,
  type TunnelHop,
  type TunnelIap,
} from './ssh/tunnel'
export * from './types'

/** Every connector type that resources can use, by `resources.type`. */
export const connectors: Readonly<Record<string, AnyConnector>> = {
  [postgresConnector.type]: postgresConnector,
  [mysqlConnector.type]: mysqlConnector,
  [mssqlConnector.type]: mssqlConnector,
  [jdbcConnector.type]: jdbcConnector,
  [bigqueryConnector.type]: bigqueryConnector,
  [restConnector.type]: restConnector,
  [restApiConnector.type]: restApiConnector,
  [graphqlConnector.type]: graphqlConnector,
  [openapiConnector.type]: openapiConnector,
  [slackConnector.type]: slackConnector,
  [hubspotConnector.type]: hubspotConnector,
  [sendgridConnector.type]: sendgridConnector,
  [googleSheetsConnector.type]: googleSheetsConnector,
  [s3Connector.type]: s3Connector,
  [stripeConnector.type]: stripeConnector,
  [airtableConnector.type]: airtableConnector,
  [jiraConnector.type]: jiraConnector,
  [notionConnector.type]: notionConnector,
  [salesforceConnector.type]: salesforceConnector,
  [gmailConnector.type]: gmailConnector,
  [msteamsConnector.type]: msteamsConnector,
  [sdkConnector.type]: sdkConnector,
  [anthropicConnector.type]: anthropicConnector,
  [openaiCompatibleConnector.type]: openaiCompatibleConnector,
  [geminiConnector.type]: geminiConnector,
}

export function getConnector(type: string): AnyConnector | undefined {
  return Object.hasOwn(connectors, type) ? connectors[type] : undefined
}

/**
 * The REST-shaped settings a resource of `type` connects with (M27: REST, GraphQL, the services), or null for other
 * types and for settings that don't parse. The OAuth and custom auth flow code works from these.
 */
export function httpConfigFor(type: string, config: unknown): RestConfig | null {
  const connector = connectors[type]
  if (!connector?.httpConfig) return null
  const parsed = connector.configSchema.safeParse(config)
  return parsed.success ? connector.httpConfig(parsed.data) : null
}
