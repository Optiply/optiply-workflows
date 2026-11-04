import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { jsonError, type ServiceHandler, type SignedRequest } from './fake'

/**
 * The fake AWS's SQS (M26), over SQS's JSON protocol: standard and FIFO queues, visibility timeouts, receive counts,
 * a redrive policy moving a message to its dead-letter queue, long polling, delays. Time runs `secondMs` to a second.
 */
export interface FakeSqsOptions {
  /** How long an SQS second lasts here (default 1000): 50 makes a 30 s visibility timeout pass in 1.5 s. */
  secondMs?: number
  /** At most this long a receive waits for messages, whatever it asks (default 20 s of real time). */
  maxWaitMs?: number
}

export interface FakeSqsQueueOptions {
  /** Seconds a received message stays invisible (default 30). */
  visibilityTimeout?: number
  redrive?: { deadLetterQueue: string; maxReceiveCount: number }
  contentBasedDeduplication?: boolean
}

export interface FakeSqsMessage {
  messageId: string
  body: string
  attributes: Record<string, { DataType: string; StringValue?: string }>
  groupId?: string
  deduplicationId?: string
  sequenceNumber?: string
  sentAt: number
  receiveCount: number
  /** When it can be received (again): sent with a delay, or in flight until its visibility runs out. */
  visibleAt: number
  /** The latest receive's handle: only it deletes or changes the message. */
  receipt: string | null
  deleted: boolean
  /** Moved here from another queue by its redrive policy. */
  movedFrom?: string
}

export interface FakeSqs {
  createQueue(name: string, opts?: FakeSqsQueueOptions): string
  queueUrl(name: string): string
  /** Sends as a producer would, without signing. Returns the message id. */
  send(
    queue: string,
    body: string,
    opts?: {
      attributes?: Record<string, string>
      groupId?: string
      deduplicationId?: string
      delaySeconds?: number
    },
  ): string
  /** Every message the queue has had, deleted ones included, oldest first. */
  messages(queue: string): FakeSqsMessage[]
  /** Makes a message visible at once, as a lost delete leaves it: it comes back with a new receipt handle. */
  redeliver(queue: string, messageId: string): void
}

interface Queue {
  name: string
  fifo: boolean
  opts: FakeSqsQueueOptions
  messages: FakeSqsMessage[]
  dedup: Map<string, string>
  sequence: number
}

