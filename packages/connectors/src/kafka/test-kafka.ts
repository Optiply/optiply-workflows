import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const IMAGE = 'apache/kafka:4.1.0'
const FIXTURES = new URL('../../test/fixtures/kafka/', import.meta.url)

/**
 * A throwaway Kafka 4.1 broker in Docker for tests (M26), as MySQL's are: one KRaft node with a listener per way of
 * signing in, on host ports of its own. Its CA and client certificate are fixtures (`test/fixtures/kafka`).
 */
export interface TestKafka {
  /** `127.0.0.1:port` of each listener (the server certificate names that IP and localhost). */
  plaintext: string
  /**
   * SASL over TLS: PLAIN for `plain`, SCRAM-SHA-256 for `scram256`, SCRAM-SHA-512 for `scram512`, and OAUTHBEARER
   * with any unsigned JWT.
   */
  saslSsl: string
  /** TLS with client certificates required. */
  mtls: string
  users: Record<'plain' | 'scram256' | 'scram512', { username: string; password: string }>
  ca: string
  clientCertificate: string
  clientKey: string
  /** Topics made with `partitions` (default 1), through the broker's own tool. */
  createTopic(name: string, partitions?: number): Promise<void>
  stop(): Promise<void>
}

/** Whether Kafka tests can run here: Docker is available. CI must run them. */
export function kafkaAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('Kafka tests need Docker in CI')
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

export async function startTestKafka(): Promise<TestKafka> {
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()]
  const dir = mkdtempSync(join(tmpdir(), 'ow-kafka-'))
  for (const file of ['ca.pem', 'server-keystore.pem']) {
    copyFileSync(new URL(file, FIXTURES), join(dir, file))
    chmodSync(join(dir, file), 0o644)
  }
  const users = {
    plain: { username: 'alice', password: `plain-${randomBytes(6).toString('hex')}` },
    scram256: { username: 'bob', password: `scram256-${randomBytes(6).toString('hex')}` },
    scram512: { username: 'carol', password: `scram512-${randomBytes(6).toString('hex')}` },
  }
  writeFileSync(
    join(dir, 'server.properties'),
    [
      'process.roles=broker,controller',
      'node.id=1',
      'controller.quorum.voters=1@localhost:9093',
      `listeners=PLAINTEXT://:${p1},SASL_SSL://:${p2},SSL://:${p3},CONTROLLER://:9093,INTERNAL://:9094`,
      `advertised.listeners=PLAINTEXT://127.0.0.1:${p1},SASL_SSL://127.0.0.1:${p2},SSL://127.0.0.1:${p3},INTERNAL://localhost:9094`,
      'listener.security.protocol.map=PLAINTEXT:PLAINTEXT,SASL_SSL:SASL_SSL,SSL:SSL,CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT',
      'inter.broker.listener.name=INTERNAL',
      'controller.listener.names=CONTROLLER',
      'sasl.enabled.mechanisms=PLAIN,SCRAM-SHA-256,SCRAM-SHA-512,OAUTHBEARER',
      // Kafka's own unsecured validator: any unsigned JWT, so a test can check a token callback is called.
      'listener.name.sasl_ssl.oauthbearer.sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;',
      `listener.name.sasl_ssl.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required user_${users.plain.username}="${users.plain.password}";`,
      'listener.name.sasl_ssl.scram-sha-256.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;',
      'listener.name.sasl_ssl.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;',
      'ssl.keystore.type=PEM',
      'ssl.keystore.location=/cfg/server-keystore.pem',
      'ssl.truststore.type=PEM',
      'ssl.truststore.location=/cfg/ca.pem',
      'listener.name.ssl.ssl.client.auth=required',
      'offsets.topic.replication.factor=1',
      'transaction.state.log.replication.factor=1',
      'transaction.state.log.min.isr=1',
      'group.initial.rebalance.delay.ms=0',
      'log.dirs=/tmp/kraft-logs',
      'num.partitions=1',
    ].join('\n'),
  )
  chmodSync(join(dir, 'server.properties'), 0o644)
  const name = `ow-test-kafka-${randomBytes(4).toString('hex')}`
  const scram = `--add-scram 'SCRAM-SHA-256=[name=${users.scram256.username},password=${users.scram256.password}]' --add-scram 'SCRAM-SHA-512=[name=${users.scram512.username},password=${users.scram512.password}]'`
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    ...[p1, p2, p3].flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
    '-v',
    `${dir}:/cfg:ro`,
    '--entrypoint',
    '/bin/sh',
    IMAGE,
    '-c',
    `/opt/kafka/bin/kafka-storage.sh format -t "$(/opt/kafka/bin/kafka-storage.sh random-uuid)" -c /cfg/server.properties ${scram} >/dev/null && exec /opt/kafka/bin/kafka-server-start.sh /cfg/server.properties`,
  ])
  const stop = async () => {
    await run('docker', ['rm', '-f', name]).catch(() => {})
  }
  try {
    const deadline = Date.now() + 90_000
    for (;;) {
      const { stdout } = await run('docker', ['logs', name]).catch(() => ({ stdout: '' }))
      if (/Kafka Server started/.test(stdout)) break
      if (Date.now() > deadline) throw new Error(`Kafka didn't start in 90 s:\n${stdout.slice(-2000)}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch (err) {
    await stop()
    throw err
  }
  return {
    plaintext: `127.0.0.1:${p1}`,
    saslSsl: `127.0.0.1:${p2}`,
    mtls: `127.0.0.1:${p3}`,
    users,
    ca: readFileSync(new URL('ca.pem', FIXTURES), 'utf8'),
    clientCertificate: readFileSync(new URL('client.pem', FIXTURES), 'utf8'),
    clientKey: readFileSync(new URL('client-key.pem', FIXTURES), 'utf8'),
    async createTopic(topic, partitions = 1) {
      await run('docker', [
        'exec',
        name,
        '/opt/kafka/bin/kafka-topics.sh',
        '--bootstrap-server',
        'localhost:9094',
        '--create',
        '--if-not-exists',
        '--topic',
        topic,
        '--partitions',
        String(partitions),
      ])
    },
    stop,
  }
}
