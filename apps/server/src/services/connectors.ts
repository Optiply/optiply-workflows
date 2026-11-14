import {
  configureJdbcForwarder,
  configureJdbcRunner,
  configureRestApi,
  configureSdkRunner,
  configureServiceUrls,
  JdbcForwarder,
  JdbcRunnerClient,
  SdkRunnerClient,
} from '@ow/connectors'
import type { Config } from '../config'

type ConnectorsConfig = Pick<
  Config,
  | 'REST_API_PRIVATE_HOSTS'
  | 'SLACK_API_URL'
  | 'HUBSPOT_API_URL'
  | 'SENDGRID_API_URL'
  | 'SENDGRID_EU_API_URL'
  | 'GOOGLE_SHEETS_API_URL'
  | 'GOOGLE_DRIVE_API_URL'
  | 'STRIPE_API_URL'
  | 'AIRTABLE_API_URL'
  | 'NOTION_API_URL'
  | 'SALESFORCE_URL'
  | 'GMAIL_API_URL'
  | 'MICROSOFT_GRAPH_URL'
  | 'TEAMS_WEBHOOK_URL'
  | 'SDK_RUNNER_URL'
  | 'SDK_RUNNER_TOKEN'
  | 'JDBC_RUNNER_URL'
  | 'JDBC_RUNNER_TOKEN'
  | 'JDBC_FORWARDER_PORT'
  | 'JDBC_FORWARDER_HOST'
>

/** Instance settings of the HTTP connectors (M27), in every process that runs queries. */
export function configureConnectors(config: ConnectorsConfig): void {
  configureRestApi({ privateHosts: config.REST_API_PRIVATE_HOSTS })
  // SDK resources (M37): their calls go to the SDK runner.
  configureSdkRunner(
    config.SDK_RUNNER_URL && config.SDK_RUNNER_TOKEN
      ? new SdkRunnerClient({ url: config.SDK_RUNNER_URL, token: config.SDK_RUNNER_TOKEN })
      : null,
  )
  // JDBC resources (M38): their queries run in the JDBC runner.
  configureJdbcRunner(
    config.JDBC_RUNNER_URL && config.JDBC_RUNNER_TOKEN
      ? new JdbcRunnerClient({ url: config.JDBC_RUNNER_URL, token: config.JDBC_RUNNER_TOKEN })
      : null,
  )
  // Its SSH tunnels (step 4): the runner connects back here, and the bytes go through this process's tunnel.
  configureJdbcForwarder(
    config.JDBC_FORWARDER_PORT !== undefined
      ? new JdbcForwarder({
          port: config.JDBC_FORWARDER_PORT,
          ...(config.JDBC_FORWARDER_HOST ? { advertise: config.JDBC_FORWARDER_HOST } : {}),
        })
      : null,
  )
  configureServiceUrls({
    ...(config.SLACK_API_URL && { slack: config.SLACK_API_URL }),
    ...(config.HUBSPOT_API_URL && { hubspot: config.HUBSPOT_API_URL }),
    ...(config.SENDGRID_API_URL && { sendgrid: config.SENDGRID_API_URL }),
    ...(config.SENDGRID_EU_API_URL && { sendgridEu: config.SENDGRID_EU_API_URL }),
    ...(config.GOOGLE_SHEETS_API_URL && { sheets: config.GOOGLE_SHEETS_API_URL }),
    ...(config.GOOGLE_DRIVE_API_URL && { drive: config.GOOGLE_DRIVE_API_URL }),
    ...(config.STRIPE_API_URL && { stripe: config.STRIPE_API_URL }),
    ...(config.AIRTABLE_API_URL && { airtable: config.AIRTABLE_API_URL }),
    ...(config.NOTION_API_URL && { notion: config.NOTION_API_URL }),
    ...(config.SALESFORCE_URL && { salesforce: config.SALESFORCE_URL }),
    ...(config.GMAIL_API_URL && { gmail: config.GMAIL_API_URL }),
    ...(config.MICROSOFT_GRAPH_URL && { graph: config.MICROSOFT_GRAPH_URL }),
    ...(config.TEAMS_WEBHOOK_URL && { teamsWebhook: config.TEAMS_WEBHOOK_URL }),
  })
}
