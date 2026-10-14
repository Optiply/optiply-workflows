import { postgresConnector } from './postgres'
import { restConnector } from './rest'
import type { AnyConnector } from './types'

export {
  CodeFetcher,
  type CodeFetcherOptions,
  type CodeFetchRequest,
  type CodeFetchResponse,
} from './code-fetch'
export { BlockedAddressError, isPrivateAddress } from './net-guard'
export { PoolManager, type PoolOptions, parseResource } from './pool'
export { postgresConnector } from './postgres'
export { restConnector } from './rest'
export { type RunOptions, runQuery, testResource } from './run'
export * from './types'

/** Every connector type that resources can use, by `resources.type`. */
export const connectors: Readonly<Record<string, AnyConnector>> = {
  [postgresConnector.type]: postgresConnector,
  [restConnector.type]: restConnector,
}

export function getConnector(type: string): AnyConnector | undefined {
  return Object.hasOwn(connectors, type) ? connectors[type] : undefined
}
