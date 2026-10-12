/**
 * Creates (or updates) a break-glass local admin with an email/password login.
 *   pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name "Admin"
 * The password is read from ADMIN_PASSWORD or prompted for interactively.
 */
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createDb } from '@ow/db'
import { hashPassword } from '../auth/password'
import { loadConfig } from '../config'
import { provisionUser } from '../services/users'

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' } },
})
if (!values.email) {
  console.error('Usage: create-admin --email <email> [--name <name>]')
  process.exit(1)
}

let password = process.env.ADMIN_PASSWORD
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  password = await rl.question('Password (min 12 chars): ')
  rl.close()
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters')
  process.exit(1)
}

const config = loadConfig()
const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
const user = await provisionUser(
  db,
  { email: values.email, name: values.name ?? values.email, passwordHash: await hashPassword(password) },
  { makeAdmin: true },
)
await close()
console.log(`${user.created ? 'Created' : 'Updated'} admin ${values.email}`)
if (!config.LOCAL_LOGIN_ENABLED) console.log('Note: set LOCAL_LOGIN_ENABLED=true to allow password login.')
