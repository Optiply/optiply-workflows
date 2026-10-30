import type { AdapterContext, QueueAdapter } from '../queue-consumer'
import { pubsubAdapter } from './pubsub'

/** The adapter for a trigger's kind. */
export function createAdapter(ctx: AdapterContext): QueueAdapter {
  switch (ctx.trigger.kind) {
    case 'pubsub':
      return pubsubAdapter(ctx)
    default:
      throw new Error(`no queue adapter for "${ctx.trigger.kind}"`)
  }
}
