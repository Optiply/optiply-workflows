import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { awsSettingsProblem, configureAwsServer } from '../src/services/aws'
import { serverIdentityTarget } from '../src/services/resources'

// M26 step 2a: the server's own AWS credentials, opted into by the instance; what only admins may choose.
const base = {
  DATABASE_URL: 'postgres://localhost/x',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
  ENCRYPTION_KEYS: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
}

describe('AWS_SERVER_IDENTITY (M26)', () => {
  it('is off unless set to allow', () => {
    expect(loadConfig(base).AWS_SERVER_IDENTITY).toBe('deny')
    expect(loadConfig({ ...base, AWS_SERVER_IDENTITY: 'allow' }).AWS_SERVER_IDENTITY).toBe('allow')
    expect(() => loadConfig({ ...base, AWS_SERVER_IDENTITY: 'yes' })).toThrow(/AWS_SERVER_IDENTITY/)
  })
})

describe('the AWS identity on save', () => {
  afterAll(() => configureAwsServer({ AWS_SERVER_IDENTITY: 'deny' }))

  it("names what an access key lacks, and the server's credentials where the instance doesn't allow them", () => {
    configureAwsServer({ AWS_SERVER_IDENTITY: 'deny' })
    expect(awsSettingsProblem({ identity: 'key' }, {})).toBe('Add the access key id')
    expect(awsSettingsProblem({ identity: 'key', accessKeyId: 'AKIAEXAMPLE12345' }, {})).toBe(
      'Add the secret access key',
    )
    expect(
      awsSettingsProblem({ identity: 'key', accessKeyId: 'AKIAEXAMPLE12345' }, { secretAccessKey: 's' }),
    ).toBe(null)
    expect(awsSettingsProblem({ identity: 'server' }, {})).toMatch(/doesn't let resources use its own AWS/)
    configureAwsServer({ AWS_SERVER_IDENTITY: 'allow' })
    expect(awsSettingsProblem({ identity: 'server' }, {})).toBe(null)
  })
})

describe('serverIdentityTarget for AWS', () => {
  beforeAll(() => configureAwsServer({ AWS_SERVER_IDENTITY: 'deny' }))

  it("is the region and role of an SQS resource or Kafka's MSK IAM on the server's credentials", () => {
    expect(serverIdentityTarget({ identity: 'key', region: 'eu-west-1' }, 'sqs')).toBe(null)
    expect(serverIdentityTarget({ identity: 'server', region: 'eu-west-1' }, 'sqs')).toBe('aws:eu-west-1:')
    const role = 'arn:aws:iam::123456789012:role/reader'
    expect(serverIdentityTarget({ identity: 'server', region: 'eu-west-1', roleArn: role }, 'sqs')).toBe(
      `aws:eu-west-1:${role}`,
    )
    // MSK IAM's brokers too: its signed token goes to them (review fix).
    expect(
      serverIdentityTarget(
        { auth: 'aws-msk-iam', identity: 'server', region: 'us-east-1', brokers: ['b-2:9098', 'b-1:9098'] },
        'kafka',
      ),
    ).toBe('aws:us-east-1::b-1:9098,b-2:9098')
    // Only MSK IAM signs with AWS: a leftover identity under another auth mode doesn't count.
    expect(serverIdentityTarget({ auth: 'plain', identity: 'server', region: 'us-east-1' }, 'kafka')).toBe(
      null,
    )
  })
})
