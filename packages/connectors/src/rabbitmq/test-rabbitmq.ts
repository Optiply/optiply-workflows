import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import amqp from 'amqplib'

const run = promisify(execFile)
const IMAGE = 'rabbitmq:4.1.4-alpine'

/** A throwaway RabbitMQ in Docker for tests (M30), as Kafka's: one user, the default vhost. */
export interface TestRabbit {
  host: string
  port: number
  username: string
  password: string
  /** Declares queues (durable), optionally with a dead-letter exchange routing to another queue. */
  declare(queue: string, opts?: { deadLetterQueue?: string }): Promise<void>
  /** Messages waiting in a queue, read and acknowledged (so they are gone). */
  drain(
    queue: string,
  ): Promise<{ body: string; headers: Record<string, unknown>; messageId?: string; redelivered: boolean }[]>
  /** Publishes straight to a queue (for consumer tests). */
  send(
    queue: string,
    body: string,
    opts?: { messageId?: string; headers?: Record<string, unknown> },
  ): Promise<void>
  stop(): Promise<void>
}

export function rabbitAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('RabbitMQ tests need Docker in CI')
    return false
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

export async function startTestRabbit(): Promise<TestRabbit> {
  const port = await freePort()
  const name = `ow-test-rabbit-${randomBytes(4).toString('hex')}`
  const username = 'workflows'
  const password = randomBytes(12).toString('hex')
  await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:5672`,
    '-e',
    `RABBITMQ_DEFAULT_USER=${username}`,
    '-e',
    `RABBITMQ_DEFAULT_PASS=${password}`,
    IMAGE,
  ])
  const stop = async () => {
    await run('docker', ['rm', '-f', name]).catch(() => {})
  }
  const url = `amqp://${username}:${password}@127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 90_000
    for (;;) {
      // Ready when it takes a sign-in (the port opens before the broker is up).
      const ok = await amqp.connect(url, { timeout: 2_000 }).then(
        async (c) => {
          await c.close()
          return true
        },
        () => false,
      )
      if (ok) break
      const state = await run('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name])
        .then((r) => r.stdout.trim())
        .catch(() => 'unknown')
      if (state.startsWith('exited') || Date.now() > deadline) {
        const logs = await run('docker', ['logs', name]).catch(() => ({ stdout: '', stderr: '' }))
        throw new Error(
          `RabbitMQ didn't start (${state}):\n${`${logs.stdout}\n${logs.stderr}`.trim().slice(-2000)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch (err) {
    await stop()
    throw err
  }
  const withChannel = async <T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> => {
    const c = await amqp.connect(url)
    try {
      const ch = await c.createChannel()
      return await fn(ch)
    } finally {
      await c.close()
    }
  }
  return {
    host: '127.0.0.1',
    port,
    username,
    password,
    declare: (queue, opts = {}) =>
      withChannel(async (ch) => {
        if (opts.deadLetterQueue) {
          await ch.assertExchange('ow-dlx', 'direct', { durable: true })
          await ch.assertQueue(opts.deadLetterQueue, { durable: true })
          await ch.bindQueue(opts.deadLetterQueue, 'ow-dlx', opts.deadLetterQueue)
        }
        await ch.assertQueue(queue, {
          durable: true,
          ...(opts.deadLetterQueue && {
            deadLetterExchange: 'ow-dlx',
            deadLetterRoutingKey: opts.deadLetterQueue,
          }),
        })
      }),
    drain: (queue) =>
      withChannel(async (ch) => {
        const out: {
          body: string
          headers: Record<string, unknown>
          messageId?: string
          redelivered: boolean
        }[] = []
        for (;;) {
          const m = await ch.get(queue)
          if (!m) return out
          ch.ack(m)
          out.push({
            body: m.content.toString(),
            headers: (m.properties.headers ?? {}) as Record<string, unknown>,
            ...(m.properties.messageId && { messageId: String(m.properties.messageId) }),
            redelivered: m.fields.redelivered,
          })
        }
      }),
    send: async (queue, body, opts = {}) => {
      // A confirm channel, waited on: closing the connection right after a plain send can lose the message.
      const c = await amqp.connect(url)
      try {
        const ch = await c.createConfirmChannel()
        ch.sendToQueue(queue, Buffer.from(body), {
          persistent: true,
          ...(opts.messageId && { messageId: opts.messageId }),
          ...(opts.headers && { headers: opts.headers }),
        })
        await ch.waitForConfirms()
      } finally {
        await c.close()
      }
    },
    stop,
  }
}
