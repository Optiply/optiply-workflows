import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

const run = promisify(execFile)
/** Versity Gateway (Apache-2.0): a real S3 server over a folder, checking SigV4 (MinIO's images are gone). */
const IMAGE = 'versity/versitygw:v1.0.13'

/** A throwaway S3-compatible store in Docker for tests (M29), as Kafka's: one root key, buckets on a tmpfs. */
export interface TestS3 {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Makes a bucket (the connector has no action for it). */
  createBucket(name: string): Promise<void>
  stop(): Promise<void>
}

/** Whether S3 tests can run here: Docker is available. CI must run them. */
export function s3Available(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    if (process.env.CI) throw new Error('S3 tests need Docker in CI')
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

export async function startTestS3(): Promise<TestS3> {
  const port = await freePort()
  const name = `ow-test-s3-${randomBytes(4).toString('hex')}`
  const accessKeyId = `AKIA${randomBytes(8).toString('hex').toUpperCase()}`
  const secretAccessKey = randomBytes(20).toString('base64url')
  const region = 'eu-west-1'
  await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:7070`,
    '-e',
    `ROOT_ACCESS_KEY=${accessKeyId}`,
    '-e',
    `ROOT_SECRET_KEY=${secretAccessKey}`,
    '-e',
    `VGW_REGION=${region}`,
    '--tmpfs',
    '/data',
    IMAGE,
    'posix',
    '/data',
  ])
  const stop = async () => {
    await run('docker', ['rm', '-f', name]).catch(() => {})
  }
  const endpoint = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      // Any HTTP answer (an unsigned request is refused with 400 or 403) means it's listening.
      const up = await fetch(endpoint).then(
        () => true,
        () => false,
      )
      if (up) break
      const state = await run('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name])
        .then((r) => r.stdout.trim())
        .catch(() => 'unknown')
      if (state.startsWith('exited') || Date.now() > deadline) {
        const logs = await run('docker', ['logs', name]).catch(() => ({ stdout: '', stderr: '' }))
        throw new Error(
          `The S3 test store didn't start (${state}):\n${`${logs.stdout}\n${logs.stderr}`.trim().slice(-2000)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  } catch (err) {
    await stop()
    throw err
  }
  async function createBucket(name: string) {
    const s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
    try {
      await s3.send(new CreateBucketCommand({ Bucket: name }))
    } finally {
      s3.destroy()
    }
  }
  return { endpoint, region, accessKeyId, secretAccessKey, createBucket, stop }
}
