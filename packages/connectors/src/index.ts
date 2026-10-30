import { sqsConnector } from './aws/sqs'
import { bigqueryConnector } from './bigquery'
import { kafkaConnector } from './kafka/connector'
import { mysqlConnector } from './mysql'
import { postgresConnector } from './postgres'
import { pubsubConnector } from './pubsub/connector'
import { restConnector } from './rest'
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
export { type MskIamToken, mskIamToken } from './kafka/msk-iam'
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
export { type AuthFlowStep, type RestConfig, type RestQuery, type RestSecrets, restConnector } from './rest'
export { type RunOptions, runQuery, testResource } from './run'
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
  [pubsubConnector.type]: pubsubConnector,
  [sqsConnector.type]: sqsConnector,
  [kafkaConnector.type]: kafkaConnector,
}

export function getConnector(type: string): AnyConnector | undefined {
  return Object.hasOwn(connectors, type) ? connectors[type] : undefined
}
