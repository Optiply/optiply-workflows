import type { AdapterContext, QueueAdapter } from '../queue-consumer'
import { kafkaAdapter } from './kafka'
import { kinesisAdapter } from './kinesis'
import { pubsubAdapter } from './pubsub'
import { rabbitmqAdapter } from './rabbitmq'
import { sqsAdapter } from './sqs'

/** The adapter for a trigger's kind. */
export function createAdapter(ctx: AdapterContext): QueueAdapter {
  switch (ctx.trigger.kind) {
    case 'pubsub':
      return pubsubAdapter(ctx)
    case 'sqs':
      return sqsAdapter(ctx)
    case 'kafka':
      return kafkaAdapter(ctx)
    case 'rabbitmq':
      return rabbitmqAdapter(ctx)
    case 'kinesis':
      return kinesisAdapter(ctx)
    default:
      throw new Error(`no queue adapter for "${ctx.trigger.kind}"`)
  }
}
