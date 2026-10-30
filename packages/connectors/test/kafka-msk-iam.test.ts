import { generateAuthTokenFromCredentialsProvider } from 'aws-msk-iam-sasl-signer-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureAws } from '../src/aws/credentials'
import { type FakeAws, startFakeAws } from '../src/aws/fake'
import { kafkaResourceClient } from '../src/kafka/connector'
import { mskIamToken } from '../src/kafka/msk-iam'

// MSK IAM (M26 step 3b): the OAUTHBEARER token is a SigV4-presigned URL. Checked against AWS's own signer library
// (a dev dependency): signed at the same moment with the same credentials, the URLs match but for the User-Agent.
const key = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const decode = (token: string) => new URL(Buffer.from(token, 'base64url').toString('utf8'))
const params = (url: URL) => Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'User-Agent'))

describe('mskIamToken', () => {
  it("matches AWS's signer: the same presigned kafka-cluster:Connect URL, base64url, expiring with it", async () => {
    const theirs = await generateAuthTokenFromCredentialsProvider({
      region: 'eu-west-1',
      awsCredentialsProvider: async () => key,
    })
    const theirUrl = decode(theirs.token)
    const date = theirUrl.searchParams.get('X-Amz-Date')!
    const signedAt = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    )
    const ours = await mskIamToken('eu-west-1', async () => key, signedAt)
    const ourUrl = decode(ours.tokenValue)
    expect(ourUrl.origin + ourUrl.pathname).toBe('https://kafka.eu-west-1.amazonaws.com/')
    expect(params(ourUrl)).toEqual(params(theirUrl))
    expect(params(ourUrl)).toMatchObject({
      Action: 'kafka-cluster:Connect',
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': expect.stringMatching(
        /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/kafka-cluster\/aws4_request$/,
      ),
      'X-Amz-Expires': '900',
      'X-Amz-SignedHeaders': 'host',
    })
    expect(ourUrl.searchParams.get('User-Agent')).toBe('optiply-workflows')
    expect(ours.tokenValue).not.toContain('=')
    expect(ours.lifetime).toBe(theirs.expiryTime)
    expect(ours.lifetime).toBe(signedAt.getTime() + 900_000)
  })

  it("carries a session's token and expires with credentials that end sooner", async () => {
    const now = new Date('2026-10-30T09:00:00Z')
    const session = {
      ...key,
      sessionToken: 'session-token',
      expiration: new Date(now.getTime() + 300_000),
    }
    const token = await mskIamToken('us-east-1', async () => session, now)
    const url = decode(token.tokenValue)
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(token.lifetime).toBe(now.getTime() + 300_000)
  })

  it('expires in whole seconds, at least one, however the credentials end (review fix)', async () => {
    const now = new Date('2026-10-30T09:00:00Z')
    const soon = { ...key, expiration: new Date(now.getTime() + 812_347) }
    expect(
      decode((await mskIamToken('us-east-1', async () => soon, now)).tokenValue).searchParams.get(
        'X-Amz-Expires',
      ),
    ).toBe('812')
    const gone = { ...key, expiration: new Date(now.getTime() - 5_000) }
    expect(
      decode((await mskIamToken('us-east-1', async () => gone, now)).tokenValue).searchParams.get(
        'X-Amz-Expires',
      ),
    ).toBe('1')
  })
})

describe('a Kafka resource on MSK IAM', () => {
  let aws: FakeAws
  beforeAll(async () => {
    aws = await startFakeAws()
    configureAws({ stsEndpoint: aws.url })
  })
  afterAll(async () => {
    configureAws({})
    await aws.close()
  })

  it('signs in with OAUTHBEARER over TLS, its tokens from the AWS identity, and names that identity', async () => {
    const user = aws.addUser('msk')
    const client = kafkaResourceClient(
      {
        brokers: ['b-1.msk.example:9098'],
        auth: 'aws-msk-iam',
        tls: false,
        identity: 'key',
        region: 'eu-west-1',
        accessKeyId: user.accessKeyId,
      },
      { secretAccessKey: user.secretAccessKey },
    )
    try {
      expect(client.settings).toMatchObject({
        'security.protocol': 'sasl_ssl',
        'sasl.mechanisms': 'OAUTHBEARER',
      })
      const refresh = client.settings.oauthbearer_token_refresh_cb as () => Promise<{ tokenValue: string }>
      const url = decode((await refresh()).tokenValue)
      expect(url.searchParams.get('X-Amz-Credential')).toContain(`${user.accessKeyId}/`)
      expect(await client.who(AbortSignal.timeout(5000))).toBe(`${user.arn} (MSK IAM)`)
    } finally {
      await client.close()
    }
  })

  it('asks for the region first', () => {
    expect(() =>
      kafkaResourceClient({ brokers: ['b:9098'], auth: 'aws-msk-iam', tls: false, identity: 'key' }, {}),
    ).toThrow("Add the cluster's AWS region")
  })
})
