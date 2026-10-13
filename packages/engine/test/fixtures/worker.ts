/**
 * A worker in its own process, for the crash test: it's killed with SIGKILL mid-run. Started by
 * crash.test.ts with DATABASE_URL pointing at the test database.
 */
import { PoolManager } from '@ow/connectors'
import { Dispatcher } from '../../src'
import { connect, postgresResources } from '../pg-harness'

const url = process.env.DATABASE_URL!
const { db, sql } = connect(url)
const dispatcher = new Dispatcher({
  db,
  listener: sql,
  pool: new PoolManager({ sweepIntervalMs: 0 }),
  resources: postgresResources(url),
  workerId: 'doomed-worker',
  leaseMs: 1000,
  pollIntervalMs: 200,
})
await dispatcher.start()
process.send?.('ready')
