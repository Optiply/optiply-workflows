import { kinesisConnector } from './aws/kinesis'
import { s3Connector } from './aws/s3'
import { snsConnector } from './aws/sns'
import { sqsConnector } from './aws/sqs'
import { bigqueryConnector } from './bigquery'
import { graphqlConnector } from './graphql'
import { kafkaConnector } from './kafka/connector'
import { mysqlConnector } from './mysql'
import { openapiConnector } from './openapi'
import { postgresConnector } from './postgres'
import { pubsubConnector } from './pubsub/connector'
import { rabbitmqConnector } from './rabbitmq/connector'
import type { RestConfig } from './rest'
import { restConnector } from './rest'
import { restApiConnector } from './restapi'
import { airtableConnector } from './services/airtable'
import { googleSheetsConnector } from './services/googlesheets'
import { hubspotConnector } from './services/hubspot'
import { jiraConnector } from './services/jira'
import { notionConnector } from './services/notion'
import { salesforceConnector } from './services/salesforce'
import { sendgridConnector } from './services/sendgrid'
import { slackConnector } from './services/slack'
import { stripeConnector } from './services/stripe'
import type { AnyConnector } from './types'

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
export {
  type KinesisRecord,
  type KinesisResourceClient,
  kinesisClient,
  kinesisConnector,
  kinesisRecord,
  streamRef,
} from './aws/kinesis'
export { S3_MAX_BYTES, type S3Handle, s3Client, s3Connector } from './aws/s3'
export { snsConnector, snsMessage } from './aws/sns'
export { type SqsReceived, type SqsResourceClient, sqsClient, sqsConnector } from './aws/sqs'
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
export {
  type KafkaAdmin,
  type KafkaClientExtras,
  type KafkaProducer,
  type KafkaResourceClient,
  kafkaClient,
  kafkaError,
  type RdkafkaSettings,
  withSignal,
} from './kafka/client'
export {
  type KafkaAuth,
  type KafkaConfig,
  type KafkaSecrets,
  kafkaSettingsProblem,
  usesTls,
} from './kafka/config'
export {
  kafkaConnector,
  kafkaResourceClient,
  type OutgoingKafkaMessage,
  produceTo,
} from './kafka/connector'
export {
  type KafkaConsumerHandle,
  type KafkaConsumerOptions,
  type KafkaPartition,
  type KafkaReceived,
  kafkaConsumer,
} from './kafka/consumer'
export { type MskIamToken, mskIamToken } from './kafka/msk-iam'
export { type SchemaRegistry, schemaRegistry, wireSchemaId } from './kafka/registry'
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
  MAX_ACK_DEADLINE_SECONDS,
  type OutgoingMessage,
  PubSubClient,
  type PubSubMessage,
  type ReceivedMessage,
  resourcePath,
  type SubscriptionInfo,
} from './pubsub/client'
export {
  configurePubSub,
  type PubSubDefaults,
  type PubSubResourceClient,
  pubsubClient,
  pubsubConnector,
} from './pubsub/connector'
export {
  type RabbitClient,
  type RabbitConfig,
  type RabbitSecrets,
  rabbitClient,
  rabbitConfigSchema,
  rabbitError,
} from './rabbitmq/client'
export { publishTo, rabbitMessage, rabbitmqConnector } from './rabbitmq/connector'
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
export { airtableConnector } from './services/airtable'
export { configureServiceUrls, type ServiceUrls } from './services/common'
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
  [bigqueryConnector.type]: bigqueryConnector,
  [restConnector.type]: restConnector,
  [restApiConnector.type]: restApiConnector,
  [graphqlConnector.type]: graphqlConnector,
  [openapiConnector.type]: openapiConnector,
  [slackConnector.type]: slackConnector,
  [hubspotConnector.type]: hubspotConnector,
  [sendgridConnector.type]: sendgridConnector,
  [googleSheetsConnector.type]: googleSheetsConnector,
  [pubsubConnector.type]: pubsubConnector,
  [sqsConnector.type]: sqsConnector,
  [kafkaConnector.type]: kafkaConnector,
  [rabbitmqConnector.type]: rabbitmqConnector,
  [snsConnector.type]: snsConnector,
  [kinesisConnector.type]: kinesisConnector,
  [s3Connector.type]: s3Connector,
  [stripeConnector.type]: stripeConnector,
  [airtableConnector.type]: airtableConnector,
  [jiraConnector.type]: jiraConnector,
  [notionConnector.type]: notionConnector,
  [salesforceConnector.type]: salesforceConnector,
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
