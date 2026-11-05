import { MAX_PAYLOAD_BYTES } from '@ow/db'
import { BlockFailure } from './errors'

/** Block data is plain JSON (dates become strings), so a resumed run reads exactly what a fresh one did. */
export function toJsonData(value: unknown): { data: unknown; sizeBytes: number } {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (err) {
    throw new BlockFailure('serialization', `The result isn't JSON-serializable: ${(err as Error).message}`)
  }
  if (text === undefined) return { data: null, sizeBytes: 4 }
  const sizeBytes = Buffer.byteLength(text)
  if (sizeBytes > MAX_PAYLOAD_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    const max = MAX_PAYLOAD_BYTES / 1024 / 1024
    throw new BlockFailure('too_large', `The result is ${mb} MB; blocks can return at most ${max} MB`)
  }
  return { data: JSON.parse(text), sizeBytes }
}
