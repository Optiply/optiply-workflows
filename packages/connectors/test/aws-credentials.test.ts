import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { awsCredentials, awsError, configureAws, describeAws } from '../src/aws/credentials'
import { type FakeAws, startFakeAws } from '../src/aws/fake'
import { ConnectorError } from '../src/types'

// The AWS identity (M26 step 2a) against the fake STS, which checks every signature.
let aws: FakeAws
const signal = () => AbortSignal.timeout(5_000)
const region = 'eu-west-1'

beforeAll(async () => {
  aws = await startFakeAws()
  configureAws({ stsEndpoint: aws.url })
})
afterEach(() => configureAws({ stsEndpoint: aws.url }))
afterAll(async () => {
  configureAws({})
  await aws.close()
})

const failure = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ConnectorError)
  return err as ConnectorError
}

describe('the AWS identity', () => {
  it('signs with an access key: STS names its user', async () => {
    const user = aws.addUser('workflows')
    const credentials = awsCredentials({ region, identity: 'key', ...user })
    expect(await describeAws(region, credentials, signal())).toBe(user.arn)
    expect(aws.calls.at(-1)).toEqual({ service: 'sts', action: 'GetCallerIdentity', arn: user.arn })
  })

  it("refuses a wrong secret as a connection error naming AWS's reason", async () => {
    const user = aws.addUser('typo')
    const credentials = awsCredentials({ region, identity: 'key', ...user, secretAccessKey: 'not-it' })
    const err = await failure(describeAws(region, credentials, signal()))
    expect(err.code).toBe('connection')
    expect(err.message).toContain('SignatureDoesNotMatch')
    expect(err.message).not.toContain('not-it')
  })

  it('assumes a role with the key, its external id included, and signs as the session', async () => {
    const user = aws.addUser('assumer')
    const role = aws.addRole('reader', { trusted: [user.arn], externalId: 'optiply-42' })
    const credentials = awsCredentials({
      region,
      identity: 'key',
      ...user,
      roleArn: role.arn,
      externalId: 'optiply-42',
    })
    expect(await describeAws(region, credentials, signal())).toBe(
      `arn:aws:sts::${aws.account}:assumed-role/reader/optiply-workflows`,
    )
    expect(aws.calls.slice(-2).map((c) => c.action)).toEqual(['AssumeRole', 'GetCallerIdentity'])

    const wrong = awsCredentials({ region, identity: 'key', ...user, roleArn: role.arn, externalId: 'guess' })
    const err = await failure(describeAws(region, wrong, signal()))
    expect(err.code).toBe('connection')
    expect(err.message).toContain('AccessDenied')
  })

  it("uses the server's own credentials only where the instance gives them", async () => {
    expect(() => awsCredentials({ region, identity: 'server' })).toThrow(
      /doesn't let resources use its own AWS/,
    )
    const server = aws.addUser('server')
    configureAws({ stsEndpoint: aws.url, serverCredentials: async () => server })
    expect(await describeAws(region, awsCredentials({ region, identity: 'server' }), signal())).toBe(
      server.arn,
    )
    // And a role assumed with them.
    const role = aws.addRole('cross-account')
    const assumed = awsCredentials({ region, identity: 'server', roleArn: role.arn })
    expect(await describeAws(region, assumed, signal())).toContain('assumed-role/cross-account/')
  })

  it('asks for the key it lacks', () => {
    expect(() => awsCredentials({ region, identity: 'key' })).toThrow(/access key id/)
    expect(() => awsCredentials({ region, identity: 'key', accessKeyId: 'AKIAEXAMPLE12345' })).toThrow(
      /secret access key/,
    )
  })

  it('maps SDK errors: throttling is retryable, a 5xx too', () => {
    const throttled = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
      $retryable: { throttling: true },
    })
    expect(awsError(throttled, 'receive')).toMatchObject({ code: 'query', details: { retryable: true } })
    const down = Object.assign(new Error('Internal'), { name: 'InternalError', $fault: 'server' })
    expect(awsError(down, 'receive').details).toMatchObject({ retryable: true })
    expect(awsError(Object.assign(new Error('x'), { name: 'AbortError' }), 'receive').code).toBe('aborted')
  })
})
