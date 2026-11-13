import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { BlockList, isIP } from 'node:net'

/**
 * Addresses a user-supplied URL must not reach unless the resource opts in: loopback, private and shared address
 * space, link-local (incl. cloud metadata at 169.254.169.254), multicast and reserved ranges. Node's BlockList
 * also matches IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) against the IPv4 rules.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError'
  readonly code = 'OW_BLOCKED_ADDRESS'
}

export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '')
  const family = isIP(host)
  if (family === 0) return false
  return blocked.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * A `dns.lookup` replacement for socket connections that refuses private addresses. Checking at connect time,
 * on the addresses actually used, means a hostname that resolves (or later re-resolves) to an internal IP is
 * still blocked.
 */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, '')
    const list: LookupAddress[] = Array.isArray(address) ? address : [{ address, family: family ?? 4 }]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (bad) {
      return callback(
        new BlockedAddressError(
          `${hostname} resolves to a private address (${bad.address})`,
        ) as NodeJS.ErrnoException,
        '',
      )
    }
    callback(null, address, family)
  })
}

/**
 * `guardedLookup`, except that hostnames matching `hosts` (patterns as `hostMatches`) may resolve to private addresses:
 * hosts an admin allowed by name (the built-in REST API resource's `REST_API_PRIVATE_HOSTS`, M27).
 */
export function guardedLookupExcept(hosts: readonly string[]) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    if (hosts.some((p) => hostMatches(hostname, p))) dnsLookup(hostname, options, callback)
    else guardedLookup(hostname, options, callback)
  }
}

/** `api.example.com` matches itself; `*.example.com` matches any subdomain (not the apex). */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase()
  const p = pattern.trim().toLowerCase()
  if (p.startsWith('*.')) return host.endsWith(p.slice(1))
  return host === p
}
