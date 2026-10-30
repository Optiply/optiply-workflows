import { configureRestApi } from '@ow/connectors'
import type { Config } from '../config'

/** Instance settings of the HTTP connectors (M27), in every process that runs queries. */
export function configureConnectors(config: Pick<Config, 'REST_API_PRIVATE_HOSTS'>): void {
  configureRestApi({ privateHosts: config.REST_API_PRIVATE_HOSTS })
}
