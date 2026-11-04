import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kafkaConfigSchema, kafkaSettingsProblem } from '../src/kafka/config'
import { schemaRegistry, wireSchemaId } from '../src/kafka/registry'
import { type FakeRegistry, startFakeRegistry } from '../src/testing'

// The Kafka Schema Registry client (M30 step 5) against a fake of Confluent's API.
let fake: FakeRegistry
const signal = () => AbortSignal.timeout(5000)

beforeAll(async () => {
  fake = await startFakeRegistry()
})
afterAll(async () => {
  await fake.stop()
})

const ORDER = {
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'long' },
    { name: 'sku', type: 'string' },
    { name: 'note', type: ['null', 'string'], default: null },
  ],
}

describe('schema registry', () => {
  it('encodes by a subject’s latest Avro schema and decodes by the id in the frame', async () => {
    const id = fake.register('orders-value', ORDER)
    const registry = schemaRegistry(
      { url: fake.url, username: fake.username, allowPrivateNetwork: true },
      fake.password,
    )
    const framed = await registry.encode('orders-value', { id: 7, sku: 'A-1', note: null }, signal())
    expect(framed[0]).toBe(0)
    expect(wireSchemaId(framed)).toBe(id)
    expect(await registry.decode(framed, signal())).toEqual({
      value: { id: 7, sku: 'A-1', note: null },
      schemaId: id,
    })
    await expect(registry.encode('orders-value', { id: 'seven', sku: 'A-1' }, signal())).rejects.toThrow(
      /doesn't match subject orders-value's schema at id/,
    )
    await expect(registry.encode('nope', { a: 1 }, signal())).rejects.toThrow(/Subject 'nope' not found/)
    // Not framed: left alone.
    expect(await registry.decode(Buffer.from('{"plain": true}'), signal())).toBeUndefined()
    await registry.close()
  })

  it('frames JSON Schema payloads as JSON, and needs the registry’s password', async () => {
    const id = fake.register('events-value', { type: 'object' }, 'JSON')
    const registry = schemaRegistry(
      { url: fake.url, username: fake.username, allowPrivateNetwork: true },
      fake.password,
    )
    const framed = await registry.encode('events-value', { kind: 'click' }, signal())
    expect(framed.subarray(5).toString()).toBe('{"kind":"click"}')
    expect(await registry.decode(framed, signal())).toEqual({ value: { kind: 'click' }, schemaId: id })
    const anonymous = schemaRegistry({ url: fake.url, allowPrivateNetwork: true }, undefined)
    await expect(anonymous.decode(framed, signal())).rejects.toThrow(/Unauthorized/)
    // A private address without the setting is refused.
    const guarded = schemaRegistry(
      { url: fake.url, username: fake.username, allowPrivateNetwork: false },
      fake.password,
    )
    await expect(guarded.decode(framed, signal())).rejects.toThrow(/private/)
    await Promise.all([registry.close(), anonymous.close(), guarded.close()])
  })

  it('asks for the registry’s password when it has a username', () => {
    const config = kafkaConfigSchema.parse({
      brokers: ['kafka:9092'],
      schemaRegistry: { url: 'https://registry.example.com', username: 'u' },
    })
    expect(kafkaSettingsProblem(config, {})).toBe("Add the schema registry's password")
    expect(kafkaSettingsProblem(config, { schemaRegistryPassword: 'p' })).toBeNull()
    const anonymous = kafkaConfigSchema.parse({
      brokers: ['kafka:9092'],
      schemaRegistry: { url: 'https://r.example.com' },
    })
    expect(kafkaSettingsProblem(anonymous, {})).toBeNull()
  })
})
