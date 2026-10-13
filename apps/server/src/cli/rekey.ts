/**
 * Re-encrypts every stored secret under the current key (ENCRYPTION_KEY_CURRENT). To rotate keys:
 *   1. append a new key to ENCRYPTION_KEYS (keep the old one) and point ENCRYPTION_KEY_CURRENT at it
 *   2. deploy, then run: pnpm --filter @ow/server rekey [-- --dry-run]
 *      (in the image: node --no-node-snapshot dist/cli/rekey.js [--dry-run])
 *   3. once it reports no failures, remove the old key from ENCRYPTION_KEYS
 */
import { parseArgs } from 'node:util'
import { createDb } from '@ow/db'
import { loadConfig } from '../config'
import { rekeyAll } from '../services/secrets'
import { cliArgs } from './args'

const { values } = parseArgs({ args: cliArgs(), options: { 'dry-run': { type: 'boolean', default: false } } })
const dryRun = values['dry-run']

const config = loadConfig()
const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
const reports = await rekeyAll(db, config.keyring, { dryRun })
await close()

console.log(`${dryRun ? '[dry run] ' : ''}Current key: ${config.keyring.current}`)
for (const r of reports) {
  console.log(
    `  ${r.table}: ${r.rekeyed} ${dryRun ? 'to re-encrypt' : 're-encrypted'}, ${r.failed.length} failed`,
  )
  for (const id of r.failed) console.log(`    failed to decrypt row ${id}`)
}
if (reports.some((r) => r.failed.length)) {
  console.error(
    'Some rows could not be decrypted with the configured keys. Keep the old keys until resolved.',
  )
  process.exit(1)
}
