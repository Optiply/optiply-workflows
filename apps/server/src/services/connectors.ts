import { configureRestApi, configureServiceUrls } from '@ow/connectors'
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
>

/** Instance settings of the HTTP connectors (M27), in every process that runs queries. */
export function configureConnectors(config: ConnectorsConfig): void {
  configureRestApi({ privateHosts: config.REST_API_PRIVATE_HOSTS })
  configureServiceUrls({
    ...(config.SLACK_API_URL && { slack: config.SLACK_API_URL }),
    ...(config.HUBSPOT_API_URL && { hubspot: config.HUBSPOT_API_URL }),
    ...(config.SENDGRID_API_URL && { sendgrid: config.SENDGRID_API_URL }),
    ...(config.SENDGRID_EU_API_URL && { sendgridEu: config.SENDGRID_EU_API_URL }),
    ...(config.GOOGLE_SHEETS_API_URL && { sheets: config.GOOGLE_SHEETS_API_URL }),
    ...(config.GOOGLE_DRIVE_API_URL && { drive: config.GOOGLE_DRIVE_API_URL }),
  })
}
