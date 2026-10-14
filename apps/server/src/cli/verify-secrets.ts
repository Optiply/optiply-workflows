/**
 * Checks that every stored secret decrypts with the configured ENCRYPTION_KEYS, changing nothing. Run it after
 * restoring a backup, and before removing an old key:
 *   pnpm --filter @ow/server verify-secrets
 *   (in the image: node --no-node-snapshot dist/cli/verify-secrets.js)
 * Exits 1 when any value fails to decrypt.
 */
import { createDb } from '@ow/db'
import { loadConfig } from '../config'
import { verifySecrets } from '../services/secrets'

const config = loadConfig()
const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
const reports = await verifySecrets(db, config.keyring)
await close()

console.log(
  `Keys configured: ${[...config.keyring.keys.keys()].join(', ')} (current ${config.keyring.current})`,
)
for (const r of reports) {
  const keys = Object.entries(r.keys)
    .map(([v, n]) => `${n} under ${v}`)
    .join(', ')
  console.log(`  ${r.table}: ${r.ok} decrypted, ${r.failed.length} failed${keys ? ` (${keys})` : ''}`)
  for (const id of r.failed) console.log(`    failed to decrypt row ${id}`)
}
if (reports.some((r) => r.failed.length)) {
  console.error(
    'Some secrets could not be decrypted with these keys: they belong to another key, or were changed.',
  )
  process.exit(1)
}
console.log('All secrets decrypt with the configured keys.')