export function fakeSqs(
  handlers: Map<string, ServiceHandler>,
  account: string,
  baseUrl: () => string,
  opts: FakeSqsOptions = {},
): FakeSqs {
  const secondMs = opts.secondMs ?? 1000
  const maxWaitMs = opts.maxWaitMs ?? 20_000
  const queues = new Map<string, Queue>()
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const w of [...waiters]) w()
  }

  const urlOf = (name: string) => `${baseUrl()}/${account}/${name}`
  const queueOf = (urlOrName: unknown): Queue | undefined =>
    queues.get(
      String(urlOrName ?? '')
        .split('/')
        .pop() ?? '',
    )

  function enqueue(
    q: Queue,
    body: string,
    m: {
      attributes?: FakeSqsMessage['attributes']
      groupId?: string
      deduplicationId?: string
      delaySeconds?: number
    },
  ): { messageId: string; sequenceNumber?: string } | { error: string; message: string } {
    if (q.fifo && !m.groupId)
      return { error: 'MissingParameter', message: 'The request must contain MessageGroupId.' }
    const dedupId =
      m.deduplicationId ??
      (q.fifo && q.opts.contentBasedDeduplication
        ? createHash('sha256').update(body).digest('hex')
        : undefined)
    if (q.fifo && !dedupId)
      return {
        error: 'InvalidParameterValue',
        message:
          'The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided',
      }
    if (q.fifo && dedupId && q.dedup.has(dedupId)) {
      const earlier = q.messages.find((x) => x.messageId === q.dedup.get(dedupId))!
      return {
        messageId: earlier.messageId,
        ...(earlier.sequenceNumber ? { sequenceNumber: earlier.sequenceNumber } : {}),
      }
    }
    const now = Date.now()
    const message: FakeSqsMessage = {
      messageId: randomUUID(),
      body,
      attributes: m.attributes ?? {},
      ...(m.groupId ? { groupId: m.groupId } : {}),
      ...(dedupId ? { deduplicationId: dedupId } : {}),
      ...(q.fifo ? { sequenceNumber: String(++q.sequence).padStart(20, '0') } : {}),
      sentAt: now,
      receiveCount: 0,
      visibleAt: now + (m.delaySeconds ?? 0) * secondMs,
      receipt: null,
      deleted: false,
    }
    q.messages.push(message)
    if (dedupId) q.dedup.set(dedupId, message.messageId)
    wake()
    return {
      messageId: message.messageId,
      ...(message.sequenceNumber ? { sequenceNumber: message.sequenceNumber } : {}),
    }
  }

  /** Visible messages to hand out now, moving those past the redrive's count to the dead-letter queue. */
  function take(q: Queue, max: number, visibilitySeconds: number): FakeSqsMessage[] {
    const now = Date.now()
    const out: FakeSqsMessage[] = []
    const busyGroups = new Set(
      q.messages
        .filter((m) => !m.deleted && m.groupId && m.visibleAt > now && m.receipt)
        .map((m) => m.groupId!),
    )
    for (const m of q.messages) {
      if (out.length >= max) break
      if (m.deleted || m.visibleAt > now) continue
      if (q.fifo && busyGroups.has(m.groupId!) && !out.some((o) => o.groupId === m.groupId)) continue
      const redrive = q.opts.redrive
      if (redrive && m.receiveCount >= redrive.maxReceiveCount) {
        m.deleted = true
        const dlq = queues.get(redrive.deadLetterQueue)
        if (dlq)
          dlq.messages.push({
            ...m,
            deleted: false,
            receiveCount: 0,
            receipt: null,
            visibleAt: now,
            movedFrom: q.name,
          })
        continue
      }
      if (q.fifo) {
        // A group's next message only after the one before: earlier ones still waiting (delayed) block it too.
        const earlier = q.messages.find(
          (x) => !x.deleted && x.groupId === m.groupId && x !== m && x.visibleAt > now && !out.includes(x),
        )
        if (earlier && q.messages.indexOf(earlier) < q.messages.indexOf(m)) {
          busyGroups.add(m.groupId!)
          continue
        }
      }
      m.receiveCount++
      m.receipt = randomBytes(24).toString('base64url')
      m.visibleAt = now + visibilitySeconds * secondMs
      out.push(m)
      if (q.fifo) busyGroups.add(m.groupId!)
    }
    return out
  }

  function wire(m: FakeSqsMessage) {
    return {
      MessageId: m.messageId,
      ReceiptHandle: m.receipt,
      MD5OfBody: createHash('md5').update(m.body).digest('hex'),
      Body: m.body,
      Attributes: {
        SenderId: 'AIDAFAKE',
        SentTimestamp: String(m.sentAt),
        ApproximateReceiveCount: String(m.receiveCount),
        ApproximateFirstReceiveTimestamp: String(m.sentAt),
        ...(m.groupId ? { MessageGroupId: m.groupId } : {}),
        ...(m.deduplicationId ? { MessageDeduplicationId: m.deduplicationId } : {}),
        ...(m.sequenceNumber ? { SequenceNumber: m.sequenceNumber } : {}),
        ...(m.movedFrom
          ? { DeadLetterQueueSourceArn: `arn:aws:sqs:eu-west-1:${account}:${m.movedFrom}` }
          : {}),
      },
      ...(Object.keys(m.attributes).length ? { MessageAttributes: m.attributes } : {}),
    }
  }

  function byReceipt(q: Queue, receipt: unknown): FakeSqsMessage | undefined {
    return q.messages.find((m) => !m.deleted && m.receipt === receipt)
  }

  const handler: ServiceHandler = async (req: SignedRequest, res: ServerResponse) => {
    const action = String(req.headers['x-amz-target'] ?? '')
      .split('.')
      .pop()
    const input = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>
    const ok = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' })
      res.end(JSON.stringify(body))
    }
    if (action === 'ListQueues') {
      const prefix = String(input.QueueNamePrefix ?? '')
      return ok({ QueueUrls: [...queues.keys()].filter((n) => n.startsWith(prefix)).map(urlOf) })
    }
    if (action === 'GetQueueUrl') {
      const q = queues.get(String(input.QueueName))
      return q
        ? ok({ QueueUrl: urlOf(q.name) })
        : jsonError(res, 400, 'QueueDoesNotExist', 'The specified queue does not exist.')
    }
    const q = queueOf(input.QueueUrl)
    if (!q) return jsonError(res, 400, 'QueueDoesNotExist', 'The specified queue does not exist.')
    switch (action) {
      case 'GetQueueAttributes':
        return ok({
          Attributes: {
            QueueArn: `arn:aws:sqs:${req.region}:${account}:${q.name}`,
            VisibilityTimeout: String(q.opts.visibilityTimeout ?? 30),
            FifoQueue: String(q.fifo),
            ApproximateNumberOfMessages: String(
              q.messages.filter((m) => !m.deleted && m.visibleAt <= Date.now()).length,
            ),
            ...(q.opts.redrive
              ? {
                  RedrivePolicy: JSON.stringify({
                    deadLetterTargetArn: `arn:aws:sqs:${req.region}:${account}:${q.opts.redrive.deadLetterQueue}`,
                    maxReceiveCount: q.opts.redrive.maxReceiveCount,
                  }),
                }
              : {}),
          },
        })
      case 'SendMessage':
      case 'SendMessageBatch': {
        const entries = (
          action === 'SendMessage' ? [{ Id: 'only', ...input }] : (input.Entries as Record<string, unknown>[])
        ) as Record<string, unknown>[]
        if (!entries?.length || entries.length > 10)
          return jsonError(
            res,
            400,
            'TooManyEntriesInBatchRequest',
            'Maximum number of entries per request are 10.',
          )
        const Successful: unknown[] = []
        const Failed: unknown[] = []
        for (const e of entries) {
          const body = String(e.MessageBody ?? '')
          if (!body) {
            Failed.push({
              Id: e.Id,
              SenderFault: true,
              Code: 'MissingParameter',
              Message: 'MessageBody is required',
            })
            continue
          }
          const sent = enqueue(q, body, {
            attributes: (e.MessageAttributes as FakeSqsMessage['attributes']) ?? {},
            ...(e.MessageGroupId ? { groupId: String(e.MessageGroupId) } : {}),
            ...(e.MessageDeduplicationId ? { deduplicationId: String(e.MessageDeduplicationId) } : {}),
            ...(e.DelaySeconds ? { delaySeconds: Number(e.DelaySeconds) } : {}),
          })
          if ('error' in sent)
            Failed.push({ Id: e.Id, SenderFault: true, Code: sent.error, Message: sent.message })
          else
            Successful.push({
              Id: e.Id,
              MessageId: sent.messageId,
              MD5OfMessageBody: createHash('md5').update(body).digest('hex'),
              ...(sent.sequenceNumber ? { SequenceNumber: sent.sequenceNumber } : {}),
            })
        }
        if (action === 'SendMessage') {
          const f = Failed[0] as { Code: string; Message: string } | undefined
          if (f) return jsonError(res, 400, f.Code, f.Message)
          const { Id: _, ...one } = Successful[0] as Record<string, unknown>
          return ok(one)
        }
        return ok({ Successful, Failed })
      }
      case 'ReceiveMessage': {
        const max = Math.min(Number(input.MaxNumberOfMessages ?? 1), 10)
        const visibility = Number(input.VisibilityTimeout ?? q.opts.visibilityTimeout ?? 30)
        const deadline = Date.now() + Math.min(Number(input.WaitTimeSeconds ?? 0) * secondMs, maxWaitMs)
        let got = take(q, max, visibility)
        while (!got.length && Date.now() < deadline) {
          // Woken by a send, or every 20 ms for visibility running out; gives up with the client.
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer)
              waiters.delete(done)
              resolve()
            }
            const timer = setTimeout(done, Math.min(20, Math.max(0, deadline - Date.now())))
            waiters.add(done)
          })
          if (res.destroyed || res.writableEnded) return
          got = take(q, max, visibility)
        }
        if (res.destroyed) {
          // The client went away: what was taken comes back at once, as it would after its visibility.
          for (const m of got) m.visibleAt = Date.now()
          return
        }
        return ok({ Messages: got.map(wire) })
      }
      case 'DeleteMessage': {
        // A stale handle (the message was received again since) deletes nothing, as SQS may.
        const m = byReceipt(q, input.ReceiptHandle)
        if (m) m.deleted = true
        return ok({})
      }
      case 'ChangeMessageVisibility':
      case 'ChangeMessageVisibilityBatch': {
        const entries = (
          action === 'ChangeMessageVisibility'
            ? [{ Id: 'only', ...input }]
            : (input.Entries as Record<string, unknown>[])
        ) as Record<string, unknown>[]
        const Successful: unknown[] = []
        const Failed: unknown[] = []
        for (const e of entries) {
          const m = byReceipt(q, e.ReceiptHandle)
          if (!m || m.visibleAt <= Date.now()) {
            Failed.push({
              Id: e.Id,
              SenderFault: true,
              Code: 'MessageNotInflight',
              Message: 'Message not inflight',
            })
            continue
          }
          m.visibleAt = Date.now() + Number(e.VisibilityTimeout ?? 0) * secondMs
          if (Number(e.VisibilityTimeout) === 0) wake()
          Successful.push({ Id: e.Id })
        }
        if (action === 'ChangeMessageVisibility') {
          const f = Failed[0] as { Code: string; Message: string } | undefined
          return f ? jsonError(res, 400, f.Code, f.Message) : ok({})
        }
        return ok({ Successful, Failed })
      }
      default:
        return jsonError(res, 400, 'InvalidAction', `The action ${action} is not valid for this endpoint.`)
    }
  }
  handlers.set('sqs', handler)

  return {
    createQueue(name, queueOpts = {}) {
      queues.set(name, {
        name,
        fifo: name.endsWith('.fifo'),
        opts: queueOpts,
        messages: [],
        dedup: new Map(),
        sequence: 0,
      })
      return urlOf(name)
    },
    queueUrl: urlOf,
    send(queue, body, m = {}) {
      const q = queueOf(queue)
      if (!q) throw new Error(`no queue ${queue}`)
      const sent = enqueue(q, body, {
        ...(m.attributes
          ? {
              attributes: Object.fromEntries(
                Object.entries(m.attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
              ),
            }
          : {}),
        ...(m.groupId ? { groupId: m.groupId } : {}),
        ...(m.deduplicationId ? { deduplicationId: m.deduplicationId } : {}),
        ...(m.delaySeconds ? { delaySeconds: m.delaySeconds } : {}),
      })
      if ('error' in sent) throw new Error(sent.message)
      return sent.messageId
    },
    messages(queue) {
      return queueOf(queue)?.messages ?? []
    },
    redeliver(queue, messageId) {
      const m = queueOf(queue)?.messages.find((x) => x.messageId === messageId)
      if (!m) throw new Error(`no message ${messageId}`)
      m.deleted = false
      m.visibleAt = Date.now()
      wake()
    },
  }
}
