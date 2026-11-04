import { describe, expect, it } from 'vitest'
import { bodyData } from '../src/queue-adapters/pubsub'
import { storable } from '../src/queue-consumer'

// A broker message's bytes as run data (M30): JSON or text, else base64 (Postgres's jsonb can't hold a NUL).
describe('bodyData', () => {
  it('parses JSON and keeps other text', () => {
    expect(bodyData(Buffer.from('{"a":1}'))).toEqual({ data: { a: 1 }, binary: false })
    expect(bodyData(Buffer.from('hello é'))).toEqual({ data: 'hello é', binary: false })
    expect(bodyData(Buffer.from(''))).toEqual({ data: '', binary: false })
  })

  it('gives bytes that aren’t text as base64: a NUL, or not UTF-8', () => {
    const framed = Buffer.from([0, 0, 0, 0, 7, 2, 4])
    expect(bodyData(framed)).toEqual({ data: framed.toString('base64'), binary: true })
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    expect(bodyData(latin1)).toEqual({ data: latin1.toString('base64'), binary: true })
  })

  it('keeps JSON whose escapes parse to a NUL as its text', () => {
    const text = '{"a":"x\\u0000y"}'
    expect(bodyData(Buffer.from(text))).toEqual({ data: text, binary: false })
  })

  it('storable: a NUL anywhere in a run’s input becomes U+FFFD; escaped text stays', () => {
    expect(storable({ headers: { a: 'x\u0000y' }, n: 1 })).toEqual({ headers: { a: 'x\ufffdy' }, n: 1 })
    // The six characters \u0000 (text, not a NUL) are left alone.
    expect(storable({ s: '\\u0000' })).toEqual({ s: '\\u0000' })
    expect(storable({ s: '\\\u0000' })).toEqual({ s: '\\\ufffd' })
  })
})
